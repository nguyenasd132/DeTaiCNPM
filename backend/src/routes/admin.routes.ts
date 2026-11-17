import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validate';
import { generateCsvReport, getAdminDashboardData } from '../services/admin.service';
import { APPOINTMENT_FULL_INCLUDE, formatAppointmentDto } from '../services/appointment.service';
import { BED_INCLUDE, formatBedDto } from '../services/bed.service';
import { formatInvoiceDto, INVOICE_INCLUDE } from '../services/payment.service';
import { formatMedicalRecordDto, MEDICAL_RECORD_INCLUDE } from '../services/record.service';
import { AppointmentStatus, BedStatus, RecordStatus, RoomType, ServiceCategory, SessionType } from '../types';
import { generateSequentialCode } from '../utils/codes';
import { addDays, formatDateOnly, getSessionBounds, toDateOnly } from '../utils/date';
import { badRequest, conflict, notFound } from '../utils/errors';
import { sendSuccess } from '../utils/response';

const router = Router();

router.use(authenticate, requireRole('ADMIN'));

// Dashboard & Global Lookups
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
    const data = await getAdminDashboardData(date);
    return sendSuccess(res, data);
  })
);

router.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as AppointmentStatus)
        : undefined;
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const doctorId =
      typeof req.query.doctorId === 'string' && req.query.doctorId
        ? req.query.doctorId
        : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const where: Prisma.AppointmentWhereInput = {
      ...(date ? { appointmentDate: toDateOnly(date) } : {}),
      ...(!date && (from || to)
        ? {
            appointmentDate: {
              ...(from ? { gte: toDateOnly(from) } : {}),
              ...(to ? { lte: toDateOnly(to) } : {})
            }
          }
        : {}),
      ...(status ? { status } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(doctorId ? { doctorId } : {}),
      ...(search
        ? {
            OR: [
              { appointmentCode: { contains: search, mode: 'insensitive' } },
              { patient: { patientCode: { contains: search, mode: 'insensitive' } } },
              { patient: { user: { fullName: { contains: search, mode: 'insensitive' } } } },
              { doctor: { user: { fullName: { contains: search, mode: 'insensitive' } } } }
            ]
          }
        : {})
    };

    const [total, items] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        include: APPOINTMENT_FULL_INCLUDE,
        orderBy: [{ appointmentDate: 'desc' }, { session: 'asc' }, { queueNumber: 'asc' }],
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return sendSuccess(
      res,
      items.map((a) => formatAppointmentDto(a, null)),
      200,
      { total, page, limit }
    );
  })
);

