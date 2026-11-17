import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import {
  APPOINTMENT_FULL_INCLUDE,
  bookOutpatientAppointment,
  formatAppointmentDto,
  getLiveCurrentSttMap
} from '../services/appointment.service';
import {
  formatMedicalRecordDto,
  MEDICAL_RECORD_INCLUDE,
  publishExistingMedicalRecord,
  saveMedicalRecord
} from '../services/record.service';
import { AppointmentStatus, SessionType } from '../types';
import { checkMedicineAllergies } from '../utils/allergy';
import {
  addDays,
  formatDateOnly,
  getSessionBounds,
  getTodayDateString,
  toDateOnly
} from '../utils/date';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { sendSuccess } from '../utils/response';

const router = Router();

router.use(authenticate, requireRole('DOCTOR'));

async function getDoctorByUserId(userId: string) {
  const doctor = await prisma.doctor.findUnique({
    where: { userId },
    include: { user: true, department: true, room: true }
  });
  if (!doctor) throw notFound('Không tìm thấy hồ sơ bác sĩ');
  return doctor;
}

const callNextSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  session: z.enum(['MORNING', 'AFTERNOON']),
  completeCurrent: z.boolean().optional()
});

const statusUpdateSchema = z.object({
  status: z.enum(['IN_PROGRESS', 'COMPLETED', 'NO_SHOW']).optional(),
  action: z.enum(['START', 'COMPLETE', 'NO_SHOW', 'CALL_NEXT']).optional()
});

const allergyCheckSchema = z.object({
  patientId: z.string().min(1),
  medicineIds: z.array(z.string().min(1))
});

const saveRecordSchema = z.object({
  appointmentId: z.string().min(1).optional(),
  symptoms: z.string().optional(),
  diagnosis: z.string().min(1, 'Vui lòng nhập chẩn đoán'),
  icdCode: z.string().optional(),
  clinicalNotes: z.string().optional(),
  treatmentPlan: z.string().optional(),
  specialtyResults: z
    .object({
      examFindings: z.string().optional(),
      imagingNotes: z.string().optional(),
      labOrders: z
        .array(
          z.object({
            serviceId: z.string().optional(),
            testName: z.string(),
            category: z.string().optional(),
            status: z.enum(['ORDERED', 'COMPLETED']).default('ORDERED'),
            result: z.string().optional(),
            normalRange: z.string().optional(),
            unit: z.string().optional(),
            notes: z.string().optional()
          })
        )
        .optional()
    })
    .optional(),
  orderedServiceIds: z.array(z.string()).optional(),
  prescription: z
    .object({
      notes: z.string().optional(),
      items: z.array(
        z.object({
          medicineId: z.string().min(1),
          quantity: z.number().int().positive('Số lượng thuốc phải lớn hơn 0'),
          dosage: z.string().min(1, 'Vui lòng nhập liều dùng'),
          frequency: z.string().optional(),
          durationDays: z.number().int().positive().optional(),
          instructions: z.string().optional()
        })
      )
    })
    .optional(),
  publish: z.boolean().optional()
});

const followUpSchema = z.object({
  patientId: z.string().min(1, 'Thiếu thông tin bệnh nhân'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày tái khám phải theo định dạng YYYY-MM-DD'),
  session: z.enum(['MORNING', 'AFTERNOON']),
  doctorId: z.string().optional(),
  chiefComplaint: z.string().optional()
});

const upsertScheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  session: z.enum(['MORNING', 'AFTERNOON']),
  maxPatients: z.number().int().min(1).max(100).optional(),
  avgMinutesPerPatient: z.number().int().min(5).max(60).optional(),
  isAvailable: z.boolean().optional(),
  notes: z.string().nullable().optional()
});

const patchScheduleSchema = z.object({
  isAvailable: z.boolean().optional(),
  maxPatients: z.number().int().min(1).max(100).optional(),
  avgMinutesPerPatient: z.number().int().min(5).max(60).optional(),
  notes: z.string().nullable().optional()
});

