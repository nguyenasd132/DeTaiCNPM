import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppointmentStatus, BookingType, SessionType, TriageDataJson } from '../types';
import { generateHospitalCode, generateSequentialCode } from '../utils/codes';
import {
  addDays,
  computeEstimatedTime,
  formatDateOnly,
  getSessionBounds,
  getSessionLabel,
  getTodayDateString,
  toDateOnly
} from '../utils/date';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';

export const APPOINTMENT_FULL_INCLUDE = {
  patient: { include: { user: true } },
  doctor: { include: { user: true, room: true, department: true } },
  department: true,
  medicalRecord: { select: { id: true, status: true } }
} as const;

type AppointmentWithRelations = Prisma.AppointmentGetPayload<{
  include: typeof APPOINTMENT_FULL_INCLUDE;
}>;

interface LockedScheduleRow {
  id: string;
  maxPatients: number;
  avgMinutesPerPatient: number;
  lastQueueNumber: number;
  isAvailable: boolean;
}

export function formatAppointmentDto(
  appt: AppointmentWithRelations,
  liveCurrentStt: number | null = null
) {
  return {
    id: appt.id,
    appointmentCode: appt.appointmentCode,
    patientId: appt.patientId,
    patientCode: appt.patient.patientCode,
    patientName: appt.patient.user.fullName,
    patientPhone: appt.patient.user.phone,
    patientGender: appt.patient.gender,
    patientDateOfBirth: appt.patient.dateOfBirth
      ? formatDateOnly(appt.patient.dateOfBirth)
      : null,
    doctorId: appt.doctorId,
    doctorCode: appt.doctor.doctorCode,
    doctorName: appt.doctor.user.fullName,
    doctorTitle: appt.doctor.title,
    specialty: appt.doctor.specialty,
    departmentId: appt.departmentId,
    departmentName: appt.department.name,
    roomName: appt.doctor.room ? appt.doctor.room.name : null,
    scheduleId: appt.scheduleId,
    appointmentDate: formatDateOnly(appt.appointmentDate),
    session: appt.session,
    queueNumber: appt.queueNumber,
    estimatedTime: appt.estimatedTime,
    liveCurrentStt,
    bookingType: appt.bookingType,
    bookingFlow: appt.bookingFlow,
    status: appt.status,
    isPriority: appt.isPriority,
    chiefComplaint: appt.chiefComplaint,
    cancelReason: appt.cancelReason,
    checkedInAt: appt.checkedInAt ? appt.checkedInAt.toISOString() : null,
    startedAt: appt.startedAt ? appt.startedAt.toISOString() : null,
    completedAt: appt.completedAt ? appt.completedAt.toISOString() : null,
    createdAt: appt.createdAt.toISOString(),
    hasNursingProcedure: Boolean(appt.triageData),
    hasMedicalRecord: Boolean(appt.medicalRecord),
    nursingProcedure: appt.triageData
      ? (() => {
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
        })()
      : null,
    medicalRecordId: appt.medicalRecord ? appt.medicalRecord.id : null
  };
}

export async function getLiveCurrentSttMap(
  appointments: { doctorId: string; appointmentDate: Date; session: SessionType }[]
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (appointments.length === 0) return result;

  const uniqueKeys = new Map<string, { doctorId: string; appointmentDate: Date; session: SessionType }>();
  for (const item of appointments) {
    const dateStr = formatDateOnly(item.appointmentDate);
    const key = `${item.doctorId}|${dateStr}|${item.session}`;
    if (!uniqueKeys.has(key)) {
      uniqueKeys.set(key, item);
    }
  }

  const orConditions = Array.from(uniqueKeys.values()).map((k) => ({
    doctorId: k.doctorId,
    appointmentDate: k.appointmentDate,
    session: k.session,
    status: { in: ['IN_PROGRESS', 'COMPLETED'] as AppointmentStatus[] }
  }));

  const activeRows = await prisma.appointment.findMany({
    where: { OR: orConditions },
    select: {
      doctorId: true,
      appointmentDate: true,
      session: true,
      queueNumber: true,
      status: true
    }
  });

  for (const key of uniqueKeys.keys()) {
    result.set(key, null);
  }

  for (const row of activeRows) {
    const key = `${row.doctorId}|${formatDateOnly(row.appointmentDate)}|${row.session}`;
    const existing = result.get(key) ?? null;
    if (row.status === 'IN_PROGRESS') {
      result.set(key, row.queueNumber);
    } else if (existing === null || row.queueNumber > existing) {
      // Only update from COMPLETED if no IN_PROGRESS has set a higher priority or check separately
      const hasInProgress = activeRows.some(
        (r) =>
          `${r.doctorId}|${formatDateOnly(r.appointmentDate)}|${r.session}` === key &&
          r.status === 'IN_PROGRESS'
      );
      if (!hasInProgress) {
        result.set(key, row.queueNumber);
      }
    }
  }

  return result;
}

