import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { BedAssignmentHistoryJson, BedStatus } from '../types';
import { conflict, notFound } from '../utils/errors';

export const BED_INCLUDE = {
  room: true,
  department: true,
  currentPatient: {
    include: { user: true }
  }
} as const;

type BedWithRelations = Prisma.BedGetPayload<{
  include: typeof BED_INCLUDE;
}>;

export function formatBedDto(bed: BedWithRelations) {
  return {
    id: bed.id,
    bedNumber: bed.bedNumber,
    roomId: bed.roomId,
    roomCode: bed.room.code,
    roomName: bed.room.name,
    floor: bed.room.floor,
    departmentId: bed.departmentId,
    departmentName: bed.department.name,
    status: bed.status,
    admittedAt: bed.admittedAt ? bed.admittedAt.toISOString() : null,
    notes: bed.notes,
    currentPatient: bed.currentPatient
      ? {
          id: bed.currentPatient.id,
          patientCode: bed.currentPatient.patientCode,
          fullName: bed.currentPatient.user.fullName,
          gender: bed.currentPatient.gender,
          dateOfBirth: bed.currentPatient.dateOfBirth
            ? bed.currentPatient.dateOfBirth.toISOString().slice(0, 10)
            : null,
          phone: bed.currentPatient.user.phone
        }
      : null
  };
}

export async function getBedsWithStats(filters: {
  departmentId?: string;
  status?: BedStatus;
  search?: string;
}) {
  const allBeds = await prisma.bed.findMany({
    include: BED_INCLUDE,
    orderBy: [{ department: { name: 'asc' } }, { bedNumber: 'asc' }]
  });

  const deptStatsMap = new Map<
    string,
    {
      departmentId: string;
      departmentCode: string;
      departmentName: string;
      total: number;
      occupied: number;
      available: number;
      maintenance: number;
    }
  >();

  let total = 0;
  let occupied = 0;
  let available = 0;
  let maintenance = 0;

  for (const bed of allBeds) {
    total += 1;
    if (bed.status === 'OCCUPIED') occupied += 1;
    else if (bed.status === 'AVAILABLE') available += 1;
    else if (bed.status === 'MAINTENANCE') maintenance += 1;

    const deptStat = deptStatsMap.get(bed.departmentId) || {
      departmentId: bed.departmentId,
      departmentCode: bed.department.code,
      departmentName: bed.department.name,
      total: 0,
      occupied: 0,
      available: 0,
      maintenance: 0
    };
    deptStat.total += 1;
    if (bed.status === 'OCCUPIED') deptStat.occupied += 1;
    else if (bed.status === 'AVAILABLE') deptStat.available += 1;
    else if (bed.status === 'MAINTENANCE') deptStat.maintenance += 1;
    deptStatsMap.set(bed.departmentId, deptStat);
  }

  const byDepartment = Array.from(deptStatsMap.values()).map((d) => ({
    ...d,
    occupancyRate: d.total > 0 ? Math.round((d.occupied / d.total) * 100) : 0
  }));

  const searchLower = filters.search?.trim().toLowerCase();
  const filteredBeds = allBeds
    .filter((bed) => {
      if (filters.departmentId && bed.departmentId !== filters.departmentId) return false;
      if (filters.status && bed.status !== filters.status) return false;
      if (searchLower) {
        const matchBed = bed.bedNumber.toLowerCase().includes(searchLower);
        const matchRoom = bed.room.name.toLowerCase().includes(searchLower);
        const matchPatient =
          bed.currentPatient &&
          (bed.currentPatient.user.fullName.toLowerCase().includes(searchLower) ||
            bed.currentPatient.patientCode.toLowerCase().includes(searchLower));
        if (!matchBed && !matchRoom && !matchPatient) return false;
      }
      return true;
    })
    .map(formatBedDto);

  return {
    summary: {
      total,
      occupied,
      available,
      maintenance,
      occupancyRate: total > 0 ? Math.round((occupied / total) * 100) : 0
    },
    byDepartment,
    beds: filteredBeds
  };
}