router.get(
  '/patients',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const where: Prisma.PatientWhereInput = search
      ? {
          OR: [
            { patientCode: { contains: search, mode: 'insensitive' } },
            { user: { fullName: { contains: search, mode: 'insensitive' } } },
            { user: { email: { contains: search, mode: 'insensitive' } } },
            { user: { phone: { contains: search, mode: 'insensitive' } } },
            { insuranceNumber: { contains: search, mode: 'insensitive' } }
          ]
        }
      : {};

    const [total, patients] = await Promise.all([
      prisma.patient.count({ where }),
      prisma.patient.findMany({
        where,
        include: { user: true },
        orderBy: { patientCode: 'asc' },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    const data = patients.map((p) => ({
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
    }));

    return sendSuccess(res, data, 200, { total, page, limit });
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

    const [appointments, medicalRecords, invoices] = await Promise.all([
      prisma.appointment.findMany({
        where: { patientId: patient.id },
        include: APPOINTMENT_FULL_INCLUDE,
        orderBy: { appointmentDate: 'desc' }
      }),
      prisma.medicalRecord.findMany({
        where: { patientId: patient.id },
        include: MEDICAL_RECORD_INCLUDE,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.invoice.findMany({
        where: { patientId: patient.id },
        include: INVOICE_INCLUDE,
        orderBy: { createdAt: 'desc' }
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
      records: formattedRecords,
      invoices: invoices.map(formatInvoiceDto)
    });
  })
);

router.get(
  '/medical-records',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const doctorId =
      typeof req.query.doctorId === 'string' && req.query.doctorId
        ? req.query.doctorId
        : undefined;
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const status =
      req.query.status === 'DRAFT' || req.query.status === 'PUBLISHED'
        ? (req.query.status as RecordStatus)
        : undefined;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const where: Prisma.MedicalRecordWhereInput = {
      ...(doctorId ? { doctorId } : {}),
      ...(departmentId ? { appointment: { departmentId } } : {}),
      ...(status ? { status } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: toDateOnly(from) } : {}),
              ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {})
            }
          }
        : {}),
      ...(search
        ? {
            OR: [
              { recordCode: { contains: search, mode: 'insensitive' } },
              { diagnosis: { contains: search, mode: 'insensitive' } },
              { icdCode: { contains: search, mode: 'insensitive' } },
              { patient: { patientCode: { contains: search, mode: 'insensitive' } } },
              { patient: { user: { fullName: { contains: search, mode: 'insensitive' } } } }
            ]
          }
        : {})
    };

    const [total, records] = await Promise.all([
      prisma.medicalRecord.count({ where }),
      prisma.medicalRecord.findMany({
        where,
        include: MEDICAL_RECORD_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return sendSuccess(res, records.map(formatMedicalRecordDto), 200, { total, page, limit });
  })
);

// Departments CRUD
const departmentCreateSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  consultationFee: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional()
});
const departmentUpdateSchema = departmentCreateSchema.partial();

router.get(
  '/departments',
  asyncHandler(async (_req, res) => {
    const depts = await prisma.department.findMany({
      include: { _count: { select: { doctors: true, rooms: true, beds: true } } },
      orderBy: { name: 'asc' }
    });
    return sendSuccess(
      res,
      depts.map((d) => ({
        id: d.id,
        code: d.code,
        name: d.name,
        description: d.description,
        location: d.location,
        consultationFee: d.consultationFee,
        isActive: d.isActive,
        doctorCount: d._count.doctors,
        roomCount: d._count.rooms,
        bedCount: d._count.beds
      }))
    );
  })
);

router.post(
  '/departments',
  validateBody(departmentCreateSchema),
  asyncHandler(async (req, res) => {
    const created = await prisma.department.create({ data: req.body });
    return sendSuccess(res, created, 201);
  })
);

router.patch(
  '/departments/:id',
  validateBody(departmentUpdateSchema),
  asyncHandler(async (req, res) => {
    const updated = await prisma.department.update({
      where: { id: req.params.id },
      data: req.body
    });
    return sendSuccess(res, updated);
  })
);

router.delete(
  '/departments/:id',
  asyncHandler(async (req, res) => {
    const updated = await prisma.department.update({
      where: { id: req.params.id },
      data: { isActive: false }
    });
    return sendSuccess(res, updated);
  })
);

// Rooms CRUD
const roomCreateSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  roomType: z.enum(['EXAMINATION', 'INPATIENT_WARD', 'TRIAGE', 'PHARMACY', 'LAB']).optional(),
  floor: z.string().nullable().optional(),
  departmentId: z.string().min(1),
  isActive: z.boolean().optional()
});
const roomUpdateSchema = roomCreateSchema.partial();

router.get(
  '/rooms',
  asyncHandler(async (req, res) => {
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const roomType =
      typeof req.query.roomType === 'string' && req.query.roomType
        ? (req.query.roomType as RoomType)
        : undefined;

    const rooms = await prisma.room.findMany({
      where: {
        ...(departmentId ? { departmentId } : {}),
        ...(roomType ? { roomType } : {})
      },
      include: { department: true },
      orderBy: [{ department: { name: 'asc' } }, { code: 'asc' }]
    });

    return sendSuccess(
      res,
      rooms.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        roomType: r.roomType,
        floor: r.floor,
        departmentId: r.departmentId,
        departmentName: r.department.name,
        isActive: r.isActive
      }))
    );
  })
);

