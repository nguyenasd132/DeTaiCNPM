import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import {
  APPOINTMENT_FULL_INCLUDE,
  createWalkInAppointment,
  formatAppointmentDto,
  getLiveCurrentSttMap
} from '../services/appointment.service';
import {
  admitPatientToBed,
  dischargePatientFromBed,
  getBedsWithStats,
  transferPatientBed,
  updateBedMaintenanceStatus
} from '../services/bed.service';
import {
  confirmNursePayment,
  formatInvoiceDto,
  INVOICE_INCLUDE,
  rejectNursePayment,
  dispenseNursePrescription
} from '../services/payment.service';
import { formatPrescriptionDto, PRESCRIPTION_INCLUDE } from '../services/record.service';
import {
  AppointmentStatus,
  BedStatus,
  InvoiceStatus,
  PrescriptionStatus,
  SessionType,
  TriageDataJson
} from '../types';
import { formatDateOnly, getTodayDateString, toDateOnly } from '../utils/date';
import { badRequest, conflict, notFound } from '../utils/errors';
import { sendSuccess } from '../utils/response';

const router = Router();

router.use(authenticate, requireRole('NURSE'));

async function getNurseByUserId(userId: string) {
  const nurse = await prisma.nurse.findUnique({
    where: { userId },
    include: { user: true, department: true }
  });
  if (!nurse) throw notFound('Không tìm thấy hồ sơ điều dưỡng');
  return nurse;
}

const checkInSchema = z.object({
  appointmentId: z.string().optional(),
  appointmentCode: z.string().optional(),
  queueNumber: z.number().int().positive().optional(),
  doctorId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  session: z.enum(['MORNING', 'AFTERNOON']).optional()
});

const walkInSchema = z.object({
  patientId: z.string().optional(),
  fullName: z.string().min(2).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  dateOfBirth: z.string().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  insuranceNumber: z.string().optional(),
  address: z.string().optional(),
  newPatient: z
    .object({
      fullName: z.string().min(2),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      dateOfBirth: z.string().optional(),
      gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
      insuranceNumber: z.string().optional(),
      address: z.string().optional()
    })
    .optional(),
  doctorId: z.string().min(1, 'Vui lòng chọn bác sĩ'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  session: z.enum(['MORNING', 'AFTERNOON']),
  isPriority: z.boolean().optional(),
  chiefComplaint: z.string().optional(),
  autoCheckIn: z.boolean().optional()
});

const procedureSchema = z.object({
  appointmentId: z.string().min(1),
  vitals: z.object({
    bloodPressureSystolic: z.number().positive().optional(),
    bloodPressureDiastolic: z.number().positive().optional(),
    heartRate: z.number().positive().optional(),
    temperature: z.number().positive().optional(),
    spo2: z.number().min(50).max(100).optional(),
    respiratoryRate: z.number().positive().optional(),
    heightCm: z.number().positive().optional(),
    weightKg: z.number().positive().optional(),
    bmi: z.number().positive().optional()
  }),
  checklistData: z
    .object({
      bhytVerified: z.boolean().optional(),
      identityVerified: z.boolean().optional(),
      allergyScreened: z.boolean().optional(),
      consentSigned: z.boolean().optional(),
      notes: z.string().optional(),
      items: z.array(z.object({ label: z.string(), checked: z.boolean() })).optional()
    })
    .default({}),
  triageNotes: z.string().optional()
});

const confirmPaymentSchema = z.object({
  method: z.enum(['QR_TRANSFER', 'COUNTER_CASH', 'CARD']).optional(),
  notes: z.string().optional()
});

const rejectPaymentSchema = z.object({
  reason: z.string().optional()
});

const admitBedSchema = z.object({
  patientId: z.string().min(1, 'Vui lòng chọn bệnh nhân'),
  notes: z.string().optional()
});

const transferBedSchema = z.object({
  targetBedId: z.string().min(1, 'Vui lòng chọn giường chuyển đến'),
  notes: z.string().optional()
});

const bedNotesSchema = z.object({
  notes: z.string().optional()
});

const bedStatusSchema = z.object({
  status: z.enum(['AVAILABLE', 'MAINTENANCE']),
  notes: z.string().optional()
});

router.get(
  '/patients',
  asyncHandler(async (req, res) => {
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const patients = await prisma.patient.findMany({
      where: search
        ? {
            OR: [
              { patientCode: { contains: search, mode: 'insensitive' } },
              { user: { fullName: { contains: search, mode: 'insensitive' } } },
              { user: { phone: { contains: search, mode: 'insensitive' } } },
              { insuranceNumber: { contains: search, mode: 'insensitive' } }
            ]
          }
        : undefined,
      include: { user: true },
      orderBy: { patientCode: 'asc' },
      take: 50
    });

    return sendSuccess(
      res,
      patients.map((p) => ({
        id: p.id,
        userId: p.userId,
        patientCode: p.patientCode,
        fullName: p.user.fullName,
        email: p.user.email,
        phone: p.user.phone,
        dateOfBirth: p.dateOfBirth ? formatDateOnly(p.dateOfBirth) : null,
        gender: p.gender,
        address: p.address,
        nationalId: p.nationalId,
        insuranceNumber: p.insuranceNumber,
        bloodType: p.bloodType,
        allergies: Array.isArray(p.allergies) ? p.allergies : [],
        chronicConditions: Array.isArray(p.chronicConditions) ? p.chronicConditions : [],
        emergencyContact: p.emergencyContact || null
      }))
    );
  })
);

router.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const dateStr =
      typeof req.query.date === 'string' && req.query.date
        ? req.query.date
        : getTodayDateString();
    const session =
      req.query.session === 'MORNING' || req.query.session === 'AFTERNOON'
        ? (req.query.session as SessionType)
        : undefined;
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as AppointmentStatus)
        : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const queueNum = search && /^\d+$/.test(search) ? Number(search) : null;

    const appointments = await prisma.appointment.findMany({
      where: {
        appointmentDate: toDateOnly(dateStr),
        ...(session ? { session } : {}),
        ...(status ? { status } : {}),
        ...(search
          ? {
              OR: [
                { appointmentCode: { contains: search, mode: 'insensitive' } },
                { patient: { patientCode: { contains: search, mode: 'insensitive' } } },
                { patient: { user: { fullName: { contains: search, mode: 'insensitive' } } } },
                ...(queueNum !== null ? [{ queueNumber: queueNum }] : [])
              ]
            }
          : {})
      },
      include: APPOINTMENT_FULL_INCLUDE,
      orderBy: [{ session: 'asc' }, { queueNumber: 'asc' }]
    });

    const sttMap = await getLiveCurrentSttMap(appointments);
    return sendSuccess(
      res,
      appointments.map((a) => {
        const key = `${a.doctorId}|${formatDateOnly(a.appointmentDate)}|${a.session}`;
        return formatAppointmentDto(a, sttMap.get(key) ?? null);
      })
    );
  })
);