export async function admitPatientToBed(
  bedId: string,
  patientId: string,
  nurseId: string,
  nurseUserId: string,
  notes?: string
) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      {
        id: string;
        status: string;
        currentPatientId: string | null;
        assignmentHistory: unknown;
      }[]
    >`
      SELECT id, status::text AS status, current_patient_id AS "currentPatientId", assignment_history AS "assignmentHistory"
      FROM beds
      WHERE id = ${bedId}
      FOR UPDATE
    `;
    if (!locked || locked.length === 0) throw notFound('Không tìm thấy giường bệnh');

    const bedRow = locked[0];
    if (bedRow.status !== 'AVAILABLE' || bedRow.currentPatientId) {
      throw conflict('Giường bệnh hiện không trống hoặc đang bảo trì');
    }

    const patient = await tx.patient.findUnique({ where: { id: patientId } });
    if (!patient) throw notFound('Không tìm thấy bệnh nhân');

    const alreadyAdmitted = await tx.bed.findFirst({
      where: { currentPatientId: patientId }
    });
    if (alreadyAdmitted) {
      throw conflict(`Bệnh nhân hiện đang nằm tại giường ${alreadyAdmitted.bedNumber}`);
    }

    const now = new Date();
    const existingHistory = Array.isArray(bedRow.assignmentHistory)
      ? (bedRow.assignmentHistory as BedAssignmentHistoryJson[])
      : [];
    const nextHistory: BedAssignmentHistoryJson[] = [
      ...existingHistory,
      {
        id: crypto.randomUUID(),
        patientId,
        assignedByNurseId: nurseId,
        action: 'ADMIT',
        admittedAt: now.toISOString(),
        dischargedAt: null,
        notes: notes?.trim() || null
      }
    ];

    const updatedBed = await tx.bed.update({
      where: { id: bedId },
      data: {
        status: 'OCCUPIED',
        currentPatientId: patientId,
        admittedAt: now,
        notes: notes?.trim() || null,
        assignmentHistory: nextHistory as unknown as Prisma.InputJsonValue
      },
      include: BED_INCLUDE
    });

    await tx.auditLog.create({
      data: {
        actorUserId: nurseUserId,
        action: 'BED_ADMIT',
        entityType: 'Bed',
        entityId: bedId,
        metadata: { bedNumber: updatedBed.bedNumber, patientId }
      }
    });

    return formatBedDto(updatedBed);
  });
}

export async function transferPatientBed(
  sourceBedId: string,
  targetBedId: string,
  nurseId: string,
  nurseUserId: string,
  notes?: string
) {
  if (sourceBedId === targetBedId) {
    throw conflict('Giường chuyển đến phải khác giường hiện tại');
  }

  return prisma.$transaction(async (tx) => {
    const orderedIds = [sourceBedId, targetBedId].sort();
    for (const id of orderedIds) {
      await tx.$queryRaw`SELECT id FROM beds WHERE id = ${id} FOR UPDATE`;
    }

    const sourceBed = await tx.bed.findUnique({ where: { id: sourceBedId } });
    const targetBed = await tx.bed.findUnique({ where: { id: targetBedId } });
    if (!sourceBed || !targetBed) throw notFound('Không tìm thấy giường nguồn hoặc giường đích');

    if (sourceBed.status !== 'OCCUPIED' || !sourceBed.currentPatientId) {
      throw conflict('Giường nguồn hiện không có bệnh nhân');
    }
    if (targetBed.status !== 'AVAILABLE' || targetBed.currentPatientId) {
      throw conflict('Giường đích hiện không trống');
    }

    const patientId = sourceBed.currentPatientId;
    const now = new Date();

    const sourceHistory = Array.isArray(sourceBed.assignmentHistory)
      ? (sourceBed.assignmentHistory as unknown as BedAssignmentHistoryJson[])
      : [];
    const targetHistory = Array.isArray(targetBed.assignmentHistory)
      ? (targetBed.assignmentHistory as unknown as BedAssignmentHistoryJson[])
      : [];

    const clearedSource = await tx.bed.update({
      where: { id: sourceBedId },
      data: {
        status: 'AVAILABLE',
        currentPatientId: null,
        admittedAt: null,
        notes: null,
        assignmentHistory: [
          ...sourceHistory,
          {
            id: crypto.randomUUID(),
            patientId,
            assignedByNurseId: nurseId,
            action: 'TRANSFER_OUT',
            admittedAt: sourceBed.admittedAt ? sourceBed.admittedAt.toISOString() : null,
            dischargedAt: now.toISOString(),
            notes: notes?.trim() || `Chuyển sang ${targetBed.bedNumber}`
          }
        ] as unknown as Prisma.InputJsonValue
      },
      include: BED_INCLUDE
    });

    const occupiedTarget = await tx.bed.update({
      where: { id: targetBedId },
      data: {
        status: 'OCCUPIED',
        currentPatientId: patientId,
        admittedAt: now,
        notes: notes?.trim() || sourceBed.notes,
        assignmentHistory: [
          ...targetHistory,
          {
            id: crypto.randomUUID(),
            patientId,
            assignedByNurseId: nurseId,
            action: 'TRANSFER_IN',
            admittedAt: now.toISOString(),
            dischargedAt: null,
            notes: notes?.trim() || `Chuyển từ ${sourceBed.bedNumber}`
          }
        ] as unknown as Prisma.InputJsonValue
      },
      include: BED_INCLUDE
    });

    await tx.auditLog.create({
      data: {
        actorUserId: nurseUserId,
        action: 'BED_TRANSFER',
        entityType: 'Bed',
        entityId: targetBedId,
        metadata: {
          fromBed: sourceBed.bedNumber,
          toBed: targetBed.bedNumber,
          patientId
        }
      }
    });

    return {
      sourceBed: formatBedDto(clearedSource),
      targetBed: formatBedDto(occupiedTarget)
    };
  });
}