export async function getAvailability(filters: {
  flow?: string;
  departmentId?: string;
  doctorId?: string;
  date?: string;
  fromDate?: string;
  toDate?: string;
  session?: SessionType;
}) {
  const today = getTodayDateString();
  const startDateStr = filters.date || filters.fromDate || today;
  const endDateStr = filters.date || filters.toDate || addDays(startDateStr, 7);

  const schedules = await prisma.doctorSchedule.findMany({
    where: {
      scheduleDate: {
        gte: toDateOnly(startDateStr),
        lte: toDateOnly(endDateStr)
      },
      isAvailable: true,
      ...(filters.session ? { session: filters.session } : {}),
      ...(filters.doctorId ? { doctorId: filters.doctorId } : {}),
      doctor: {
        user: { isActive: true },
        ...(filters.departmentId ? { departmentId: filters.departmentId } : {})
      }
    },
    include: {
      doctor: {
        include: {
          user: true,
          department: true,
          room: true
        }
      }
    },
    orderBy: [{ scheduleDate: 'asc' }, { session: 'asc' }, { doctor: { user: { fullName: 'asc' } } }]
  });

  if (schedules.length === 0) return [];

  const doctorIds = Array.from(new Set(schedules.map((s) => s.doctorId)));
  const appointmentRows = await prisma.appointment.findMany({
    where: {
      doctorId: { in: doctorIds },
      appointmentDate: {
        gte: toDateOnly(startDateStr),
        lte: toDateOnly(endDateStr)
      }
    },
    select: {
      doctorId: true,
      appointmentDate: true,
      session: true,
      queueNumber: true,
      status: true
    }
  });

  const statsMap = new Map<string, { bookedCount: number; maxQueueNumber: number }>();
  for (const row of appointmentRows) {
    const key = `${row.doctorId}|${formatDateOnly(row.appointmentDate)}|${row.session}`;
    const current = statsMap.get(key) || { bookedCount: 0, maxQueueNumber: 0 };
    if (row.status !== 'CANCELLED') {
      current.bookedCount += 1;
    }
    if (row.queueNumber > current.maxQueueNumber) {
      current.maxQueueNumber = row.queueNumber;
    }
    statsMap.set(key, current);
  }

  return schedules.map((s) => {
    const dateStr = formatDateOnly(s.scheduleDate);
    const key = `${s.doctorId}|${dateStr}|${s.session}`;
    const stats = statsMap.get(key) || { bookedCount: 0, maxQueueNumber: 0 };
    const remainingSlots = Math.max(0, s.maxPatients - stats.bookedCount);
    const nextQueueNumber = Math.max(s.lastQueueNumber || 0, stats.maxQueueNumber) + 1;

    return {
      scheduleId: s.id,
      doctorId: s.doctorId,
      doctorName: s.doctor.user.fullName,
      doctorTitle: s.doctor.title,
      doctorCode: s.doctor.doctorCode,
      specialty: s.doctor.specialty,
      consultationFee: s.doctor.consultationFee,
      departmentId: s.doctor.departmentId,
      departmentName: s.doctor.department.name,
      roomName: s.doctor.room ? s.doctor.room.name : null,
      scheduleDate: dateStr,
      session: s.session,
      sessionLabel: getSessionLabel(s.session),
      startTime: s.startTime,
      endTime: s.endTime,
      maxPatients: s.maxPatients,
      bookedCount: stats.bookedCount,
      remainingSlots,
      nextQueueNumber,
      estimatedTime: computeEstimatedTime(s.session, nextQueueNumber, s.avgMinutesPerPatient),
      avgMinutesPerPatient: s.avgMinutesPerPatient,
      isAvailable: s.isAvailable && remainingSlots > 0
    };
  });
}