async function performCheckIn(appointmentId: string, nurseUserId: string) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) throw notFound('Không tìm thấy lịch hẹn');
  if (appt.status === 'CANCELLED') {
    throw conflict('Lịch hẹn đã bị hủy, không thể check-in');
  }
  if (appt.status === 'COMPLETED' || appt.status === 'IN_PROGRESS') {
    throw conflict('Lịch hẹn đang khám hoặc đã hoàn thành');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.appointment.update({
      where: { id: appt.id },
      data: {
        status: 'CHECKED_IN',
        checkedInAt: appt.checkedInAt || new Date()
      },
      include: APPOINTMENT_FULL_INCLUDE
    });

    await tx.auditLog.create({
      data: {
        actorUserId: nurseUserId,
        action: 'APPOINTMENT_CHECKED_IN',
        entityType: 'Appointment',
        entityId: saved.id,
        metadata: { appointmentCode: saved.appointmentCode, queueNumber: saved.queueNumber }
      }
    });

    return saved;
  });

  const sttMap = await getLiveCurrentSttMap([updated]);
  const key = `${updated.doctorId}|${formatDateOnly(updated.appointmentDate)}|${updated.session}`;
  return formatAppointmentDto(updated, sttMap.get(key) ?? null);
}

router.post(
  '/appointments/check-in',
  validateBody(checkInSchema),
  asyncHandler(async (req, res) => {
    const { appointmentId, appointmentCode, queueNumber, doctorId, date, session } = req.body;
    let targetId = appointmentId;

    if (!targetId && appointmentCode) {
      const found = await prisma.appointment.findUnique({
        where: { appointmentCode: appointmentCode.trim() }
      });
      if (!found) throw notFound(`Không tìm thấy lịch hẹn mã ${appointmentCode}`);
      targetId = found.id;
    } else if (!targetId && queueNumber !== undefined) {
      const targetDate = toDateOnly(date || getTodayDateString());
      const found = await prisma.appointment.findFirst({
        where: {
          queueNumber,
          appointmentDate: targetDate,
          ...(doctorId ? { doctorId } : {}),
          ...(session ? { session } : {}),
          status: { not: 'CANCELLED' }
        }
      });
      if (!found) throw notFound(`Không tìm thấy lịch hẹn STT #${queueNumber}`);
      targetId = found.id;
    }

    if (!targetId) {
      throw badRequest('Cần cung cấp appointmentId, appointmentCode hoặc queueNumber');
    }

    const dto = await performCheckIn(targetId, req.user!.userId);
    return sendSuccess(res, dto);
  })
);