router.post(
  '/rooms',
  validateBody(roomCreateSchema),
  asyncHandler(async (req, res) => {
    const created = await prisma.room.create({
      data: req.body,
      include: { department: true }
    });
    return sendSuccess(
      res,
      { ...created, departmentName: created.department.name },
      201
    );
  })
);

router.patch(
  '/rooms/:id',
  validateBody(roomUpdateSchema),
  asyncHandler(async (req, res) => {
    const updated = await prisma.room.update({
      where: { id: req.params.id },
      data: req.body,
      include: { department: true }
    });
    return sendSuccess(res, { ...updated, departmentName: updated.department.name });
  })
);

router.delete(
  '/rooms/:id',
  asyncHandler(async (req, res) => {
    const updated = await prisma.room.update({
      where: { id: req.params.id },
      data: { isActive: false }
    });
    return sendSuccess(res, updated);
  })
);

// Beds CRUD
const bedCreateSchema = z.object({
  bedNumber: z.string().min(2),
  roomId: z.string().min(1),
  departmentId: z.string().optional(),
  status: z.enum(['AVAILABLE', 'MAINTENANCE']).optional(),
  notes: z.string().nullable().optional()
});
const bedUpdateSchema = bedCreateSchema.partial();

router.get(
  '/beds',
  asyncHandler(async (req, res) => {
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as BedStatus)
        : undefined;

    const beds = await prisma.bed.findMany({
      where: {
        ...(departmentId ? { departmentId } : {}),
        ...(status ? { status } : {})
      },
      include: BED_INCLUDE,
      orderBy: [{ department: { name: 'asc' } }, { bedNumber: 'asc' }]
    });
    return sendSuccess(res, beds.map(formatBedDto));
  })
);

router.post(
  '/beds',
  validateBody(bedCreateSchema),
  asyncHandler(async (req, res) => {
    const room = await prisma.room.findUnique({ where: { id: req.body.roomId } });
    if (!room) throw notFound('Không tìm thấy phòng bệnh');

    const created = await prisma.bed.create({
      data: {
        bedNumber: req.body.bedNumber,
        roomId: room.id,
        departmentId: req.body.departmentId || room.departmentId,
        status: req.body.status || 'AVAILABLE',
        notes: req.body.notes ?? null
      },
      include: BED_INCLUDE
    });
    return sendSuccess(res, formatBedDto(created), 201);
  })
);

router.patch(
  '/beds/:id',
  validateBody(bedUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.bed.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Không tìm thấy giường bệnh');
    if (existing.status === 'OCCUPIED' && req.body.status) {
      throw conflict('Không thể đổi trạng thái giường đang có bệnh nhân');
    }

    let resolvedDeptId = req.body.departmentId;
    if (req.body.roomId && !resolvedDeptId) {
      const room = await prisma.room.findUnique({ where: { id: req.body.roomId } });
      if (!room) throw notFound('Không tìm thấy phòng bệnh');
      resolvedDeptId = room.departmentId;
    }

    const updated = await prisma.bed.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        ...(resolvedDeptId ? { departmentId: resolvedDeptId } : {})
      },
      include: BED_INCLUDE
    });
    return sendSuccess(res, formatBedDto(updated));
  })
);

router.delete(
  '/beds/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.bed.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Không tìm thấy giường bệnh');
    if (existing.status === 'OCCUPIED' || existing.currentPatientId) {
      throw conflict('Không thể xóa giường đang có bệnh nhân nằm');
    }
    await prisma.bed.delete({ where: { id: req.params.id } });
    return sendSuccess(res, { deleted: true, id: req.params.id });
  })
);

// Doctors CRUD
const doctorCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).default('123456'),
  fullName: z.string().min(2),
  phone: z.string().optional(),
  doctorCode: z.string().optional(),
  departmentId: z.string().min(1),
  roomId: z.string().nullable().optional(),
  specialty: z.string().min(2),
  title: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  yearsOfExperience: z.number().int().nonnegative().optional(),
  consultationFee: z.number().int().nonnegative().optional(),
  isOnDuty: z.boolean().optional()
});