router.get(
  '/queue',
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const dateStr =
      typeof req.query.date === 'string' && req.query.date
        ? req.query.date
        : getTodayDateString();
    const targetDate = toDateOnly(dateStr);
    const sessionFilter =
      req.query.session === 'MORNING' || req.query.session === 'AFTERNOON'
        ? (req.query.session as SessionType)
        : undefined;

    const [schedules, appointments] = await Promise.all([
      prisma.doctorSchedule.findMany({
        where: {
          doctorId: doctor.id,
          scheduleDate: targetDate,
          ...(sessionFilter ? { session: sessionFilter } : {})
        }
      }),
      prisma.appointment.findMany({
        where: {
          doctorId: doctor.id,
          appointmentDate: targetDate,
          ...(sessionFilter ? { session: sessionFilter } : {})
        },
        include: APPOINTMENT_FULL_INCLUDE,
        orderBy: [{ session: 'asc' }, { queueNumber: 'asc' }]
      })
    ]);

    const sttMap = await getLiveCurrentSttMap(appointments);

    const buildSessionBucket = (session: SessionType) => {
      const sched = schedules.find((s) => s.session === session) || null;
      const list = appointments
        .filter((a) => a.session === session)
        .map((a) => {
          const key = `${a.doctorId}|${formatDateOnly(a.appointmentDate)}|${a.session}`;
          return formatAppointmentDto(a, sttMap.get(key) ?? null);
        });

      const activeList = list.filter((a) => a.status !== 'CANCELLED');
      const currentServing = list.find((a) => a.status === 'IN_PROGRESS') || null;
      const waitingCandidates = list
        .filter((a) => a.status === 'CHECKED_IN' || a.status === 'BOOKED')
        .sort((a, b) => {
          // Checked-in first, then priority, then STT
          const aChecked = a.status === 'CHECKED_IN' ? 0 : 1;
          const bChecked = b.status === 'CHECKED_IN' ? 0 : 1;
          if (aChecked !== bChecked) return aChecked - bChecked;
          if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
          return a.queueNumber - b.queueNumber;
        });

      return {
        schedule: sched
          ? {
              id: sched.id,
              doctorId: sched.doctorId,
              scheduleDate: formatDateOnly(sched.scheduleDate),
              session: sched.session,
              startTime: sched.startTime,
              endTime: sched.endTime,
              maxPatients: sched.maxPatients,
              avgMinutesPerPatient: sched.avgMinutesPerPatient,
              lastQueueNumber: sched.lastQueueNumber,
              bookedCount: activeList.length,
              isAvailable: sched.isAvailable,
              notes: sched.notes
            }
          : null,
        currentServing,
        nextWaiting: waitingCandidates[0] || null,
        stats: {
          total: activeList.length,
          waiting: list.filter((a) => ['BOOKED', 'CHECKED_IN'].includes(a.status)).length,
          inProgress: list.filter((a) => a.status === 'IN_PROGRESS').length,
          completed: list.filter((a) => a.status === 'COMPLETED').length
        },
        appointments: list
      };
    };

    return sendSuccess(res, {
      date: dateStr,
      morning: buildSessionBucket('MORNING'),
      afternoon: buildSessionBucket('AFTERNOON')
    });
  })
);

router.post(
  '/queue/call-next',
  validateBody(callNextSchema),
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const dateStr = req.body.date || getTodayDateString();
    const targetDate = toDateOnly(dateStr);
    const session = req.body.session as SessionType;

    const updated = await prisma.$transaction(async (tx) => {
      const currentInProgress = await tx.appointment.findFirst({
        where: {
          doctorId: doctor.id,
          appointmentDate: targetDate,
          session,
          status: 'IN_PROGRESS'
        }
      });

      if (currentInProgress) {
        if (req.body.completeCurrent) {
          await tx.appointment.update({
            where: { id: currentInProgress.id },
            data: { status: 'COMPLETED', completedAt: new Date() }
          });
        } else {
          throw conflict(
            `Đang khám bệnh nhân STT #${currentInProgress.queueNumber}. Vui lòng hoàn tất trước khi gọi số tiếp theo.`
          );
        }
      }

      const candidates = await tx.appointment.findMany({
        where: {
          doctorId: doctor.id,
          appointmentDate: targetDate,
          session,
          status: { in: ['CHECKED_IN', 'BOOKED'] }
        },
        include: { patient: true },
        orderBy: [{ queueNumber: 'asc' }]
      });

      if (candidates.length === 0) {
        throw notFound('Không còn bệnh nhân nào đang chờ trong buổi khám này');
      }

      candidates.sort((a, b) => {
        const aChecked = a.status === 'CHECKED_IN' ? 0 : 1;
        const bChecked = b.status === 'CHECKED_IN' ? 0 : 1;
        if (aChecked !== bChecked) return aChecked - bChecked;
        if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
        return a.queueNumber - b.queueNumber;
      });

      const nextAppt = candidates[0];
      const now = new Date();

      const saved = await tx.appointment.update({
        where: { id: nextAppt.id },
        data: {
          status: 'IN_PROGRESS',
          startedAt: now,
          checkedInAt: nextAppt.checkedInAt || now
        },
        include: APPOINTMENT_FULL_INCLUDE
      });

      await tx.notification.create({
        data: {
          userId: nextAppt.patient.userId,
          title: `Mời vào phòng khám • STT #${String(saved.queueNumber).padStart(2, '0')}`,
          message: `Bác sĩ ${doctor.user.fullName} đang gọi số thứ tự #${String(
            saved.queueNumber
          ).padStart(2, '0')}. Vui lòng vào ${doctor.room?.name || 'phòng khám'}.`,
          type: 'QUEUE_CALL',
          payload: {
            appointmentId: saved.id,
            queueNumber: saved.queueNumber,
            roomName: doctor.room?.name || null
          }
        }
      });

      return saved;
    });

    return sendSuccess(res, formatAppointmentDto(updated, updated.queueNumber));
  })
);