router.patch(
  '/appointments/:id/check-in',
  asyncHandler(async (req, res) => {
    const dto = await performCheckIn(req.params.id, req.user!.userId);
    return sendSuccess(res, dto);
  })
);

router.post(
  '/appointments/walk-in',
  validateBody(walkInSchema),
  asyncHandler(async (req, res) => {
    const normalizedNewPatient =
      req.body.newPatient ||
      (req.body.fullName
        ? {
            fullName: req.body.fullName,
            phone: req.body.phone,
            email: req.body.email,
            dateOfBirth: req.body.dateOfBirth,
            gender: req.body.gender,
            insuranceNumber: req.body.insuranceNumber,
            address: req.body.address
          }
        : undefined);

    const dto = await createWalkInAppointment(
      {
        patientId: req.body.patientId,
        newPatient: normalizedNewPatient,
        doctorId: req.body.doctorId,
        date: req.body.date,
        session: req.body.session,
        isPriority: req.body.isPriority,
        chiefComplaint: req.body.chiefComplaint,
        autoCheckIn: req.body.autoCheckIn
      },
      req.user!.userId
    );
    return sendSuccess(res, dto, 201);
  })
);

router.get(
  '/procedures',
  asyncHandler(async (req, res) => {
    const appointmentId =
      typeof req.query.appointmentId === 'string' && req.query.appointmentId
        ? req.query.appointmentId
        : undefined;
    const dateStr =
      typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;

    const appointments = await prisma.appointment.findMany({
      where: {
        triageData: { not: Prisma.DbNull },
        ...(appointmentId ? { id: appointmentId } : {}),
        ...(dateStr ? { appointmentDate: toDateOnly(dateStr) } : {})
      },
      orderBy: { updatedAt: 'desc' }
    });

    return sendSuccess(
      res,
      appointments.map((appt) => {
        const td = appt.triageData as unknown as TriageDataJson;
        return {
          id: td.id,
          appointmentId: appt.id,
          nurseId: td.nurseId,
          nurseName: td.nurseName,
          vitals: td.vitals || {},
          checklistData: td.checklistData || {},
          triageNotes: td.triageNotes ?? null,
          recordedAt: td.recordedAt
        };
      })
    );
  })
);

router.post(
  '/procedures',
  validateBody(procedureSchema),
  asyncHandler(async (req, res) => {
    const nurse = await prisma.nurse.findUnique({
      where: { userId: req.user!.userId },
      include: { user: true }
    });
    if (!nurse) throw notFound('Không tìm thấy hồ sơ điều dưỡng');

    const appt = await prisma.appointment.findUnique({
      where: { id: req.body.appointmentId }
    });
    if (!appt) throw notFound('Không tìm thấy lịch hẹn');

    const vitals = { ...req.body.vitals };
    if (vitals.heightCm && vitals.weightKg && !vitals.bmi) {
      const heightM = vitals.heightCm / 100;
      vitals.bmi = Number((vitals.weightKg / (heightM * heightM)).toFixed(1));
    }

    const existingTriage = appt.triageData as unknown as TriageDataJson | null;
    const triagePayload: TriageDataJson = {
      id: existingTriage?.id || crypto.randomUUID(),
      nurseId: nurse.id,
      nurseName: nurse.user.fullName,
      vitals,
      checklistData: req.body.checklistData,
      triageNotes: req.body.triageNotes || null,
      recordedAt: new Date().toISOString()
    };

    await prisma.appointment.update({
      where: { id: appt.id },
      data: {
        triageData: triagePayload as unknown as Prisma.InputJsonValue
      }
    });

    return sendSuccess(res, {
      id: triagePayload.id,
      appointmentId: appt.id,
      nurseId: triagePayload.nurseId,
      nurseName: triagePayload.nurseName,
      vitals: triagePayload.vitals,
      checklistData: triagePayload.checklistData,
      triageNotes: triagePayload.triageNotes,
      recordedAt: triagePayload.recordedAt
    });
  })
);