const doctorUpdateSchema = z.object({
  fullName: z.string().min(2).optional(),
  phone: z.string().nullable().optional(),
  departmentId: z.string().optional(),
  roomId: z.string().nullable().optional(),
  specialty: z.string().optional(),
  title: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  yearsOfExperience: z.number().int().nonnegative().optional(),
  consultationFee: z.number().int().nonnegative().optional(),
  isOnDuty: z.boolean().optional(),
  isActive: z.boolean().optional()
});

router.get(
  '/doctors',
  asyncHandler(async (req, res) => {
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const doctors = await prisma.doctor.findMany({
      where: {
        ...(departmentId ? { departmentId } : {}),
        ...(search
          ? {
              OR: [
                { doctorCode: { contains: search, mode: 'insensitive' } },
                { specialty: { contains: search, mode: 'insensitive' } },
                { user: { fullName: { contains: search, mode: 'insensitive' } } }
              ]
            }
          : {})
      },
      include: { user: true, department: true, room: true },
      orderBy: { doctorCode: 'asc' }
    });

    return sendSuccess(
      res,
      doctors.map((d) => ({
        id: d.id,
        userId: d.userId,
        doctorCode: d.doctorCode,
        fullName: d.user.fullName,
        email: d.user.email,
        phone: d.user.phone,
        avatarUrl: d.user.avatarUrl,
        title: d.title,
        specialty: d.specialty,
        bio: d.bio,
        yearsOfExperience: d.yearsOfExperience,
        consultationFee: d.consultationFee,
        isOnDuty: d.isOnDuty,
        isActive: d.user.isActive,
        department: { id: d.department.id, code: d.department.code, name: d.department.name },
        room: d.room
          ? { id: d.room.id, code: d.room.code, name: d.room.name, floor: d.room.floor }
          : null
      }))
    );
  })
);

router.post(
  '/doctors',
  validateBody(doctorCreateSchema),
  asyncHandler(async (req, res) => {
    const email = req.body.email.trim().toLowerCase();
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) throw conflict('Email đã được sử dụng');

    const passwordHash = await bcrypt.hash(req.body.password || '123456', 10);
    const created = await prisma.$transaction(async (tx) => {
      const count = await tx.doctor.count();
      const doctorCode = req.body.doctorCode || generateSequentialCode('BS', count + 1, 3);
      return tx.doctor.create({
        data: {
          doctorCode,
          specialty: req.body.specialty,
          title: req.body.title || null,
          bio: req.body.bio || null,
          yearsOfExperience: req.body.yearsOfExperience ?? 5,
          consultationFee: req.body.consultationFee ?? 150000,
          isOnDuty: req.body.isOnDuty ?? true,
          department: { connect: { id: req.body.departmentId } },
          ...(req.body.roomId ? { room: { connect: { id: req.body.roomId } } } : {}),
          user: {
            create: {
              email,
              passwordHash,
              fullName: req.body.fullName.trim(),
              phone: req.body.phone?.trim() || null,
              role: 'DOCTOR',
              isActive: true
            }
          }
        },
        include: { user: true, department: true, room: true }
      });
    });

    return sendSuccess(
      res,
      {
        id: created.id,
        userId: created.userId,
        doctorCode: created.doctorCode,
        fullName: created.user.fullName,
        email: created.user.email,
        phone: created.user.phone,
        avatarUrl: created.user.avatarUrl,
        title: created.title,
        specialty: created.specialty,
        bio: created.bio,
        yearsOfExperience: created.yearsOfExperience,
        consultationFee: created.consultationFee,
        isOnDuty: created.isOnDuty,
        isActive: created.user.isActive,
        department: {
          id: created.department.id,
          code: created.department.code,
          name: created.department.name
        },
        room: created.room
          ? {
              id: created.room.id,
              code: created.room.code,
              name: created.room.name,
              floor: created.room.floor
            }
          : null
      },
      201
    );
  })
);