router.patch(
  '/appointments/:id/status',
  validateBody(statusUpdateSchema),
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const appt = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: { patient: true }
    });
    if (!appt) throw notFound('Không tìm thấy lịch hẹn');
    if (appt.doctorId !== doctor.id) {
      throw forbidden('Bạn không có quyền cập nhật lịch hẹn của bác sĩ khác');
    }

    const actionOrStatus = req.body.action || req.body.status;
    if (!actionOrStatus) {
      throw badRequest('Thiếu trạng thái hoặc hành động cần cập nhật');
    }

    let nextStatus: AppointmentStatus;
    if (actionOrStatus === 'START' || actionOrStatus === 'CALL_NEXT' || actionOrStatus === 'IN_PROGRESS') {
      nextStatus = 'IN_PROGRESS';
    } else if (actionOrStatus === 'COMPLETE' || actionOrStatus === 'COMPLETED') {
      nextStatus = 'COMPLETED';
    } else {
      nextStatus = 'NO_SHOW';
    }

    if (appt.status === 'CANCELLED') {
      throw conflict('Không thể cập nhật trạng thái lịch hẹn đã hủy');
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.appointment.update({
        where: { id: appt.id },
        data: {
          status: nextStatus,
          ...(nextStatus === 'IN_PROGRESS'
            ? { startedAt: appt.startedAt || now, checkedInAt: appt.checkedInAt || now }
            : {}),
          ...(nextStatus === 'COMPLETED' ? { completedAt: appt.completedAt || now } : {})
        },
        include: APPOINTMENT_FULL_INCLUDE
      });

      if (nextStatus === 'IN_PROGRESS') {
        await tx.notification.create({
          data: {
            userId: appt.patient.userId,
            title: `Mời vào phòng khám • STT #${String(saved.queueNumber).padStart(2, '0')}`,
            message: `Bác sĩ ${doctor.user.fullName} mời bạn vào ${
              doctor.room?.name || 'phòng khám'
            }.`,
            type: 'QUEUE_CALL',
            payload: { appointmentId: saved.id, queueNumber: saved.queueNumber }
          }
        });
      }

      return saved;
    });

    const sttMap = await getLiveCurrentSttMap([updated]);
    const key = `${updated.doctorId}|${formatDateOnly(updated.appointmentDate)}|${updated.session}`;
    return sendSuccess(res, formatAppointmentDto(updated, sttMap.get(key) ?? null));
  })
);

