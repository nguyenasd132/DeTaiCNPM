import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const tx = {
    medicalRecord: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    appointment: { findUnique: vi.fn(), update: vi.fn() },
    medicine: { findMany: vi.fn() },
    service: { findMany: vi.fn() },
    prescription: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    invoice: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    notification: { create: vi.fn() },
    auditLog: { create: vi.fn() }
  };

  const prismaMock = {
    $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx))
  };

  return { mockTx: tx, mockPrisma: prismaMock };
});

vi.mock('../src/config/prisma', () => ({ prisma: mockPrisma }));

import { saveMedicalRecord } from '../src/services/record.service';
import { checkMedicineAllergies } from '../src/utils/allergy';

describe('Allergy Checking & Clinical Medical Record Publishing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockTx));
  });

  it('detects direct allergy, cross-class allergen, and chronic condition contraindications', () => {
    const allergies = [
      { name: 'Penicillin', severity: 'SEVERE' },
      { name: 'Hải sản giáp xác', severity: 'MILD' }
    ];
    const chronic = [{ name: 'Loét dạ dày' }];

    const medicines = [
      {
        id: 'med-amox',
        name: 'Amoxicillin 500mg',
        genericName: 'Amoxicillin',
        contraindications: {
          allergens: ['Penicillin', 'Beta-lactam'],
          conditions: [],
          warningText: 'Nguy cơ sốc phản vệ'
        }
      },
      {
        id: 'med-ibu',
        name: 'Ibuprofen 400mg',
        genericName: 'Ibuprofen',
        contraindications: {
          allergens: ['NSAID'],
          conditions: ['Loét dạ dày', 'Tăng huyết áp']
        }
      },
      {
        id: 'med-para',
        name: 'Paracetamol 500mg',
        genericName: 'Acetaminophen',
        contraindications: { allergens: ['Paracetamol'], conditions: ['Suy gan nặng'] }
      }
    ];

    const warnings = checkMedicineAllergies(allergies, chronic, medicines);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].medicineId).toBe('med-amox');
    expect(warnings[0].severity).toBe('HIGH');
    expect(warnings[0].matchedAllergens).toContain('Penicillin');

    expect(warnings[1].medicineId).toBe('med-ibu');
    expect(warnings[1].severity).toBe('MODERATE');
    expect(warnings[1].matchedConditions).toContain('Loét dạ dày');
  });

  it('publishes record, generates both HOSPITAL_FEE & PRESCRIPTION invoices, sends notification, and completes appointment', async () => {
    const patient = {
      id: 'pat-1',
      userId: 'u-pat-1',
      patientCode: 'BN-08250',
      allergies: [{ name: 'Penicillin', severity: 'SEVERE' }],
      chronicConditions: [],
      user: { fullName: 'Lê Minh Anh' }
    };
    const doctor = {
      id: 'doc-1',
      userId: 'u-doc-1',
      consultationFee: 150000,
      title: 'ThS.BS',
      user: { fullName: 'BS. Hoàng Minh Long' },
      department: { name: 'Nội tổng quát' }
    };
    const appointment = {
      id: 'appt-1',
      appointmentCode: 'LH-001',
      patientId: 'pat-1',
      doctorId: 'doc-1',
      appointmentDate: new Date('2026-11-17T00:00:00.000Z'),
      session: 'MORNING',
      queueNumber: 3,
      status: 'IN_PROGRESS',
      completedAt: null,
      patient,
      department: doctor.department,
      triageData: null
    };

    const med = {
      id: 'med-1',
      code: 'TH-001',
      name: 'Amoxicillin 500mg',
      genericName: 'Amoxicillin',
      unit: 'Viên',
      unitPrice: 3500,
      contraindications: { allergens: ['Penicillin'], conditions: [] }
    };

    const svc = { id: 'svc-1', name: 'Xét nghiệm công thức máu', unitPrice: 120000 };

    const createdRx = {
      id: 'rx-1',
      prescriptionCode: 'DT-001',
      medicalRecordId: 'rec-1',
      patientId: 'pat-1',
      doctorId: 'doc-1',
      notes: 'Uống sau ăn',
      allergyWarnings: [
        {
          medicineId: 'med-1',
          medicineName: 'Amoxicillin 500mg',
          matchedAllergens: ['Penicillin'],
          matchedConditions: [],
          severity: 'HIGH',
          message: 'Cảnh báo'
        }
      ],
      totalAmount: 35000,
      status: 'PENDING_PAYMENT',
      dispensedByNurse: null,
      dispensedAt: null,
      createdAt: new Date(),
      patient,
      doctor,
      medicalRecord: { diagnosis: 'Viêm họng' },
      invoice: { id: 'inv-rx', status: 'UNPAID' },
      items: [
        {
          id: 'rxi-1',
          medicineId: 'med-1',
          medicineCode: 'TH-001',
          medicineName: 'Amoxicillin 500mg',
          genericName: 'Amoxicillin',
          unit: 'Viên',
          quantity: 10,
          dosage: '1 viên x 2',
          frequency: 'Sáng - Tối',
          durationDays: 5,
          instructions: 'Sau ăn',
          unitPrice: 3500,
          lineTotal: 35000
        }
      ]
    };

    const fullRecord = {
      id: 'rec-1',
      recordCode: 'HS-001',
      appointmentId: 'appt-1',
      patientId: 'pat-1',
      doctorId: 'doc-1',
      symptoms: 'Đau họng',
      diagnosis: 'Viêm họng',
      icdCode: 'J02.9',
      clinicalNotes: 'Họng đỏ',
      treatmentPlan: 'Theo dõi',
      specialtyResults: { labOrders: [{ serviceId: 'svc-1', testName: svc.name, status: 'ORDERED' }] },
      status: 'PUBLISHED',
      publishedAt: new Date(),
      createdAt: new Date(),
      appointment,
      patient,
      doctor,
      prescription: createdRx
    };

    mockTx.medicalRecord.findUnique
      .mockResolvedValueOnce(null) // check existing by appointmentId
      .mockResolvedValueOnce(fullRecord); // inside publishRecordTx
    mockTx.appointment.findUnique.mockResolvedValue(appointment);
    mockTx.medicalRecord.create.mockResolvedValue({ id: 'rec-1' });
    mockTx.prescription.findUnique.mockResolvedValue(null);
    mockTx.medicine.findMany.mockResolvedValue([med]);
    mockTx.prescription.create.mockResolvedValue({ id: 'rx-1' });
    mockTx.service.findMany.mockResolvedValue([svc]);
    mockTx.invoice.findFirst.mockResolvedValue(null);
    mockTx.invoice.findUnique.mockResolvedValue(null);
    mockTx.invoice.create.mockResolvedValue({});
    mockTx.medicalRecord.findUniqueOrThrow.mockResolvedValue(fullRecord);
    mockTx.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-hosp',
        invoiceCode: 'HD-001',
        patientId: 'pat-1',
        appointmentId: 'appt-1',
        prescriptionId: null,
        invoiceType: 'HOSPITAL_FEE',
        subtotal: 270000,
        insuranceDiscount: 0,
        totalAmount: 270000,
        status: 'UNPAID',
        paidAt: null,
        createdAt: new Date('2026-11-17T08:00:00.000Z'),
        patient: { patientCode: 'BN-08250', user: { fullName: 'Lê Minh Anh' } },
        appointment: { appointmentCode: 'LH-001' },
        prescription: null,
        items: [],
        payments: []
      },
      {
        id: 'inv-rx',
        invoiceCode: 'HD-002',
        patientId: 'pat-1',
        appointmentId: 'appt-1',
        prescriptionId: 'rx-1',
        invoiceType: 'PRESCRIPTION',
        subtotal: 35000,
        insuranceDiscount: 0,
        totalAmount: 35000,
        status: 'UNPAID',
        paidAt: null,
        createdAt: new Date('2026-11-17T08:00:00.000Z'),
        patient: { patientCode: 'BN-08250', user: { fullName: 'Lê Minh Anh' } },
        appointment: { appointmentCode: 'LH-001' },
        prescription: { prescriptionCode: 'DT-001' },
        items: [],
        payments: []
      }
    ]);

    const res = await saveMedicalRecord('doc-1', 'u-doc-1', {
      appointmentId: 'appt-1',
      symptoms: 'Đau họng',
      diagnosis: 'Viêm họng',
      icdCode: 'J02.9',
      specialtyResults: {
        labOrders: [{ serviceId: 'svc-1', testName: svc.name, status: 'ORDERED' }]
      },
      prescription: {
        notes: 'Uống sau ăn',
        items: [{ medicineId: 'med-1', quantity: 10, dosage: '1 viên x 2' }]
      },
      publish: true
    });

    expect(res.allergyWarnings).toHaveLength(1);
    expect(res.allergyWarnings[0].matchedAllergens).toContain('Penicillin');
    expect(mockTx.invoice.create).toHaveBeenCalledTimes(2);
    expect(mockTx.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'appt-1' },
        data: expect.objectContaining({ status: 'COMPLETED' })
      })
    );
    expect(mockTx.notification.create).toHaveBeenCalledTimes(1);
    expect(res.invoices).toHaveLength(2);
    expect(res.invoices[0].patientCode).toBe('BN-08250');
    expect(res.invoices[0].patientName).toBe('Lê Minh Anh');
    expect(res.invoices[1].prescriptionCode).toBe('DT-001');
  });

  it('forbids doctor from writing a medical record for another doctor appointment', async () => {
    mockTx.medicalRecord.findUnique.mockResolvedValue(null);
    mockTx.appointment.findUnique.mockResolvedValue({
      id: 'appt-1',
      doctorId: 'doc-other',
      status: 'IN_PROGRESS',
      patient: { allergies: [], chronicConditions: [] }
    });

    await expect(
      saveMedicalRecord('doc-1', 'u-doc-1', {
        appointmentId: 'appt-1',
        diagnosis: 'Viêm họng'
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