router.patch(
  '/doctors/:id',
  validateBody(doctorUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.doctor.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Không tìm thấy bác sĩ');

    const updated = await prisma.$transaction(async (tx) => {
      if (
        req.body.fullName !== undefined ||
        req.body.phone !== undefined ||
        req.body.isActive !== undefined
      ) {
        await tx.user.update({
          where: { id: existing.userId },
          data: {
            ...(req.body.fullName !== undefined ? { fullName: req.body.fullName.trim() } : {}),
            ...(req.body.phone !== undefined ? { phone: req.body.phone } : {}),
            ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {})
          }
        });
      }

      return tx.doctor.update({
        where: { id: existing.id },
        data: {
          ...(req.body.departmentId !== undefined ? { departmentId: req.body.departmentId } : {}),
          ...(req.body.roomId !== undefined ? { roomId: req.body.roomId || null } : {}),
          ...(req.body.specialty !== undefined ? { specialty: req.body.specialty } : {}),
          ...(req.body.title !== undefined ? { title: req.body.title } : {}),
          ...(req.body.bio !== undefined ? { bio: req.body.bio } : {}),
          ...(req.body.yearsOfExperience !== undefined
            ? { yearsOfExperience: req.body.yearsOfExperience }
            : {}),
          ...(req.body.consultationFee !== undefined
            ? { consultationFee: req.body.consultationFee }
            : {}),
          ...(req.body.isOnDuty !== undefined ? { isOnDuty: req.body.isOnDuty } : {})
        },
        include: { user: true, department: true, room: true }
      });
    });

    return sendSuccess(res, {
      id: updated.id,
      userId: updated.userId,
      doctorCode: updated.doctorCode,
      fullName: updated.user.fullName,
      email: updated.user.email,
      phone: updated.user.phone,
      avatarUrl: updated.user.avatarUrl,
      title: updated.title,
      specialty: updated.specialty,
      bio: updated.bio,
      yearsOfExperience: updated.yearsOfExperience,
      consultationFee: updated.consultationFee,
      isOnDuty: updated.isOnDuty,
      isActive: updated.user.isActive,
      department: {
        id: updated.department.id,
        code: updated.department.code,
        name: updated.department.name
      },
      room: updated.room
        ? {
            id: updated.room.id,
            code: updated.room.code,
            name: updated.room.name,
            floor: updated.room.floor
          }
        : null
    });
  })
);

router.delete(
  '/doctors/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.doctor.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Không tìm thấy bác sĩ');
    await prisma.$transaction([
      prisma.user.update({ where: { id: existing.userId }, data: { isActive: false } }),
      prisma.doctor.update({ where: { id: existing.id }, data: { isOnDuty: false } })
    ]);
    return sendSuccess(res, { id: existing.id, isActive: false, deleted: true });
  })
);

// Nurses CRUD
const nurseCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).default('123456'),
  fullName: z.string().min(2),
  phone: z.string().optional(),
  nurseCode: z.string().optional(),
  departmentId: z.string().min(1),
  shift: z.string().optional()
});
const nurseUpdateSchema = z.object({
  fullName: z.string().min(2).optional(),
  phone: z.string().nullable().optional(),
  departmentId: z.string().optional(),
  shift: z.string().nullable().optional(),
  isActive: z.boolean().optional()
});

router.get(
  '/nurses',
  asyncHandler(async (req, res) => {
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const nurses = await prisma.nurse.findMany({
      where: {
        ...(departmentId ? { departmentId } : {}),
        ...(search
          ? {
              OR: [
                { nurseCode: { contains: search, mode: 'insensitive' } },
                { user: { fullName: { contains: search, mode: 'insensitive' } } }
              ]
            }
          : {})
      },
      include: { user: true, department: true },
      orderBy: { nurseCode: 'asc' }
    });

    return sendSuccess(
      res,
      nurses.map((n) => ({
        id: n.id,
        userId: n.userId,
        nurseCode: n.nurseCode,
        fullName: n.user.fullName,
        email: n.user.email,
        phone: n.user.phone,
        shift: n.shift,
        isActive: n.user.isActive,
        department: { id: n.department.id, code: n.department.code, name: n.department.name }
      }))
    );
  })
);