router.get(
  '/patients/:id',
  asyncHandler(async (req, res) => {
    const patient = await prisma.patient.findUnique({
      where: { id: req.params.id },
      include: { user: true }
    });
    if (!patient) throw notFound('Không tìm thấy bệnh nhân');

    const [appointments, medicalRecords] = await Promise.all([
      prisma.appointment.findMany({
        where: { patientId: patient.id },
        include: APPOINTMENT_FULL_INCLUDE,
        orderBy: [{ appointmentDate: 'desc' }, { createdAt: 'desc' }],
        take: 25
      }),
      prisma.medicalRecord.findMany({
        where: { patientId: patient.id },
        include: MEDICAL_RECORD_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 25
      })
    ]);

    const formattedRecords = medicalRecords.map(formatMedicalRecordDto);

    return sendSuccess(res, {
      patient: {
        id: patient.id,
        userId: patient.userId,
        patientCode: patient.patientCode,
        fullName: patient.user.fullName,
        email: patient.user.email,
        phone: patient.user.phone,
        dateOfBirth: patient.dateOfBirth ? formatDateOnly(patient.dateOfBirth) : null,
        gender: patient.gender,
        address: patient.address,
        nationalId: patient.nationalId,
        insuranceNumber: patient.insuranceNumber,
        bloodType: patient.bloodType,
        allergies: Array.isArray(patient.allergies) ? patient.allergies : [],
        chronicConditions: Array.isArray(patient.chronicConditions) ? patient.chronicConditions : [],
        emergencyContact: patient.emergencyContact || null
      },
      appointments: appointments.map((a) => formatAppointmentDto(a, null)),
      medicalRecords: formattedRecords,
      records: formattedRecords
    });
  })
);

router.post(
  '/prescriptions/check-allergies',
  validateBody(allergyCheckSchema),
  asyncHandler(async (req, res) => {
    const patient = await prisma.patient.findUnique({
      where: { id: req.body.patientId }
    });
    if (!patient) throw notFound('Không tìm thấy bệnh nhân');

    const medicines =
      req.body.medicineIds.length > 0
        ? await prisma.medicine.findMany({
            where: { id: { in: req.body.medicineIds } }
          })
        : [];

    const warnings = checkMedicineAllergies(
      patient.allergies,
      patient.chronicConditions,
      medicines
    );
    return sendSuccess(res, { warnings, hasWarnings: warnings.length > 0 });
  })
);

router.get(
  '/records/:id',
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const record = await prisma.medicalRecord.findUnique({
      where: { id: req.params.id },
      include: MEDICAL_RECORD_INCLUDE
    });
    if (!record) throw notFound('Không tìm thấy hồ sơ bệnh án');
    if (record.doctorId !== doctor.id) {
      throw forbidden('Bạn không có quyền xem hồ sơ của bác sĩ khác');
    }
    return sendSuccess(res, formatMedicalRecordDto(record));
  })
);

router.post(
  '/records',
  validateBody(saveRecordSchema),
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const result = await saveMedicalRecord(doctor.id, req.user!.userId, req.body);
    return sendSuccess(res, result, 201);
  })
);

router.put(
  '/records/:id',
  validateBody(saveRecordSchema),
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const result = await saveMedicalRecord(doctor.id, req.user!.userId, req.body, req.params.id);
    return sendSuccess(res, result);
  })
);

router.post(
  '/records/:id/publish',
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const orderedServiceIds = Array.isArray(req.body?.orderedServiceIds)
      ? req.body.orderedServiceIds
      : [];
    const result = await publishExistingMedicalRecord(
      req.params.id,
      doctor.id,
      req.user!.userId,
      orderedServiceIds
    );
    return sendSuccess(res, result);
  })
);

router.post(
  '/follow-up',
  validateBody(followUpSchema),
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const targetDoctorId = req.body.doctorId || doctor.id;

    const dto = await bookOutpatientAppointment({
      patientId: req.body.patientId,
      doctorId: targetDoctorId,
      date: req.body.date,
      session: req.body.session,
      bookingType: 'FOLLOW_UP',
      bookingFlow: 'FOLLOW_UP',
      chiefComplaint: req.body.chiefComplaint || 'Tái khám theo chỉ định bác sĩ',
      allowAutoCreateSchedule: true,
      actorUserId: req.user!.userId
    });

    return sendSuccess(res, dto, 201);
  })
);

router.get(
  '/schedules',
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const today = getTodayDateString();
    const fromStr = typeof req.query.from === 'string' && req.query.from ? req.query.from : today;
    const toStr =
      typeof req.query.to === 'string' && req.query.to ? req.query.to : addDays(fromStr, 14);

    const schedules = await prisma.doctorSchedule.findMany({
      where: {
        doctorId: doctor.id,
        scheduleDate: {
          gte: toDateOnly(fromStr),
          lte: toDateOnly(toStr)
        }
      },
      include: {
        _count: {
          select: {
            appointments: { where: { status: { not: 'CANCELLED' } } }
          }
        }
      },
      orderBy: [{ scheduleDate: 'asc' }, { session: 'asc' }]
    });

    const data = schedules.map((s) => ({
      id: s.id,
      doctorId: s.doctorId,
      doctorName: doctor.user.fullName,
      departmentName: doctor.department.name,
      scheduleDate: formatDateOnly(s.scheduleDate),
      session: s.session,
      startTime: s.startTime,
      endTime: s.endTime,
      maxPatients: s.maxPatients,
      avgMinutesPerPatient: s.avgMinutesPerPatient,
      lastQueueNumber: s.lastQueueNumber,
      bookedCount: s._count.appointments,
      isAvailable: s.isAvailable,
      notes: s.notes
    }));

    return sendSuccess(res, data);
  })
);