export async function dischargePatientFromBed(
  bedId: string,
  nurseId: string,
  nurseUserId: string,
  notes?: string
) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      {
        id: string;
        status: string;
        currentPatientId: string | null;
        admittedAt: Date | null;
        assignmentHistory: unknown;
      }[]
    >`
      SELECT id, status::text AS status, current_patient_id AS "currentPatientId", admitted_at AS "admittedAt", assignment_history AS "assignmentHistory"
      FROM beds
      WHERE id = ${bedId}
      FOR UPDATE
    `;
    if (!locked || locked.length === 0) throw notFound('Không tìm thấy giường bệnh');

    const bedRow = locked[0];
    if (bedRow.status !== 'OCCUPIED' || !bedRow.currentPatientId) {
      throw conflict('Giường này hiện không có bệnh nhân để xuất viện');
    }

    const patientId = bedRow.currentPatientId;
    const now = new Date();
    const existingHistory = Array.isArray(bedRow.assignmentHistory)
      ? (bedRow.assignmentHistory as BedAssignmentHistoryJson[])
      : [];
    const nextHistory: BedAssignmentHistoryJson[] = [
      ...existingHistory,
      {
        id: crypto.randomUUID(),
        patientId,
        assignedByNurseId: nurseId,
        action: 'DISCHARGE',
        admittedAt: bedRow.admittedAt ? bedRow.admittedAt.toISOString() : null,
        dischargedAt: now.toISOString(),
        notes: notes?.trim() || 'Xuất viện'
      }
    ];

    const updatedBed = await tx.bed.update({
      where: { id: bedId },
      data: {
        status: 'AVAILABLE',
        currentPatientId: null,
        admittedAt: null,
        notes: null,
        assignmentHistory: nextHistory as unknown as Prisma.InputJsonValue
      },
      include: BED_INCLUDE
    });

    await tx.auditLog.create({
      data: {
        actorUserId: nurseUserId,
        action: 'BED_DISCHARGE',
        entityType: 'Bed',
        entityId: bedId,
        metadata: { bedNumber: updatedBed.bedNumber, patientId }
      }
    });

    return formatBedDto(updatedBed);
  });
}

export async function updateBedMaintenanceStatus(
  bedId: string,
  status: 'AVAILABLE' | 'MAINTENANCE',
  nurseUserId: string,
  notes?: string
) {
  const bed = await prisma.bed.findUnique({ where: { id: bedId } });
  if (!bed) throw notFound('Không tìm thấy giường bệnh');
  if (bed.status === 'OCCUPIED' || bed.currentPatientId) {
    throw conflict('Không thể chuyển trạng thái giường đang có bệnh nhân nằm');
  }

  const updated = await prisma.bed.update({
    where: { id: bedId },
    data: {
      status,
      ...(notes !== undefined ? { notes: notes.trim() || null } : {})
    },
    include: BED_INCLUDE
  });

  await prisma.auditLog.create({
    data: {
      actorUserId: nurseUserId,
      action: 'BED_STATUS_UPDATED',
      entityType: 'Bed',
      entityId: bedId,
      metadata: { bedNumber: updated.bedNumber, status }
    }
  });

  return formatBedDto(updated);
}