router.post(
  '/nurses',
  validateBody(nurseCreateSchema),
  asyncHandler(async (req, res) => {
    const email = req.body.email.trim().toLowerCase();
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) throw conflict('Email đã được sử dụng');

    const passwordHash = await bcrypt.hash(req.body.password || '123456', 10);
    const created = await prisma.$transaction(async (tx) => {
      const count = await tx.nurse.count();
      const nurseCode = req.body.nurseCode || generateSequentialCode('DD', count + 1, 3);
      return tx.nurse.create({
        data: {
          nurseCode,
          shift: req.body.shift || 'FULL_DAY',
          department: { connect: { id: req.body.departmentId } },
          user: {
            create: {
              email,
              passwordHash,
              fullName: req.body.fullName.trim(),
              phone: req.body.phone?.trim() || null,
              role: 'NURSE',
              isActive: true
            }
          }
        },
        include: { user: true, department: true }
      });
    });

    return sendSuccess(
      res,
      {
        id: created.id,
        userId: created.userId,
        nurseCode: created.nurseCode,
        fullName: created.user.fullName,
        email: created.user.email,
        phone: created.user.phone,
        shift: created.shift,
        isActive: created.user.isActive,
        department: {
          id: created.department.id,
          code: created.department.code,
          name: created.department.name
        }
      },
      201
    );
  })
);

router.patch(
  '/nurses/:id',
  validateBody(nurseUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.nurse.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Không tìm thấy điều dưỡng');

    const updated = await prisma.$transaction(async (tx) => {
      if (
        req.body.fullName !== undefined ||
        req.body.phone !== undefined ||
        req.body.isActive !== undefined
      ) {
        await tx.user.update({
          where: { id: existing.userId },
          data: {
            ...(req.body.fullName !== undefined ? { fullName: req.body.fullName.trim() } : {}),
            ...(req.body.phone !== undefined ? { phone: req.body.phone } : {}),
            ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {})
          }
        });
      }
      return tx.nurse.update({
        where: { id: existing.id },
        data: {
          ...(req.body.departmentId !== undefined ? { departmentId: req.body.departmentId } : {}),
          ...(req.body.shift !== undefined ? { shift: req.body.shift } : {})
        },
        include: { user: true, department: true }
      });
    });

    return sendSuccess(res, {
      id: updated.id,
      userId: updated.userId,
      nurseCode: updated.nurseCode,
      fullName: updated.user.fullName,
      email: updated.user.email,
      phone: updated.user.phone,
      shift: updated.shift,
      isActive: updated.user.isActive,
      department: {
        id: updated.department.id,
        code: updated.department.code,
        name: updated.department.name
      }
    });
  })
);

router.delete(
  '/nurses/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.nurse.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Không tìm thấy điều dưỡng');
    await prisma.user.update({ where: { id: existing.userId }, data: { isActive: false } });
    return sendSuccess(res, { id: existing.id, isActive: false });
  })
);

// Schedules
const createScheduleSchema = z.object({
  doctorId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sessions: z.array(z.enum(['MORNING', 'AFTERNOON'])).optional(),
  maxPatients: z.number().int().min(1).max(100).optional(),
  avgMinutesPerPatient: z.number().int().min(5).max(60).optional(),
  isAvailable: z.boolean().optional(),
  notes: z.string().nullable().optional()
});

const patchScheduleSchema = z.object({
  maxPatients: z.number().int().min(1).max(100).optional(),
  avgMinutesPerPatient: z.number().int().min(5).max(60).optional(),
  isAvailable: z.boolean().optional(),
  notes: z.string().nullable().optional()
});