router.post(
  '/schedules',
  validateBody(upsertScheduleSchema),
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const scheduleDate = toDateOnly(req.body.date);
    const bounds = getSessionBounds(req.body.session);

    const saved = await prisma.doctorSchedule.upsert({
      where: {
        doctorId_scheduleDate_session: {
          doctorId: doctor.id,
          scheduleDate,
          session: req.body.session
        }
      },
      create: {
        doctorId: doctor.id,
        scheduleDate,
        session: req.body.session,
        startTime: bounds.startTime,
        endTime: bounds.endTime,
        maxPatients: req.body.maxPatients ?? 20,
        avgMinutesPerPatient: req.body.avgMinutesPerPatient ?? 12,
        isAvailable: req.body.isAvailable ?? true,
        notes: req.body.notes ?? null
      },
      update: {
        ...(req.body.maxPatients !== undefined ? { maxPatients: req.body.maxPatients } : {}),
        ...(req.body.avgMinutesPerPatient !== undefined
          ? { avgMinutesPerPatient: req.body.avgMinutesPerPatient }
          : {}),
        ...(req.body.isAvailable !== undefined ? { isAvailable: req.body.isAvailable } : {}),
        ...(req.body.notes !== undefined ? { notes: req.body.notes } : {})
      },
      include: {
        _count: { select: { appointments: { where: { status: { not: 'CANCELLED' } } } } }
      }
    });

    return sendSuccess(res, {
      id: saved.id,
      doctorId: saved.doctorId,
      doctorName: doctor.user.fullName,
      departmentName: doctor.department.name,
      scheduleDate: formatDateOnly(saved.scheduleDate),
      session: saved.session,
      startTime: saved.startTime,
      endTime: saved.endTime,
      maxPatients: saved.maxPatients,
      avgMinutesPerPatient: saved.avgMinutesPerPatient,
      lastQueueNumber: saved.lastQueueNumber,
      bookedCount: saved._count.appointments,
      isAvailable: saved.isAvailable,
      notes: saved.notes
    });
  })
);

router.patch(
  '/schedules/:id',
  validateBody(patchScheduleSchema),
  asyncHandler(async (req, res) => {
    const doctor = await getDoctorByUserId(req.user!.userId);
    const existing = await prisma.doctorSchedule.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Không tìm thấy lịch làm việc');
    if (existing.doctorId !== doctor.id) {
      throw forbidden('Bạn không có quyền sửa lịch của bác sĩ khác');
    }

    const updated = await prisma.doctorSchedule.update({
      where: { id: existing.id },
      data: {
        ...(req.body.isAvailable !== undefined ? { isAvailable: req.body.isAvailable } : {}),
        ...(req.body.maxPatients !== undefined ? { maxPatients: req.body.maxPatients } : {}),
        ...(req.body.avgMinutesPerPatient !== undefined
          ? { avgMinutesPerPatient: req.body.avgMinutesPerPatient }
          : {}),
        ...(req.body.notes !== undefined ? { notes: req.body.notes } : {})
      },
      include: {
        _count: { select: { appointments: { where: { status: { not: 'CANCELLED' } } } } }
      }
    });

    return sendSuccess(res, {
      id: updated.id,
      doctorId: updated.doctorId,
      doctorName: doctor.user.fullName,
      departmentName: doctor.department.name,
      scheduleDate: formatDateOnly(updated.scheduleDate),
      session: updated.session,
      startTime: updated.startTime,
      endTime: updated.endTime,
      maxPatients: updated.maxPatients,
      avgMinutesPerPatient: updated.avgMinutesPerPatient,
      lastQueueNumber: updated.lastQueueNumber,
      bookedCount: updated._count.appointments,
      isAvailable: updated.isAvailable,
      notes: updated.notes
    });
  })
);

export default router;