export interface BookAppointmentInput {
  patientId: string;
  doctorId: string;
  date: string;
  session: SessionType;
  bookingType: BookingType;
  bookingFlow?: string;
  chiefComplaint?: string;
  isPriority?: boolean;
  autoCheckIn?: boolean;
  allowAutoCreateSchedule?: boolean;
  actorUserId?: string;
}

export async function allocateAndCreateAppointmentTx(
  tx: Prisma.TransactionClient,
  input: BookAppointmentInput
) {
  const doctor = await tx.doctor.findUnique({
    where: { id: input.doctorId },
    include: { user: true, department: true, room: true }
  });
  if (!doctor || !doctor.user.isActive) {
    throw notFound('Không tìm thấy bác sĩ hoặc bác sĩ hiện không hoạt động');
  }

  const patient = await tx.patient.findUnique({
    where: { id: input.patientId },
    include: { user: true }
  });
  if (!patient) {
    throw notFound('Không tìm thấy hồ sơ bệnh nhân');
  }

  const scheduleDate = toDateOnly(input.date);

  if (input.allowAutoCreateSchedule) {
    const bounds = getSessionBounds(input.session);
    const newScheduleId = crypto.randomUUID();
    await tx.$executeRaw`
      INSERT INTO doctor_schedules (
        id, doctor_id, schedule_date, session, start_time, end_time,
        max_patients, avg_minutes_per_patient, last_queue_number, is_available, created_at, updated_at
      )
      VALUES (
        ${newScheduleId}, ${input.doctorId}, ${scheduleDate}::date, ${input.session}::"SessionType",
        ${bounds.startTime}, ${bounds.endTime}, 20, 12, 0, true, NOW(), NOW()
      )
      ON CONFLICT (doctor_id, schedule_date, session) DO NOTHING
    `;
  }

  // CRITICAL: Lock doctor_schedules row for (doctor_id, schedule_date, session) to serialize STT allocation
  const lockedRows = await tx.$queryRaw<LockedScheduleRow[]>`
    SELECT
      id,
      max_patients AS "maxPatients",
      avg_minutes_per_patient AS "avgMinutesPerPatient",
      last_queue_number AS "lastQueueNumber",
      is_available AS "isAvailable"
    FROM doctor_schedules
    WHERE doctor_id = ${input.doctorId}
      AND schedule_date = ${scheduleDate}::date
      AND session = ${input.session}::"SessionType"
    FOR UPDATE
  `;

  if (!lockedRows || lockedRows.length === 0) {
    throw badRequest('Bác sĩ chưa mở lịch khám cho ngày và buổi đã chọn');
  }

  const lockedSchedule = lockedRows[0];
  if (!lockedSchedule.isAvailable) {
    throw conflict('Buổi khám này hiện đang tạm đóng lịch');
  }

  const duplicateBooking = await tx.appointment.findFirst({
    where: {
      patientId: input.patientId,
      doctorId: input.doctorId,
      appointmentDate: scheduleDate,
      session: input.session,
      status: { not: 'CANCELLED' }
    }
  });
  if (duplicateBooking) {
    throw conflict(
      'Bệnh nhân đã có lịch hẹn với bác sĩ này trong buổi khám đã chọn',
      undefined,
      'DUPLICATE_BOOKING'
    );
  }

  const activeCount = await tx.appointment.count({
    where: {
      doctorId: input.doctorId,
      appointmentDate: scheduleDate,
      session: input.session,
      status: { not: 'CANCELLED' }
    }
  });

  if (activeCount >= lockedSchedule.maxPatients && !input.isPriority) {
    throw conflict('Buổi khám đã đạt số lượng bệnh nhân tối đa', undefined, 'SESSION_FULL');
  }

  const maxAgg = await tx.appointment.aggregate({
    _max: { queueNumber: true },
    where: {
      doctorId: input.doctorId,
      appointmentDate: scheduleDate,
      session: input.session
    }
  });

  const nextQueueNumber =
    Math.max(lockedSchedule.lastQueueNumber || 0, maxAgg._max.queueNumber || 0) + 1;

  await tx.doctorSchedule.update({
    where: { id: lockedSchedule.id },
    data: { lastQueueNumber: nextQueueNumber }
  });

  const estimatedTime = computeEstimatedTime(
    input.session,
    nextQueueNumber,
    lockedSchedule.avgMinutesPerPatient
  );

  const now = new Date();
  const appointment = await tx.appointment.create({
    data: {
      appointmentCode: generateHospitalCode('LH'),
      patientId: input.patientId,
      doctorId: input.doctorId,
      departmentId: doctor.departmentId,
      scheduleId: lockedSchedule.id,
      appointmentDate: scheduleDate,
      session: input.session,
      queueNumber: nextQueueNumber,
      estimatedTime,
      bookingType: input.bookingType,
      bookingFlow: input.bookingFlow || input.bookingType,
      status: input.autoCheckIn ? 'CHECKED_IN' : 'BOOKED',
      isPriority: Boolean(input.isPriority),
      chiefComplaint: input.chiefComplaint?.trim() || null,
      checkedInAt: input.autoCheckIn ? now : null
    },
    include: APPOINTMENT_FULL_INCLUDE
  });

  await tx.notification.create({
    data: {
      userId: patient.userId,
      title: `Đặt lịch thành công • STT #${String(nextQueueNumber).padStart(2, '0')}`,
      message: `Lịch khám ${getSessionLabel(input.session)} ngày ${formatDateOnly(
        scheduleDate
      )} với ${doctor.title ? `${doctor.title} ` : ''}${doctor.user.fullName} (${
        doctor.department.name
      }). Giờ dự kiến: ${estimatedTime}.`,
      type: 'APPOINTMENT',
      payload: {
        appointmentId: appointment.id,
        appointmentCode: appointment.appointmentCode,
        queueNumber: nextQueueNumber,
        estimatedTime,
        date: formatDateOnly(scheduleDate),
        session: input.session
      }
    }
  });

  await tx.auditLog.create({
    data: {
      actorUserId: input.actorUserId || patient.userId,
      action: 'APPOINTMENT_BOOKED',
      entityType: 'Appointment',
      entityId: appointment.id,
      metadata: {
        appointmentCode: appointment.appointmentCode,
        queueNumber: nextQueueNumber,
        session: input.session,
        bookingType: input.bookingType,
        bookingFlow: input.bookingFlow || input.bookingType
      }
    }
  });

  return appointment;
}

