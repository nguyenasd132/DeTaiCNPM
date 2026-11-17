import { Router } from 'express';
import { prisma } from '../config/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { getAvailability } from '../services/appointment.service';
import { ServiceCategory, SessionType } from '../types';
import { sendSuccess } from '../utils/response';

const router = Router();

router.get(
  '/departments',
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const departments = await prisma.department.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: {
        _count: {
          select: {
            doctors: { where: { user: { isActive: true } } }
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    const data = departments.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      description: d.description,
      location: d.location,
      consultationFee: d.consultationFee,
      isActive: d.isActive,
      doctorCount: d._count.doctors
    }));

    return sendSuccess(res, data);
  })
);

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
    const onDuty =
      req.query.onDuty === 'true' ? true : req.query.onDuty === 'false' ? false : undefined;

    const doctors = await prisma.doctor.findMany({
      where: {
        user: { isActive: true },
        ...(departmentId ? { departmentId } : {}),
        ...(onDuty !== undefined ? { isOnDuty: onDuty } : {}),
        ...(search
          ? {
              OR: [
                { user: { fullName: { contains: search, mode: 'insensitive' } } },
                { specialty: { contains: search, mode: 'insensitive' } },
                { doctorCode: { contains: search, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      include: {
        user: true,
        department: true,
        room: true
      },
      orderBy: [{ department: { name: 'asc' } }, { user: { fullName: 'asc' } }]
    });

    const data = doctors.map((d) => ({
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
      department: {
        id: d.department.id,
        code: d.department.code,
        name: d.department.name
      },
      room: d.room
        ? {
            id: d.room.id,
            code: d.room.code,
            name: d.room.name,
            floor: d.room.floor
          }
        : null
    }));

    return sendSuccess(res, data);
  })
);

router.get(
  '/schedules/availability',
  asyncHandler(async (req, res) => {
    const flow = typeof req.query.flow === 'string' ? req.query.flow : undefined;
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const doctorId =
      typeof req.query.doctorId === 'string' && req.query.doctorId
        ? req.query.doctorId
        : undefined;
    const date =
      typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
    const fromDate =
      typeof req.query.fromDate === 'string' && req.query.fromDate
        ? req.query.fromDate
        : undefined;
    const toDate =
      typeof req.query.toDate === 'string' && req.query.toDate ? req.query.toDate : undefined;
    const session =
      req.query.session === 'MORNING' || req.query.session === 'AFTERNOON'
        ? (req.query.session as SessionType)
        : undefined;

    const availability = await getAvailability({
      flow,
      departmentId,
      doctorId,
      date,
      fromDate,
      toDate,
      session
    });

    return sendSuccess(res, availability);
  })
);

router.get(
  '/services',
  asyncHandler(async (req, res) => {
    const category =
      typeof req.query.category === 'string' && req.query.category
        ? (req.query.category as ServiceCategory)
        : undefined;
    const departmentId =
      typeof req.query.departmentId === 'string' && req.query.departmentId
        ? req.query.departmentId
        : undefined;
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;

    const services = await prisma.service.findMany({
      where: {
        isActive: true,
        ...(category ? { category } : {}),
        ...(departmentId ? { departmentId } : {}),
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

    const data = services.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      category: s.category,
      departmentId: s.departmentId,
      departmentName: s.department ? s.department.name : null,
      unitPrice: s.unitPrice,
      description: s.description,
      isActive: s.isActive
    }));

    return sendSuccess(res, data);
  })
);

router.get(
  '/medicines',
  authenticate,
  requireRole('DOCTOR', 'NURSE', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const search =
      typeof req.query.search === 'string' && req.query.search.trim()
        ? req.query.search.trim()
        : undefined;
    const inStockOnly = req.query.inStockOnly === 'true';

    const medicines = await prisma.medicine.findMany({
      where: {
        isActive: true,
        ...(inStockOnly ? { stockQuantity: { gt: 0 } } : {}),
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

export default router;
