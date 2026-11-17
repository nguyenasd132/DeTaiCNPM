import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import {
  APPOINTMENT_FULL_INCLUDE,
  bookOutpatientAppointment,
  cancelPatientAppointment,
  formatAppointmentDto,
  getLiveCurrentSttMap,
  reschedulePatientAppointment
} from '../services/appointment.service';
import {
  formatInvoiceDto,
  initiatePatientPayment,
  INVOICE_INCLUDE
} from '../services/payment.service';
import {
  formatMedicalRecordDto,
  formatPrescriptionDto,
  MEDICAL_RECORD_INCLUDE,
  PRESCRIPTION_INCLUDE
} from '../services/record.service';
import { AppointmentStatus, InvoiceStatus, InvoiceType } from '../types';
import { formatDateOnly, getTodayDateString, toDateOnly } from '../utils/date';
import { forbidden, notFound } from '../utils/errors';
import { sendSuccess } from '../utils/response';

const router = Router();

router.use(authenticate, requireRole('PATIENT'));

async function getPatientByUserId(userId: string) {
  const patient = await prisma.patient.findUnique({
    where: { userId },
    include: { user: true }
  });
  if (!patient) {
    throw notFound('Không tìm thấy hồ sơ bệnh nhân');
  }
  return patient;
}

function formatPatientProfile(patient: {
  id: string;
  userId: string;
  patientCode: string;
  dateOfBirth: Date | null;
  gender: string | null;
  address: string | null;
  nationalId: string | null;
  insuranceNumber: string | null;
  bloodType: string | null;
  allergies: unknown;
  chronicConditions: unknown;
  emergencyContact: unknown;
  user: { fullName: string; email: string; phone: string | null };
}) {
  return {
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
  };
}

const updatePatientProfileSchema = z.object({
  fullName: z.string().min(2).optional(),
  phone: z.string().nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable().optional(),
  address: z.string().nullable().optional(),
  nationalId: z.string().nullable().optional(),
  insuranceNumber: z.string().nullable().optional(),
  bloodType: z.string().nullable().optional(),
  allergies: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          severity: z.enum(['MILD', 'MODERATE', 'SEVERE']).optional(),
          reaction: z.string().optional()
        })
      ])
    )
    .optional(),
  chronicConditions: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          diagnosedYear: z.number().int().optional(),
          notes: z.string().optional()
        })
      ])
    )
    .optional(),
  emergencyContact: z
    .object({
      name: z.string(),
      relationship: z.string(),
      phone: z.string()
    })
    .nullable()
    .optional()
});

const createAppointmentSchema = z.object({
  doctorId: z.string().min(1, 'Vui lòng chọn bác sĩ'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày khám phải theo định dạng YYYY-MM-DD'),
  session: z.enum(['MORNING', 'AFTERNOON']),
  bookingFlow: z.enum(['BY_DEPARTMENT', 'BY_DOCTOR', 'BY_DATE']).optional(),
  chiefComplaint: z.string().optional()
});

const rescheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày khám phải theo định dạng YYYY-MM-DD'),
  session: z.enum(['MORNING', 'AFTERNOON']),
  doctorId: z.string().optional()
});

const cancelSchema = z.object({
  reason: z.string().optional()
});

const initiatePaymentSchema = z.object({
  invoiceId: z.string().min(1, 'Thiếu mã hóa đơn'),
  method: z.enum(['QR_TRANSFER', 'COUNTER_CASH']),
  notes: z.string().optional()
});

router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    return sendSuccess(res, formatPatientProfile(patient));
  })
);

