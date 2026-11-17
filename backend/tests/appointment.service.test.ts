import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const tx = {
    doctor: { findUnique: vi.fn() },
    patient: { findUnique: vi.fn(), count: vi.fn() },
    user: { create: vi.fn() },
    doctorSchedule: { update: vi.fn() },
    appointment: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    notification: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn()
  };

  const prismaMock = {
    $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    doctorSchedule: { findMany: vi.fn() },
    appointment: {
      findMany: vi.fn(),
      findUnique: vi.fn()
    }
  };

  return { mockTx: tx, mockPrisma: prismaMock };
});

vi.mock('../src/config/prisma', () => ({ prisma: mockPrisma }));

import {
  bookOutpatientAppointment,
  cancelPatientAppointment,
  createWalkInAppointment,
  getAvailability,
  reschedulePatientAppointment
} from '../src/services/appointment.service';
import { computeEstimatedTime } from '../src/utils/date';

const baseDoctor = {
  id: 'doc-1',
  userId: 'u-doc-1',
  doctorCode: 'BS-001',
  departmentId: 'dept-1',
  specialty: 'Nội tổng quát',
  title: 'ThS.BS',
  consultationFee: 150000,
  user: { fullName: 'BS. Hoàng Minh Long', isActive: true },
  department: { id: 'dept-1', name: 'Nội tổng quát' },
  room: { id: 'room-1', name: 'Phòng 201' }
};

const basePatient = {
  id: 'pat-1',
  userId: 'u-pat-1',
  patientCode: 'BN-08250',
  gender: 'FEMALE',
  dateOfBirth: new Date('1996-05-14T00:00:00.000Z'),
  user: { fullName: 'Lê Minh Anh', phone: '0909123450' }
};

function makeApptRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'appt-1',
    appointmentCode: 'LH-20261118-ABC123',
    patientId: 'pat-1',
    doctorId: 'doc-1',
    departmentId: 'dept-1',
    scheduleId: 'sched-1',
    appointmentDate: new Date('2026-11-18T00:00:00.000Z'),
    session: 'MORNING',
    queueNumber: 4,
    estimatedTime: '08:06',
    bookingType: 'ONLINE',
    bookingFlow: 'BY_DEPARTMENT',
    status: 'BOOKED',
    isPriority: false,
    chiefComplaint: 'Đau đầu nhẹ',
    cancelReason: null,
    checkedInAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-11-17T08:00:00.000Z'),
    patient: basePatient,
    doctor: baseDoctor,
    department: baseDoctor.department,
    triageData: null,
    medicalRecord: null,
    ...overrides
  };
}

