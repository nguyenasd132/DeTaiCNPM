import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma';
import { signAuthToken } from '../middleware/auth';
import { Gender, Role } from '../types';
import { generateSequentialCode } from '../utils/codes';
import { formatDateOnly, toDateOnly } from '../utils/date';
import { badRequest, conflict, notFound, unauthorized } from '../utils/errors';

const USER_WITH_PROFILES_INCLUDE = {
  patientProfile: true,
  doctorProfile: {
    include: {
      department: true,
      room: true
    }
  },
  nurseProfile: {
    include: {
      department: true
    }
  }
} as const;

export function formatAuthUser(user: {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: Role;
  avatarUrl: string | null;
  isActive: boolean;
  patientProfile?: {
    id: string;
    patientCode: string;
    dateOfBirth: Date | null;
    gender: Gender | null;
    address: string | null;
    nationalId: string | null;
    insuranceNumber: string | null;
    bloodType: string | null;
    allergies: unknown;
    chronicConditions: unknown;
    emergencyContact: unknown;
  } | null;
  doctorProfile?: {
    id: string;
    doctorCode: string;
    departmentId: string;
    department: { name: string };
    roomId: string | null;
    room: { name: string } | null;
    specialty: string;
    title: string | null;
    consultationFee: number;
    isOnDuty: boolean;
  } | null;
  nurseProfile?: {
    id: string;
    nurseCode: string;
    departmentId: string;
    department: { name: string };
    shift: string | null;
  } | null;
}) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    avatarUrl: user.avatarUrl,
    isActive: user.isActive,
    patientProfile: user.patientProfile
      ? {
          id: user.patientProfile.id,
          patientCode: user.patientProfile.patientCode,
          dateOfBirth: user.patientProfile.dateOfBirth
            ? formatDateOnly(user.patientProfile.dateOfBirth)
            : null,
          gender: user.patientProfile.gender,
          address: user.patientProfile.address,
          nationalId: user.patientProfile.nationalId,
          insuranceNumber: user.patientProfile.insuranceNumber,
          bloodType: user.patientProfile.bloodType,
          allergies: Array.isArray(user.patientProfile.allergies)
            ? user.patientProfile.allergies
            : [],
          chronicConditions: Array.isArray(user.patientProfile.chronicConditions)
            ? user.patientProfile.chronicConditions
            : [],
          emergencyContact: user.patientProfile.emergencyContact || null
        }
      : null,
    doctorProfile: user.doctorProfile
      ? {
          id: user.doctorProfile.id,
          doctorCode: user.doctorProfile.doctorCode,
          departmentId: user.doctorProfile.departmentId,
          departmentName: user.doctorProfile.department.name,
          roomId: user.doctorProfile.roomId,
          roomName: user.doctorProfile.room ? user.doctorProfile.room.name : null,
          specialty: user.doctorProfile.specialty,
          title: user.doctorProfile.title,
          consultationFee: user.doctorProfile.consultationFee,
          isOnDuty: user.doctorProfile.isOnDuty
        }
      : null,
    nurseProfile: user.nurseProfile
      ? {
          id: user.nurseProfile.id,
          nurseCode: user.nurseProfile.nurseCode,
          departmentId: user.nurseProfile.departmentId,
          departmentName: user.nurseProfile.department.name,
          shift: user.nurseProfile.shift
        }
      : null
  };
}

export async function loginUser(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: USER_WITH_PROFILES_INCLUDE
  });

  if (!user) {
    throw unauthorized('Email hoặc mật khẩu không chính xác');
  }
  if (!user.isActive) {
    throw unauthorized('Tài khoản đã bị vô hiệu hóa, vui lòng liên hệ quản trị viên');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw unauthorized('Email hoặc mật khẩu không chính xác');
  }

  const token = signAuthToken({
    userId: user.id,
    email: user.email,
    role: user.role
  });

  return {
    token,
    user: formatAuthUser(user)
  };
}

export interface RegisterPatientInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: Gender;
  address?: string;
  nationalId?: string;
  insuranceNumber?: string;
}

export async function registerPatient(input: RegisterPatientInput) {
  const normalizedEmail = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail }
  });
  if (existing) {
    throw conflict('Email này đã được đăng ký tài khoản');
  }

  const passwordHash = await bcrypt.hash(input.password, 10);

  const created = await prisma.$transaction(async (tx) => {
    const patientCount = await tx.patient.count();
    let seq = 8251 + patientCount;
    let patientCode = generateSequentialCode('BN', seq, 5);

    while (await tx.patient.findUnique({ where: { patientCode } })) {
      seq += 1;
      patientCode = generateSequentialCode('BN', seq, 5);
    }

    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        fullName: input.fullName.trim(),
        phone: input.phone?.trim() || null,
        role: 'PATIENT',
        isActive: true,
        patientProfile: {
          create: {
            patientCode,
            dateOfBirth: input.dateOfBirth ? toDateOnly(input.dateOfBirth) : null,
            gender: input.gender || null,
            address: input.address?.trim() || null,
            nationalId: input.nationalId?.trim() || null,
            insuranceNumber: input.insuranceNumber?.trim() || null,
            allergies: [],
            chronicConditions: []
          }
        }
      },
      include: USER_WITH_PROFILES_INCLUDE
    });

    await tx.notification.create({
      data: {
        userId: user.id,
        title: 'Chào mừng đến với An Tâm',
        message: `Tài khoản bệnh nhân ${patientCode} của bạn đã sẵn sàng. Bạn có thể đặt lịch khám theo khoa, bác sĩ hoặc ngày khám.`,
        type: 'SYSTEM',
        payload: { patientCode }
      }
    });

    return user;
  });

  const token = signAuthToken({
    userId: created.id,
    email: created.email,
    role: created.role
  });

  return {
    token,
    user: formatAuthUser(created)
  };
}

export async function getUserById(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: USER_WITH_PROFILES_INCLUDE
  });
  if (!user) {
    throw notFound('Không tìm thấy người dùng');
  }
  return formatAuthUser(user);
}

export async function updateUserAccountProfile(
  userId: string,
  input: {
    fullName?: string;
    phone?: string;
    avatarUrl?: string;
    currentPassword?: string;
    newPassword?: string;
  }
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw notFound('Không tìm thấy người dùng');
  }

  let nextPasswordHash: string | undefined;
  if (input.newPassword) {
    if (!input.currentPassword) {
      throw badRequest('Vui lòng nhập mật khẩu hiện tại để đổi mật khẩu mới');
    }
    const matches = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!matches) {
      throw badRequest('Mật khẩu hiện tại không đúng');
    }
    nextPasswordHash = await bcrypt.hash(input.newPassword, 10);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
      ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl || null } : {}),
      ...(nextPasswordHash ? { passwordHash: nextPasswordHash } : {})
    },
    include: USER_WITH_PROFILES_INCLUDE
  });

  return formatAuthUser(updated);
}
