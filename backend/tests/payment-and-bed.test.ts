import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    invoice: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn()
    },
    payment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    prescription: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn()
    },
    medicine: { updateMany: vi.fn() },
    bed: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    patient: { findUnique: vi.fn() },
    notification: { create: vi.fn() },
    auditLog: { create: vi.fn() }
  };

  const prismaMock = {
    $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    bed: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() }
  };

  return { mockTx: tx, mockPrisma: prismaMock };
});

vi.mock('../src/config/prisma', () => ({ prisma: mockPrisma }));

import {
  admitPatientToBed,
  dischargePatientFromBed,
  getBedsWithStats,
  transferPatientBed
} from '../src/services/bed.service';
import {
  confirmNursePayment,
  dispenseNursePrescription,
  initiatePatientPayment
} from '../src/services/payment.service';

describe('Atomic Payment Confirmation, Dispensing & Bed Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockTx));
  });

  it('initiates QR payment, transitions invoice to PENDING_VERIFICATION, and returns QR metadata', async () => {
    const baseInvoice = {
      id: 'inv-1',
      invoiceCode: 'HD-TODAY-003',
      patientId: 'pat-1',
      appointmentId: 'appt-1',
      prescriptionId: null,
      invoiceType: 'HOSPITAL_FEE',
      subtotal: 150000,
      insuranceDiscount: 0,
      totalAmount: 150000,
      status: 'UNPAID',
      paidAt: null,
      createdAt: new Date(),
      patient: { patientCode: 'BN-08250', userId: 'u-pat-1', user: { fullName: 'Lê Minh Anh' } },
      appointment: { appointmentCode: 'LH-001' },
      prescription: null,
      items: [],
      payments: []
    };

    mockTx.invoice.findUnique.mockResolvedValue(baseInvoice);
    mockTx.payment.create.mockResolvedValue({
      id: 'pay-1',
      paymentCode: 'TT-001',
      invoiceId: 'inv-1',
      patientId: 'pat-1',
      amount: 150000,
      method: 'QR_TRANSFER',
      status: 'PENDING',
      qrReference: 'ANTAM-HD-TODAY-003',
      notes: null,
      createdAt: new Date()
    });
    mockTx.invoice.findUniqueOrThrow.mockResolvedValue({
      ...baseInvoice,
      status: 'PENDING_VERIFICATION'
    });

    const result = await initiatePatientPayment('pat-1', 'u-pat-1', {
      invoiceId: 'inv-1',
      method: 'QR_TRANSFER'
    });

    expect(result.invoice.status).toBe('PENDING_VERIFICATION');
    expect(result.payment.status).toBe('PENDING');
    expect(result.qrInfo?.transferContent).toBe('ANTAM HD-TODAY-003');
  });

  it('atomically confirms payment -> updates invoice PAID -> updates prescription PAID -> sends notification', async () => {
    const invoiceObj = {
      id: 'inv-rx',
      invoiceCode: 'HD-TODAY-002',
      patientId: 'pat-1',
      appointmentId: 'appt-1',
      prescriptionId: 'rx-1',
      invoiceType: 'PRESCRIPTION',
      subtotal: 90000,
      insuranceDiscount: 0,
      totalAmount: 90000,
      status: 'PENDING_VERIFICATION',
      paidAt: null,
      createdAt: new Date(),
      patient: { userId: 'u-pat-1', patientCode: 'BN-08250', user: { fullName: 'Nguyễn Thị Lan' } },
      appointment: { appointmentCode: 'LH-001' },
      prescription: { prescriptionCode: 'DT-001' },
      items: [],
      payments: [
        {
          id: 'pay-1',
          paymentCode: 'TT-001',
          invoiceId: 'inv-rx',
          patientId: 'pat-1',
          amount: 90000,
          method: 'QR_TRANSFER',
          status: 'CONFIRMED',
          qrReference: 'ANTAM-HD-TODAY-002',
          confirmedByNurse: { user: { fullName: 'ĐD. Phạm Thị Mai' } },
          confirmedAt: new Date(),
          notes: null,
          createdAt: new Date()
        }
      ]
    };

    mockTx.payment.findUnique.mockResolvedValue(null);
    mockTx.$queryRaw.mockResolvedValue([{ id: 'inv-rx', status: 'PENDING_VERIFICATION' }]);
    mockTx.invoice.findUniqueOrThrow
      .mockResolvedValueOnce(invoiceObj)
      .mockResolvedValueOnce({ ...invoiceObj, status: 'PAID' });
    mockTx.payment.findFirst.mockResolvedValue({
      id: 'pay-1',
      method: 'QR_TRANSFER',
      status: 'PENDING',
      notes: null
    });
    mockTx.payment.update.mockResolvedValue({ id: 'pay-1', method: 'QR_TRANSFER' });
    mockTx.prescription.findUnique.mockResolvedValue({ id: 'rx-1', status: 'PENDING_PAYMENT' });
    mockTx.prescription.update.mockResolvedValue({
      id: 'rx-1',
      prescriptionCode: 'DT-001',
      medicalRecordId: 'rec-1',
      patientId: 'pat-1',
      doctorId: 'doc-1',
      notes: null,
      allergyWarnings: [],
      totalAmount: 90000,
      status: 'PAID',
      dispensedByNurse: null,
      dispensedAt: null,
      createdAt: new Date(),
      patient: invoiceObj.patient,
      doctor: { user: { fullName: 'BS. Long' }, department: { name: 'Nội' } },
      medicalRecord: { diagnosis: 'THA' },
      invoice: { id: 'inv-rx', status: 'PAID' },
      items: []
    });

    const res = await confirmNursePayment('inv-rx', 'nurse-1', 'u-nurse-1', {});

    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockTx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) })
    );
    expect(mockTx.prescription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PAID' } })
    );
    expect(mockTx.notification.create).toHaveBeenCalledTimes(1);
    expect(res.invoice.status).toBe('PAID');
    expect(res.prescription?.status).toBe('PAID');

    // Reject already PAID invoice
    mockTx.payment.findUnique.mockResolvedValue(null);
    mockTx.$queryRaw.mockResolvedValue([{ id: 'inv-rx', status: 'PAID' }]);
    mockTx.invoice.findUniqueOrThrow.mockResolvedValueOnce({ ...invoiceObj, status: 'PAID' });
    await expect(
      confirmNursePayment('inv-rx', 'nurse-1', 'u-nurse-1', {})
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('blocks dispensing unpaid prescriptions and decrements stock when PAID', async () => {
    mockTx.prescription.findUnique.mockResolvedValueOnce({
      id: 'rx-1',
      status: 'PENDING_PAYMENT',
      items: []
    });
    await expect(dispenseNursePrescription('rx-1', 'nurse-1', 'u-nurse-1')).rejects.toMatchObject({
      statusCode: 409
    });

    mockTx.prescription.findUnique.mockResolvedValueOnce({
      id: 'rx-1',
      prescriptionCode: 'DT-001',
      status: 'PAID',
      patient: { userId: 'u-pat-1' },
      items: [
        {
          id: 'rxi-1',
          medicineId: 'med-1',
          medicineCode: 'TH-005',
          medicineName: 'Amlodipine',
          genericName: 'Amlodipine',
          unit: 'Viên',
          quantity: 10,
          dosage: '1 viên',
          frequency: null,
          durationDays: 10,
          instructions: null,
          unitPrice: 4000,
          lineTotal: 40000
        }
      ]
    });
    mockTx.medicine.updateMany.mockResolvedValue({ count: 1 });
    mockTx.prescription.update.mockResolvedValue({
      id: 'rx-1',
      prescriptionCode: 'DT-001',
      medicalRecordId: 'rec-1',
      patientId: 'pat-1',
      doctorId: 'doc-1',
      notes: null,
      allergyWarnings: [],
      totalAmount: 40000,
      status: 'DISPENSED',
      dispensedByNurse: { user: { fullName: 'ĐD. Mai' } },
      dispensedAt: new Date(),
      createdAt: new Date(),
      patient: { patientCode: 'BN-08250', user: { fullName: 'Lan' } },
      doctor: { user: { fullName: 'BS. Long' }, department: { name: 'Nội' } },
      medicalRecord: { diagnosis: 'THA' },
      invoice: { id: 'inv-rx', status: 'PAID' },
      items: []
    });

    const dispensed = await dispenseNursePrescription('rx-1', 'nurse-1', 'u-nurse-1');
    expect(mockTx.medicine.updateMany).toHaveBeenCalledWith({
      where: { id: 'med-1', stockQuantity: { gte: 10 } },
      data: { stockQuantity: { decrement: 10 } }
    });
    expect(dispensed.status).toBe('DISPENSED');
  });

  it('computes bed occupancy rates and handles admit/transfer/discharge atomically', async () => {
    const makeMockBed = (id: string, deptId: string, deptName: string, status: string) => ({
      id,
      bedNumber: id,
      roomId: 'r-1',
      departmentId: deptId,
      status,
      admittedAt: null,
      notes: null,
      room: { code: 'W1', name: 'Phòng nội trú 1', floor: 'Tầng 4' },
      department: { code: deptId, name: deptName },
      currentPatient:
        status === 'OCCUPIED'
          ? {
              id: `pat-${id}`,
              patientCode: `BN-${id}`,
              gender: 'MALE',
              dateOfBirth: null,
              user: { fullName: 'BN', phone: null }
            }
          : null
    });

    const beds = [
      ...Array.from({ length: 48 }, (_, i) => makeMockBed(`N-${i}`, 'NOI', 'Nội tổng quát', 'OCCUPIED')),
      ...Array.from({ length: 12 }, (_, i) => makeMockBed(`NA-${i}`, 'NOI', 'Nội tổng quát', 'AVAILABLE')),
      ...Array.from({ length: 30 }, (_, i) => makeMockBed(`G-${i}`, 'NGOAI', 'Ngoại khoa', 'OCCUPIED')),
      ...Array.from({ length: 10 }, (_, i) => makeMockBed(`GA-${i}`, 'NGOAI', 'Ngoại khoa', 'AVAILABLE'))
    ];
    mockPrisma.bed.findMany.mockResolvedValue(beds);

    const stats = await getBedsWithStats({});
    expect(stats.summary.total).toBe(100);
    expect(stats.summary.occupied).toBe(78);
    expect(stats.summary.occupancyRate).toBe(78);

    // Admit
    mockTx.$queryRaw.mockResolvedValue([
      { id: 'bed-1', status: 'AVAILABLE', currentPatientId: null, assignmentHistory: [] }
    ]);
    mockTx.patient.findUnique.mockResolvedValue({ id: 'pat-1' });
    mockTx.bed.findFirst.mockResolvedValue(null);
    mockTx.bed.update.mockResolvedValue(makeMockBed('bed-1', 'NOI', 'Nội tổng quát', 'OCCUPIED'));

    const admitted = await admitPatientToBed('bed-1', 'pat-1', 'nurse-1', 'u-nurse-1', 'Nhập viện');
    expect(admitted.status).toBe('OCCUPIED');

    // Transfer (sorted lock order)
    mockTx.$queryRaw.mockResolvedValue([{ id: 'bed-1' }]);
    mockTx.bed.findUnique
      .mockResolvedValueOnce({
        id: 'bed-1',
        bedNumber: 'NOI-001',
        status: 'OCCUPIED',
        currentPatientId: 'pat-1',
        admittedAt: new Date(),
        notes: null,
        assignmentHistory: []
      })
      .mockResolvedValueOnce({
        id: 'bed-2',
        bedNumber: 'NOI-002',
        status: 'AVAILABLE',
        currentPatientId: null,
        admittedAt: null,
        notes: null,
        assignmentHistory: []
      });
    mockTx.bed.update
      .mockResolvedValueOnce(makeMockBed('bed-1', 'NOI', 'Nội tổng quát', 'AVAILABLE'))
      .mockResolvedValueOnce(makeMockBed('bed-2', 'NOI', 'Nội tổng quát', 'OCCUPIED'));

    const transferred = await transferPatientBed('bed-1', 'bed-2', 'nurse-1', 'u-nurse-1');
    expect(transferred.sourceBed.status).toBe('AVAILABLE');
    expect(transferred.targetBed.status).toBe('OCCUPIED');

    // Discharge
    mockTx.$queryRaw.mockResolvedValue([
      {
        id: 'bed-2',
        status: 'OCCUPIED',
        currentPatientId: 'pat-1',
        admittedAt: new Date(),
        assignmentHistory: []
      }
    ]);
    mockTx.bed.update.mockResolvedValue(makeMockBed('bed-2', 'NOI', 'Nội tổng quát', 'AVAILABLE'));
    const discharged = await dischargePatientFromBed('bed-2', 'nurse-1', 'u-nurse-1');
    expect(discharged.status).toBe('AVAILABLE');
  });
});