router.get(
  '/schedules',
  asyncHandler(async (req, res) => {
    const doctorId =
      typeof req.query.doctorId === 'string' && req.query.doctorId
        ? req.query.doctorId
        : undefined;
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;

    const schedules = await prisma.doctorSchedule.findMany({
      where: {
        ...(doctorId ? { doctorId } : {}),
        ...(departmentId ? { doctor: { departmentId } } : {}),
        ...(from || to
          ? {
              scheduleDate: {
                ...(from ? { gte: toDateOnly(from) } : {}),
                ...(to ? { lte: toDateOnly(to) } : {})
              }
            }
          : {})
      },
      include: {
        doctor: { include: { user: true, department: true } },
        _count: { select: { appointments: { where: { status: { not: 'CANCELLED' } } } } }
      },
      orderBy: [{ scheduleDate: 'asc' }, { session: 'asc' }]
    });

    return sendSuccess(
      res,
      schedules.map((s) => ({
        id: s.id,
        doctorId: s.doctorId,
        doctorName: s.doctor.user.fullName,
        departmentName: s.doctor.department.name,
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
      }))
    );
  })
);

router.post(
  '/schedules',
  validateBody(createScheduleSchema),
  asyncHandler(async (req, res) => {
    const startStr = req.body.date || req.body.fromDate;
    const endStr = req.body.date || req.body.toDate || startStr;
    if (!startStr || !endStr) {
      throw badRequest('Cần cung cấp date hoặc fromDate/toDate');
    }

    const sessions: SessionType[] =
      req.body.sessions && req.body.sessions.length > 0
        ? req.body.sessions
        : ['MORNING', 'AFTERNOON'];

    const dates: string[] = [];
    let cursor = startStr;
    while (cursor <= endStr && dates.length < 31) {
      dates.push(cursor);
      cursor = addDays(cursor, 1);
    }

    const created = [];
    for (const dateStr of dates) {
      const scheduleDate = toDateOnly(dateStr);
      for (const session of sessions) {
        const bounds = getSessionBounds(session);
        const sched = await prisma.doctorSchedule.upsert({
          where: {
            doctorId_scheduleDate_session: {
              doctorId: req.body.doctorId,
              scheduleDate,
              session
            }
          },
          create: {
            doctorId: req.body.doctorId,
            scheduleDate,
            session,
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
            doctor: { include: { user: true, department: true } },
            _count: { select: { appointments: { where: { status: { not: 'CANCELLED' } } } } }
          }
        });
        created.push({
          id: sched.id,
          doctorId: sched.doctorId,
          doctorName: sched.doctor.user.fullName,
          departmentName: sched.doctor.department.name,
          scheduleDate: formatDateOnly(sched.scheduleDate),
          session: sched.session,
          startTime: sched.startTime,
          endTime: sched.endTime,
          maxPatients: sched.maxPatients,
          avgMinutesPerPatient: sched.avgMinutesPerPatient,
          lastQueueNumber: sched.lastQueueNumber,
          bookedCount: sched._count.appointments,
          isAvailable: sched.isAvailable,
          notes: sched.notes
        });
      }
    }

    return sendSuccess(res, created, 201);
  })
);

router.patch(
  '/schedules/:id',
  validateBody(patchScheduleSchema),
  asyncHandler(async (req, res) => {
    const updated = await prisma.doctorSchedule.update({
      where: { id: req.params.id },
      data: req.body,
      include: {
        doctor: { include: { user: true, department: true } },
        _count: { select: { appointments: { where: { status: { not: 'CANCELLED' } } } } }
      }
    });
    return sendSuccess(res, {
      id: updated.id,
      doctorId: updated.doctorId,
      doctorName: updated.doctor.user.fullName,
      departmentName: updated.doctor.department.name,
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

// Medicines CRUD
const medicineCreateSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  genericName: z.string().nullable().optional(),
  unit: z.string().min(1),
  unitPrice: z.number().int().nonnegative(),
  stockQuantity: z.number().int().nonnegative().optional(),
  dosageForm: z.string().nullable().optional(),
  contraindications: z
    .object({
      allergens: z.array(z.string()).optional(),
      conditions: z.array(z.string()).optional(),
      warningText: z.string().optional()
    })
    .optional(),
  manufacturer: z.string().nullable().optional(),
  isActive: z.boolean().optional()
});
const medicineUpdateSchema = medicineCreateSchema.partial();

router.get(
  '/medicines',
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const medicines = await prisma.medicine.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { genericName: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      orderBy: { name: 'asc' }
    });
    return sendSuccess(res, medicines);
  })
);