describe('Session-based Atomic STT & Appointment Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockTx));
    mockPrisma.appointment.findMany.mockResolvedValue([]);
  });

  it('computes estimatedTime accurately from session start + (queueNumber - 1) * avgMinutes', () => {
    expect(computeEstimatedTime('MORNING', 1, 12)).toBe('07:30');
    expect(computeEstimatedTime('MORNING', 4, 12)).toBe('08:06');
    expect(computeEstimatedTime('AFTERNOON', 1, 15)).toBe('13:30');
    expect(computeEstimatedTime('AFTERNOON', 3, 15)).toBe('14:00');
  });

  it('locks doctor_schedules with SELECT FOR UPDATE and keeps cancelled STT intact (issues #4 after #2 cancelled)', async () => {
    mockTx.doctor.findUnique.mockResolvedValue(baseDoctor);
    mockTx.patient.findUnique.mockResolvedValue(basePatient);
    mockTx.$queryRaw.mockResolvedValue([
      {
        id: 'sched-1',
        maxPatients: 20,
        avgMinutesPerPatient: 12,
        lastQueueNumber: 3, // STT 1, 2, 3 were previously issued (2 was cancelled)
        isAvailable: true
      }
    ]);
    mockTx.appointment.findFirst.mockResolvedValue(null);
    mockTx.appointment.count.mockResolvedValue(2); // Only 2 non-cancelled appointments
    mockTx.appointment.aggregate.mockResolvedValue({ _max: { queueNumber: 3 } });
    mockTx.doctorSchedule.update.mockResolvedValue({});
    mockTx.appointment.create.mockResolvedValue(makeApptRecord({ queueNumber: 4, estimatedTime: '08:06' }));

    const result = await bookOutpatientAppointment({
      patientId: 'pat-1',
      doctorId: 'doc-1',
      date: '2026-11-18',
      session: 'MORNING',
      bookingType: 'ONLINE',
      bookingFlow: 'BY_DEPARTMENT',
      chiefComplaint: 'Đau đầu nhẹ'
    });

    // Verify FOR UPDATE raw SQL was called
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    const rawSqlChunks = mockTx.$queryRaw.mock.calls[0][0].join(' ');
    expect(rawSqlChunks).toContain('FOR UPDATE');
    expect(rawSqlChunks).toContain('doctor_schedules');

    // Verify STT #4 was issued & saved on schedule
    expect(mockTx.doctorSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sched-1' },
      data: { lastQueueNumber: 4 }
    });
    expect(mockTx.appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          queueNumber: 4,
          estimatedTime: '08:06',
          session: 'MORNING'
        })
      })
    );
    expect(result.queueNumber).toBe(4);
    expect(result.estimatedTime).toBe('08:06');
  });

  it('prevents duplicate active booking for the same patient/doctor/date/session', async () => {
    mockTx.doctor.findUnique.mockResolvedValue(baseDoctor);
    mockTx.patient.findUnique.mockResolvedValue(basePatient);
    mockTx.$queryRaw.mockResolvedValue([
      { id: 'sched-1', maxPatients: 20, avgMinutesPerPatient: 12, lastQueueNumber: 1, isAvailable: true }
    ]);
    mockTx.appointment.findFirst.mockResolvedValue({ id: 'existing-appt' });

    await expect(
      bookOutpatientAppointment({
        patientId: 'pat-1',
        doctorId: 'doc-1',
        date: '2026-11-18',
        session: 'MORNING',
        bookingType: 'ONLINE'
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_BOOKING' });
  });

  it('rejects online booking when session capacity is full', async () => {
    mockTx.doctor.findUnique.mockResolvedValue(baseDoctor);
    mockTx.patient.findUnique.mockResolvedValue(basePatient);
    mockTx.$queryRaw.mockResolvedValue([
      { id: 'sched-1', maxPatients: 20, avgMinutesPerPatient: 12, lastQueueNumber: 20, isAvailable: true }
    ]);
    mockTx.appointment.findFirst.mockResolvedValue(null);
    mockTx.appointment.count.mockResolvedValue(20);

    await expect(
      bookOutpatientAppointment({
        patientId: 'pat-1',
        doctorId: 'doc-1',
        date: '2026-11-18',
        session: 'MORNING',
        bookingType: 'ONLINE'
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'SESSION_FULL' });
  });

  it('supports priority walk-in booking with auto schedule upsert & auto check-in', async () => {
    mockTx.doctor.findUnique.mockResolvedValue(baseDoctor);
    mockTx.patient.findUnique.mockResolvedValue(basePatient);
    mockTx.$executeRaw.mockResolvedValue(1);
    mockTx.$queryRaw.mockResolvedValue([
      { id: 'sched-1', maxPatients: 20, avgMinutesPerPatient: 12, lastQueueNumber: 20, isAvailable: true }
    ]);
    mockTx.appointment.findFirst.mockResolvedValue(null);
    mockTx.appointment.count.mockResolvedValue(20);
    mockTx.appointment.aggregate.mockResolvedValue({ _max: { queueNumber: 20 } });
    mockTx.doctorSchedule.update.mockResolvedValue({});
    mockTx.appointment.create.mockResolvedValue(
      makeApptRecord({
        queueNumber: 21,
        bookingType: 'WALK_IN',
        isPriority: true,
        status: 'CHECKED_IN'
      })
    );

    const dto = await createWalkInAppointment(
      {
        patientId: 'pat-1',
        doctorId: 'doc-1',
        date: '2026-11-18',
        session: 'MORNING',
        isPriority: true,
        chiefComplaint: 'Sốt cao'
      },
      'u-nurse-1'
    );

    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(dto.queueNumber).toBe(21);
    expect(dto.isPriority).toBe(true);
    expect(dto.status).toBe('CHECKED_IN');
  });

  it('reschedules appointment atomically and issues new STT in target session', async () => {
    mockTx.appointment.findUnique.mockResolvedValue(makeApptRecord({ status: 'BOOKED' }));
    mockTx.doctor.findUnique.mockResolvedValue(baseDoctor);
    mockTx.$queryRaw.mockResolvedValue([
      { id: 'sched-2', maxPatients: 20, avgMinutesPerPatient: 12, lastQueueNumber: 2, isAvailable: true }
    ]);
    mockTx.appointment.findFirst.mockResolvedValue(null);
    mockTx.appointment.count.mockResolvedValue(2);
    mockTx.appointment.aggregate.mockResolvedValue({ _max: { queueNumber: 2 } });
    mockTx.doctorSchedule.update.mockResolvedValue({});
    mockTx.appointment.update.mockResolvedValue(
      makeApptRecord({
        scheduleId: 'sched-2',
        appointmentDate: new Date('2026-11-19T00:00:00.000Z'),
        session: 'AFTERNOON',
        queueNumber: 3,
        estimatedTime: '13:54'
      })
    );

    const dto = await reschedulePatientAppointment(
      'pat-1',
      'appt-1',
      { date: '2026-11-19', session: 'AFTERNOON' },
      'u-pat-1'
    );

    expect(dto.session).toBe('AFTERNOON');
    expect(dto.queueNumber).toBe(3);
    expect(dto.estimatedTime).toBe('13:54');
  });

  it('cancels appointment while preserving queueNumber and forbids cancelling others', async () => {
    mockPrisma.appointment.findUnique.mockResolvedValueOnce(
      makeApptRecord({ patientId: 'other-patient' })
    );
    await expect(
      cancelPatientAppointment('pat-1', 'appt-1', 'Bận việc', 'u-pat-1')
    ).rejects.toMatchObject({ statusCode: 403 });

    mockPrisma.appointment.findUnique.mockResolvedValueOnce(makeApptRecord({ queueNumber: 4 }));
    mockTx.appointment.update.mockResolvedValue(
      makeApptRecord({ status: 'CANCELLED', queueNumber: 4, cancelReason: 'Bận việc đột xuất' })
    );

    const cancelled = await cancelPatientAppointment('pat-1', 'appt-1', 'Bận việc đột xuất', 'u-pat-1');
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.queueNumber).toBe(4);
  });

  it('computes availability remainingSlots and projected nextQueueNumber accurately', async () => {
    mockPrisma.doctorSchedule.findMany.mockResolvedValue([
      {
        id: 'sched-1',
        doctorId: 'doc-1',
        scheduleDate: new Date('2026-11-18T00:00:00.000Z'),
        session: 'MORNING',
        startTime: '07:30',
        endTime: '11:30',
        maxPatients: 20,
        avgMinutesPerPatient: 12,
        lastQueueNumber: 5,
        isAvailable: true,
        doctor: baseDoctor
      }
    ]);
    mockPrisma.appointment.findMany.mockResolvedValue([
      { doctorId: 'doc-1', appointmentDate: new Date('2026-11-18T00:00:00.000Z'), session: 'MORNING', queueNumber: 1, status: 'COMPLETED' },
      { doctorId: 'doc-1', appointmentDate: new Date('2026-11-18T00:00:00.000Z'), session: 'MORNING', queueNumber: 2, status: 'CANCELLED' },
      { doctorId: 'doc-1', appointmentDate: new Date('2026-11-18T00:00:00.000Z'), session: 'MORNING', queueNumber: 5, status: 'BOOKED' }
    ]);

    const slots = await getAvailability({ flow: 'BY_DEPARTMENT', departmentId: 'dept-1', date: '2026-11-18' });
    expect(slots).toHaveLength(1);
    expect(slots[0].bookedCount).toBe(2);
    expect(slots[0].remainingSlots).toBe(18);
    expect(slots[0].nextQueueNumber).toBe(6);
    expect(slots[0].estimatedTime).toBe('08:30');
  });
});