export async function bookOutpatientAppointment(input: BookAppointmentInput) {
  const appt = await prisma.$transaction((tx) => allocateAndCreateAppointmentTx(tx, input));
  const sttMap = await getLiveCurrentSttMap([appt]);
  const key = `${appt.doctorId}|${formatDateOnly(appt.appointmentDate)}|${appt.session}`;
  return formatAppointmentDto(appt, sttMap.get(key) ?? null);
}

export async function reschedulePatientAppointment(
  patientId: string,
  appointmentId: string,
  input: { date: string; session: SessionType; doctorId?: string },
  actorUserId: string
) {
  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: { include: { user: true } } }
    });
    if (!existing) {
      throw notFound('Không tìm thấy lịch hẹn');
    }
    if (existing.patientId !== patientId) {
      throw forbidden('Bạn không có quyền thay đổi lịch hẹn này');
    }
    if (!['BOOKED', 'CHECKED_IN'].includes(existing.status)) {
      throw conflict('Chỉ có thể đổi lịch hẹn ở trạng thái Đã đặt hoặc Đã check-in');
    }

    const targetDoctorId = input.doctorId || existing.doctorId;
    const targetDate = toDateOnly(input.date);

    if (
      targetDoctorId === existing.doctorId &&
      formatDateOnly(targetDate) === formatDateOnly(existing.appointmentDate) &&
      input.session === existing.session
    ) {
      throw badRequest('Ngày và buổi khám mới trùng với lịch hẹn hiện tại');
    }

    const doctor = await tx.doctor.findUnique({
      where: { id: targetDoctorId },
      include: { user: true, department: true }
    });
    if (!doctor || !doctor.user.isActive) {
      throw notFound('Không tìm thấy bác sĩ cho lịch mới');
    }

    const lockedRows = await tx.$queryRaw<LockedScheduleRow[]>`
      SELECT
        id,
        max_patients AS "maxPatients",
        avg_minutes_per_patient AS "avgMinutesPerPatient",
        last_queue_number AS "lastQueueNumber",
        is_available AS "isAvailable"
      FROM doctor_schedules
      WHERE doctor_id = ${targetDoctorId}
        AND schedule_date = ${targetDate}::date
        AND session = ${input.session}::"SessionType"
      FOR UPDATE
    `;

    if (!lockedRows || lockedRows.length === 0) {
      throw badRequest('Bác sĩ chưa mở lịch khám cho ngày và buổi mới');
    }
    const lockedSchedule = lockedRows[0];
    if (!lockedSchedule.isAvailable) {
      throw conflict('Buổi khám mới hiện đang tạm ngưng nhận bệnh nhân');
    }

    const duplicate = await tx.appointment.findFirst({
      where: {
        id: { not: appointmentId },
        patientId,
        doctorId: targetDoctorId,
        appointmentDate: targetDate,
        session: input.session,
        status: { not: 'CANCELLED' }
      }
    });
    if (duplicate) {
      throw conflict('Bạn đã có lịch hẹn khác với bác sĩ này trong buổi khám mới');
    }

    const activeCount = await tx.appointment.count({
      where: {
        doctorId: targetDoctorId,
        appointmentDate: targetDate,
        session: input.session,
        status: { not: 'CANCELLED' }
      }
    });
    if (activeCount >= lockedSchedule.maxPatients) {
      throw conflict('Buổi khám mới đã đầy');
    }

    const maxAgg = await tx.appointment.aggregate({
      _max: { queueNumber: true },
      where: {
        doctorId: targetDoctorId,
        appointmentDate: targetDate,
        session: input.session
      }
    });

    const nextQueueNumber =
      Math.max(lockedSchedule.lastQueueNumber || 0, maxAgg._max.queueNumber || 0) + 1;

    await tx.doctorSchedule.update({
      where: { id: lockedSchedule.id },
      data: { lastQueueNumber: nextQueueNumber }
    });

    const estimatedTime = computeEstimatedTime(
      input.session,
      nextQueueNumber,
      lockedSchedule.avgMinutesPerPatient
    );

    const saved = await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        doctorId: targetDoctorId,
        departmentId: doctor.departmentId,
        scheduleId: lockedSchedule.id,
        appointmentDate: targetDate,
        session: input.session,
        queueNumber: nextQueueNumber,
        estimatedTime,
        status: 'BOOKED',
        checkedInAt: null
      },
      include: APPOINTMENT_FULL_INCLUDE
    });

    await tx.notification.create({
      data: {
        userId: existing.patient.userId,
        title: `Đổi lịch thành công • STT mới #${String(nextQueueNumber).padStart(2, '0')}`,
        message: `Lịch khám ${existing.appointmentCode} đã chuyển sang ${getSessionLabel(
          input.session
        )} ngày ${formatDateOnly(targetDate)} với ${doctor.user.fullName}. Giờ dự kiến: ${estimatedTime}.`,
        type: 'APPOINTMENT',
        payload: {
          appointmentId: saved.id,
          queueNumber: nextQueueNumber,
          estimatedTime,
          date: formatDateOnly(targetDate),
          session: input.session
        }
      }
    });

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'APPOINTMENT_RESCHEDULED',
        entityType: 'Appointment',
        entityId: saved.id,
        metadata: {
          previousDate: formatDateOnly(existing.appointmentDate),
          previousSession: existing.session,
          previousStt: existing.queueNumber,
          newDate: formatDateOnly(targetDate),
          newSession: input.session,
          newStt: nextQueueNumber
        }
      }
    });

    return saved;
  });

  const sttMap = await getLiveCurrentSttMap([updated]);
  const key = `${updated.doctorId}|${formatDateOnly(updated.appointmentDate)}|${updated.session}`;
  return formatAppointmentDto(updated, sttMap.get(key) ?? null);
}