const handleProfileUpdate = asyncHandler(async (req, res) => {
  const patient = await getPatientByUserId(req.user!.userId);
  const body = req.body as z.infer<typeof updatePatientProfileSchema>;

  const updated = await prisma.$transaction(async (tx) => {
    if (body.fullName !== undefined || body.phone !== undefined) {
      await tx.user.update({
        where: { id: patient.userId },
        data: {
          ...(body.fullName !== undefined ? { fullName: body.fullName.trim() } : {}),
          ...(body.phone !== undefined ? { phone: body.phone ? body.phone.trim() : null } : {})
        }
      });
    }

    return tx.patient.update({
      where: { id: patient.id },
      data: {
        ...(body.dateOfBirth !== undefined
          ? { dateOfBirth: body.dateOfBirth ? toDateOnly(body.dateOfBirth) : null }
          : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.nationalId !== undefined ? { nationalId: body.nationalId } : {}),
        ...(body.insuranceNumber !== undefined ? { insuranceNumber: body.insuranceNumber } : {}),
        ...(body.bloodType !== undefined ? { bloodType: body.bloodType } : {}),
        ...(body.allergies !== undefined
          ? { allergies: body.allergies as unknown as Prisma.InputJsonValue }
          : {}),
        ...(body.chronicConditions !== undefined
          ? { chronicConditions: body.chronicConditions as unknown as Prisma.InputJsonValue }
          : {}),
        ...(body.emergencyContact !== undefined
          ? {
              emergencyContact:
                body.emergencyContact === null
                  ? Prisma.JsonNull
                  : (body.emergencyContact as unknown as Prisma.InputJsonValue)
            }
          : {})
      },
      include: { user: true }
    });
  });

  return sendSuccess(res, formatPatientProfile(updated));
});

router.put('/profile', validateBody(updatePatientProfileSchema), handleProfileUpdate);
router.patch('/profile', validateBody(updatePatientProfileSchema), handleProfileUpdate);

router.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as AppointmentStatus)
        : undefined;
    const upcoming = req.query.upcoming === 'true';
    const today = toDateOnly(getTodayDateString());

    const appointments = await prisma.appointment.findMany({
      where: {
        patientId: patient.id,
        ...(status ? { status } : {}),
        ...(upcoming
          ? {
              appointmentDate: { gte: today },
              status: { in: ['BOOKED', 'CHECKED_IN', 'IN_PROGRESS'] }
            }
          : {})
      },
      include: APPOINTMENT_FULL_INCLUDE,
      orderBy: upcoming
        ? [{ appointmentDate: 'asc' }, { session: 'asc' }, { queueNumber: 'asc' }]
        : [{ appointmentDate: 'desc' }, { createdAt: 'desc' }]
    });

    const sttMap = await getLiveCurrentSttMap(appointments);
    const data = appointments.map((a) => {
      const key = `${a.doctorId}|${formatDateOnly(a.appointmentDate)}|${a.session}`;
      return formatAppointmentDto(a, sttMap.get(key) ?? null);
    });

    return sendSuccess(res, data);
  })
);

router.post(
  '/appointments',
  validateBody(createAppointmentSchema),
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const dto = await bookOutpatientAppointment({
      patientId: patient.id,
      doctorId: req.body.doctorId,
      date: req.body.date,
      session: req.body.session,
      bookingType: 'ONLINE',
      bookingFlow: req.body.bookingFlow || 'BY_DEPARTMENT',
      chiefComplaint: req.body.chiefComplaint,
      actorUserId: req.user!.userId
    });
    return sendSuccess(res, dto, 201);
  })
);

router.get(
  '/appointments/:id',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const appt = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: {
        ...APPOINTMENT_FULL_INCLUDE,
        medicalRecord: { include: MEDICAL_RECORD_INCLUDE },
        invoices: { include: INVOICE_INCLUDE }
      }
    });
    if (!appt) throw notFound('Không tìm thấy lịch hẹn');
    if (appt.patientId !== patient.id) {
      throw forbidden('Bạn không có quyền xem lịch hẹn này');
    }

    const sttMap = await getLiveCurrentSttMap([appt]);
    const key = `${appt.doctorId}|${formatDateOnly(appt.appointmentDate)}|${appt.session}`;

    return sendSuccess(res, {
      ...formatAppointmentDto(appt, sttMap.get(key) ?? null),
      medicalRecord:
        appt.medicalRecord && appt.medicalRecord.status === 'PUBLISHED'
          ? formatMedicalRecordDto(appt.medicalRecord)
          : null,
      invoices: appt.invoices.map(formatInvoiceDto)
    });
  })
);

router.patch(
  '/appointments/:id/reschedule',
  validateBody(rescheduleSchema),
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const dto = await reschedulePatientAppointment(
      patient.id,
      req.params.id,
      req.body,
      req.user!.userId
    );
    return sendSuccess(res, dto);
  })
);