router.post(
  '/medicines',
  validateBody(medicineCreateSchema),
  asyncHandler(async (req, res) => {
    const created = await prisma.medicine.create({
      data: {
        ...req.body,
        contraindications: (req.body.contraindications || {}) as unknown as Prisma.InputJsonValue
      }
    });
    return sendSuccess(res, created, 201);
  })
);

router.patch(
  '/medicines/:id',
  validateBody(medicineUpdateSchema),
  asyncHandler(async (req, res) => {
    const updated = await prisma.medicine.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        ...(req.body.contraindications !== undefined
          ? { contraindications: req.body.contraindications as unknown as Prisma.InputJsonValue }
          : {})
      }
    });
    return sendSuccess(res, updated);
  })
);

router.delete(
  '/medicines/:id',
  asyncHandler(async (req, res) => {
    const updated = await prisma.medicine.update({
      where: { id: req.params.id },
      data: { isActive: false }
    });
    return sendSuccess(res, updated);
  })
);

// Services CRUD
const serviceCreateSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  category: z.enum(['CONSULTATION', 'LAB_TEST', 'IMAGING', 'PROCEDURE']),
  departmentId: z.string().nullable().optional(),
  unitPrice: z.number().int().nonnegative(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional()
});
const serviceUpdateSchema = serviceCreateSchema.partial();

router.get(
  '/services',
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const category =
      typeof req.query.category === 'string' && req.query.category
        ? (req.query.category as ServiceCategory)
        : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const services = await prisma.service.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...(category ? { category } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      include: { department: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }]
    });

    return sendSuccess(
      res,
      services.map((s) => ({
        ...s,
        departmentName: s.department ? s.department.name : null
      }))
    );
  })
);

router.post(
  '/services',
  validateBody(serviceCreateSchema),
  asyncHandler(async (req, res) => {
    const created = await prisma.service.create({
      data: {
        ...req.body,
        departmentId: req.body.departmentId || null
      },
      include: { department: true }
    });
    return sendSuccess(
      res,
      { ...created, departmentName: created.department ? created.department.name : null },
      201
    );
  })
);

router.patch(
  '/services/:id',
  validateBody(serviceUpdateSchema),
  asyncHandler(async (req, res) => {
    const updated = await prisma.service.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        ...(req.body.departmentId !== undefined
          ? { departmentId: req.body.departmentId || null }
          : {})
      },
      include: { department: true }
    });
    return sendSuccess(res, {
      ...updated,
      departmentName: updated.department ? updated.department.name : null
    });
  })
);

router.delete(
  '/services/:id',
  asyncHandler(async (req, res) => {
    const updated = await prisma.service.update({
      where: { id: req.params.id },
      data: { isActive: false }
    });
    return sendSuccess(res, { ...updated, deleted: true });
  })
);

// CSV Report Export
router.get(
  '/reports/export',
  asyncHandler(async (req, res) => {
    const rawType = typeof req.query.type === 'string' ? req.query.type : 'appointments';
    const type = ['appointments', 'revenue', 'beds', 'patients'].includes(rawType)
      ? (rawType as 'appointments' | 'revenue' | 'beds' | 'patients')
      : 'appointments';
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;

    const { filename, csv } = await generateCsvReport(type, from, to);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  })
);

export default router;