export async function cancelPatientAppointment(
  patientId: string,
  appointmentId: string,
  reason: string | undefined,
  actorUserId: string
) {
  const existing = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true }
  });
  if (!existing) {
    throw notFound('Không tìm thấy lịch hẹn');
  }
  if (existing.patientId !== patientId) {
    throw forbidden('Bạn không có quyền hủy lịch hẹn này');
  }
  if (!['BOOKED', 'CHECKED_IN'].includes(existing.status)) {
    throw conflict('Không thể hủy lịch hẹn đã khám hoặc đã hủy trước đó');
  }

  const cancelled = await prisma.$transaction(async (tx) => {
    const updated = await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        status: 'CANCELLED',
        cancelReason: reason?.trim() || 'Bệnh nhân hủy lịch khám'
      },
      include: APPOINTMENT_FULL_INCLUDE
    });

    await tx.notification.create({
      data: {
        userId: existing.patient.userId,
        title: `Đã hủy lịch hẹn ${existing.appointmentCode}`,
        message: `Lịch khám ngày ${formatDateOnly(existing.appointmentDate)} (STT #${String(
          existing.queueNumber
        ).padStart(2, '0')}) đã được hủy.`,
        type: 'APPOINTMENT',
        payload: {
          appointmentId: updated.id,
          appointmentCode: updated.appointmentCode
        }
      }
    });

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'APPOINTMENT_CANCELLED',
        entityType: 'Appointment',
        entityId: updated.id,
        metadata: {
          preservedQueueNumber: existing.queueNumber,
          reason: updated.cancelReason
        }
      }
    });

    return updated;
  });

  return formatAppointmentDto(cancelled, null);
}