router.patch(
  '/appointments/:id/cancel',
  validateBody(cancelSchema),
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const dto = await cancelPatientAppointment(
      patient.id,
      req.params.id,
      req.body.reason,
      req.user!.userId
    );
    return sendSuccess(res, dto);
  })
);

router.get(
  '/records',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const records = await prisma.medicalRecord.findMany({
      where: { patientId: patient.id, status: 'PUBLISHED' },
      include: MEDICAL_RECORD_INCLUDE,
      orderBy: { createdAt: 'desc' }
    });
    return sendSuccess(res, records.map(formatMedicalRecordDto));
  })
);

router.get(
  '/records/:id',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const record = await prisma.medicalRecord.findUnique({
      where: { id: req.params.id },
      include: MEDICAL_RECORD_INCLUDE
    });
    if (!record || record.status !== 'PUBLISHED') {
      throw notFound('Không tìm thấy kết quả khám');
    }
    if (record.patientId !== patient.id) {
      throw forbidden('Bạn không có quyền xem hồ sơ này');
    }
    return sendSuccess(res, formatMedicalRecordDto(record));
  })
);

router.get(
  '/prescriptions',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const prescriptions = await prisma.prescription.findMany({
      where: { patientId: patient.id },
      include: PRESCRIPTION_INCLUDE,
      orderBy: { createdAt: 'desc' }
    });
    return sendSuccess(res, prescriptions.map(formatPrescriptionDto));
  })
);

router.get(
  '/prescriptions/:id',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const rx = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: PRESCRIPTION_INCLUDE
    });
    if (!rx) throw notFound('Không tìm thấy đơn thuốc');
    if (rx.patientId !== patient.id) {
      throw forbidden('Bạn không có quyền xem đơn thuốc này');
    }
    return sendSuccess(res, formatPrescriptionDto(rx));
  })
);

router.get(
  '/invoices',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const type =
      req.query.type === 'HOSPITAL_FEE' || req.query.type === 'PRESCRIPTION'
        ? (req.query.type as InvoiceType)
        : undefined;
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as InvoiceStatus)
        : undefined;

    const invoices = await prisma.invoice.findMany({
      where: {
        patientId: patient.id,
        ...(type ? { invoiceType: type } : {}),
        ...(status ? { status } : {})
      },
      include: INVOICE_INCLUDE,
      orderBy: { createdAt: 'desc' }
    });
    return sendSuccess(res, invoices.map(formatInvoiceDto));
  })
);

router.get(
  '/invoices/:id',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const inv = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: INVOICE_INCLUDE
    });
    if (!inv) throw notFound('Không tìm thấy hóa đơn');
    if (inv.patientId !== patient.id) {
      throw forbidden('Bạn không có quyền xem hóa đơn này');
    }
    return sendSuccess(res, formatInvoiceDto(inv));
  })
);

router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const payments = await prisma.payment.findMany({
      where: { patientId: patient.id },
      include: {
        invoice: { select: { invoiceCode: true } },
        confirmedByNurse: { include: { user: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const data = payments.map((p) => ({
      id: p.id,
      paymentCode: p.paymentCode,
      invoiceId: p.invoiceId,
      invoiceCode: p.invoice.invoiceCode,
      patientId: p.patientId,
      patientCode: patient.patientCode,
      patientName: patient.user.fullName,
      amount: p.amount,
      method: p.method,
      status: p.status,
      qrReference: p.qrReference,
      confirmedByNurseName: p.confirmedByNurse ? p.confirmedByNurse.user.fullName : null,
      confirmedAt: p.confirmedAt ? p.confirmedAt.toISOString() : null,
      notes: p.notes,
      createdAt: p.createdAt.toISOString()
    }));

    return sendSuccess(res, data);
  })
);

router.post(
  '/payments',
  validateBody(initiatePaymentSchema),
  asyncHandler(async (req, res) => {
    const patient = await getPatientByUserId(req.user!.userId);
    const result = await initiatePatientPayment(patient.id, req.user!.userId, req.body);
    return sendSuccess(res, result, 201);
  })
);

export default router;