router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    let statusWhere: Prisma.InvoiceWhereInput['status'] = undefined;
    if (statusParam === 'PENDING') {
      statusWhere = { in: ['UNPAID', 'PENDING_VERIFICATION'] };
    } else if (
      statusParam &&
      ['UNPAID', 'PENDING_VERIFICATION', 'PAID', 'CANCELLED'].includes(statusParam)
    ) {
      statusWhere = statusParam as InvoiceStatus;
    }

    const invoices = await prisma.invoice.findMany({
      where: {
        ...(statusWhere ? { status: statusWhere } : {}),
        ...(search
          ? {
              OR: [
                { invoiceCode: { contains: search, mode: 'insensitive' } },
                { patient: { patientCode: { contains: search, mode: 'insensitive' } } },
                { patient: { user: { fullName: { contains: search, mode: 'insensitive' } } } }
              ]
            }
          : {})
      },
      include: INVOICE_INCLUDE,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }]
    });

    return sendSuccess(res, invoices.map(formatInvoiceDto));
  })
);

router.post(
  '/payments/:id/confirm',
  validateBody(confirmPaymentSchema),
  asyncHandler(async (req, res) => {
    const nurse = await getNurseByUserId(req.user!.userId);
    const result = await confirmNursePayment(req.params.id, nurse.id, req.user!.userId, req.body);
    return sendSuccess(res, result);
  })
);

router.post(
  '/payments/:id/reject',
  validateBody(rejectPaymentSchema),
  asyncHandler(async (req, res) => {
    const nurse = await getNurseByUserId(req.user!.userId);
    const result = await rejectNursePayment(
      req.params.id,
      nurse.id,
      req.user!.userId,
      req.body.reason
    );
    return sendSuccess(res, result);
  })
);

router.get(
  '/prescriptions',
  asyncHandler(async (req, res) => {
    const statusParam =
      typeof req.query.status === 'string' &&
      ['PENDING_PAYMENT', 'PAID', 'DISPENSED', 'CANCELLED'].includes(req.query.status)
        ? (req.query.status as PrescriptionStatus)
        : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const prescriptions = await prisma.prescription.findMany({
      where: {
        ...(statusParam ? { status: statusParam } : {}),
        ...(search
          ? {
              OR: [
                { prescriptionCode: { contains: search, mode: 'insensitive' } },
                { patient: { patientCode: { contains: search, mode: 'insensitive' } } },
                { patient: { user: { fullName: { contains: search, mode: 'insensitive' } } } }
              ]
            }
          : {})
      },
      include: PRESCRIPTION_INCLUDE,
      orderBy: { createdAt: 'desc' }
    });

    return sendSuccess(res, prescriptions.map(formatPrescriptionDto));
  })
);

router.post(
  '/prescriptions/:id/dispense',
  asyncHandler(async (req, res) => {
    const nurse = await getNurseByUserId(req.user!.userId);
    const dto = await dispenseNursePrescription(req.params.id, nurse.id, req.user!.userId);
    return sendSuccess(res, dto);
  })
);

router.get(
  '/beds',
  asyncHandler(async (req, res) => {
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const status =
      req.query.status === 'AVAILABLE' ||
      req.query.status === 'OCCUPIED' ||
      req.query.status === 'MAINTENANCE'
        ? (req.query.status as BedStatus)
        : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;

    const result = await getBedsWithStats({ departmentId, status, search });
    return sendSuccess(res, result);
  })
);

router.post(
  '/beds/:id/admit',
  validateBody(admitBedSchema),
  asyncHandler(async (req, res) => {
    const nurse = await getNurseByUserId(req.user!.userId);
    const dto = await admitPatientToBed(
      req.params.id,
      req.body.patientId,
      nurse.id,
      req.user!.userId,
      req.body.notes
    );
    return sendSuccess(res, dto);
  })
);

router.post(
  '/beds/:id/transfer',
  validateBody(transferBedSchema),
  asyncHandler(async (req, res) => {
    const nurse = await getNurseByUserId(req.user!.userId);
    const result = await transferPatientBed(
      req.params.id,
      req.body.targetBedId,
      nurse.id,
      req.user!.userId,
      req.body.notes
    );
    return sendSuccess(res, {
      ...result.targetBed,
      sourceBed: result.sourceBed,
      targetBed: result.targetBed
    });
  })
);

router.post(
  '/beds/:id/discharge',
  validateBody(bedNotesSchema),
  asyncHandler(async (req, res) => {
    const nurse = await getNurseByUserId(req.user!.userId);
    const dto = await dischargePatientFromBed(
      req.params.id,
      nurse.id,
      req.user!.userId,
      req.body.notes
    );
    return sendSuccess(res, dto);
  })
);

router.patch(
  '/beds/:id/status',
  validateBody(bedStatusSchema),
  asyncHandler(async (req, res) => {
    const dto = await updateBedMaintenanceStatus(
      req.params.id,
      req.body.status,
      req.user!.userId,
      req.body.notes
    );
    return sendSuccess(res, dto);
  })
);

export default router;