export async function createWalkInAppointment(
  input: {
    patientId?: string;
    newPatient?: {
      fullName: string;
      phone?: string;
      email?: string;
      dateOfBirth?: string;
      gender?: 'MALE' | 'FEMALE' | 'OTHER';
      insuranceNumber?: string;
      address?: string;
    };
    doctorId: string;
    date?: string;
    session: SessionType;
    isPriority?: boolean;
    chiefComplaint?: string;
    autoCheckIn?: boolean;
  },
  actorUserId: string
) {
  const bcrypt = await import('bcryptjs');
  const dateStr = input.date || getTodayDateString();

  const appt = await prisma.$transaction(async (tx) => {
    let targetPatientId = input.patientId;

    if (!targetPatientId) {
      if (!input.newPatient || !input.newPatient.fullName.trim()) {
        throw badRequest('Cần chọn bệnh nhân hoặc nhập họ tên bệnh nhân mới');
      }
      const count = await tx.patient.count();
      let seq = 8300 + count;
      let patientCode = generateSequentialCode('BN', seq, 5);
      while (await tx.patient.findUnique({ where: { patientCode } })) {
        seq += 1;
        patientCode = generateSequentialCode('BN', seq, 5);
      }

      const fallbackEmail =
        input.newPatient.email?.trim().toLowerCase() ||
        `${patientCode.toLowerCase()}.${Date.now()}@walkin.antam.vn`;
      const passwordHash = await bcrypt.hash('123456', 10);

      const newUser = await tx.user.create({
        data: {
          email: fallbackEmail,
          passwordHash,
          fullName: input.newPatient.fullName.trim(),
          phone: input.newPatient.phone?.trim() || null,
          role: 'PATIENT',
          patientProfile: {
            create: {
              patientCode,
              dateOfBirth: input.newPatient.dateOfBirth
                ? toDateOnly(input.newPatient.dateOfBirth)
                : null,
              gender: input.newPatient.gender || null,
              address: input.newPatient.address?.trim() || null,
              insuranceNumber: input.newPatient.insuranceNumber?.trim() || null,
              allergies: [],
              chronicConditions: []
            }
          }
        },
        include: { patientProfile: true }
      });
      targetPatientId = newUser.patientProfile!.id;
    }

    return allocateAndCreateAppointmentTx(tx, {
      patientId: targetPatientId,
      doctorId: input.doctorId,
      date: dateStr,
      session: input.session,
      bookingType: 'WALK_IN',
      bookingFlow: 'WALK_IN',
      chiefComplaint: input.chiefComplaint,
      isPriority: Boolean(input.isPriority),
      autoCheckIn: input.autoCheckIn !== false,
      allowAutoCreateSchedule: true,
      actorUserId
    });
  });

  const sttMap = await getLiveCurrentSttMap([appt]);
  const key = `${appt.doctorId}|${formatDateOnly(appt.appointmentDate)}|${appt.session}`;
  return formatAppointmentDto(appt, sttMap.get(key) ?? null);
}
