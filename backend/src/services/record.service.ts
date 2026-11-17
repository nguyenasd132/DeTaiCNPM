import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import {
  AllergyWarningDto,
  InvoiceItemJson,
  PrescriptionItemJson,
  SpecialtyResultsData,
  TriageDataJson
} from '../types';
import { checkMedicineAllergies } from '../utils/allergy';
import { generateHospitalCode } from '../utils/codes';
import { formatDateOnly } from '../utils/date';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { formatInvoiceDto, INVOICE_INCLUDE } from './invoice.formatter';

export const PRESCRIPTION_INCLUDE = {
  patient: { include: { user: true } },
  doctor: { include: { user: true, department: true } },
  dispensedByNurse: { include: { user: true } },
  medicalRecord: { select: { diagnosis: true } },
  invoice: { select: { id: true, status: true } }
} as const;

export const MEDICAL_RECORD_INCLUDE = {
  appointment: {
    include: {
      department: true
    }
  },
  patient: { include: { user: true } },
  doctor: { include: { user: true, department: true } },
  prescription: {
    include: PRESCRIPTION_INCLUDE
  }
} as const;

type PrescriptionWithRelations = Prisma.PrescriptionGetPayload<{
  include: typeof PRESCRIPTION_INCLUDE;
}>;

type MedicalRecordWithRelations = Prisma.MedicalRecordGetPayload<{
  include: typeof MEDICAL_RECORD_INCLUDE;
}>;

export function formatPrescriptionDto(rx: PrescriptionWithRelations) {
  const rawItems = Array.isArray(rx.items)
    ? (rx.items as unknown as PrescriptionItemJson[])
    : [];

  return {
    id: rx.id,
    prescriptionCode: rx.prescriptionCode,
    medicalRecordId: rx.medicalRecordId,
    patientId: rx.patientId,
    patientCode: rx.patient.patientCode,
    patientName: rx.patient.user.fullName,
    doctorId: rx.doctorId,
    doctorName: rx.doctor.user.fullName,
    departmentName: rx.doctor.department.name,
    diagnosis: rx.medicalRecord?.diagnosis || '',
    notes: rx.notes,
    allergyWarnings: Array.isArray(rx.allergyWarnings) ? rx.allergyWarnings : [],
    totalAmount: rx.totalAmount,
    status: rx.status,
    dispensedByNurseName: rx.dispensedByNurse ? rx.dispensedByNurse.user.fullName : null,
    dispensedAt: rx.dispensedAt ? rx.dispensedAt.toISOString() : null,
    createdAt: rx.createdAt.toISOString(),
    items: rawItems.map((item, idx) => ({
      id: item.id || `${rx.id}-item-${idx + 1}`,
      medicineId: item.medicineId,
      medicineCode: item.medicineCode,
      medicineName: item.medicineName,
      genericName: item.genericName ?? null,
      unit: item.unit,
      quantity: item.quantity,
      dosage: item.dosage,
      frequency: item.frequency ?? null,
      durationDays: item.durationDays ?? null,
      instructions: item.instructions ?? null,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal
    })),
    invoiceId: rx.invoice ? rx.invoice.id : null,
    invoiceStatus: rx.invoice ? rx.invoice.status : null
  };
}

export function formatMedicalRecordDto(record: MedicalRecordWithRelations) {
  const triage = record.appointment.triageData as unknown as TriageDataJson | null;
  return {
    id: record.id,
    recordCode: record.recordCode,
    appointmentId: record.appointmentId,
    appointmentCode: record.appointment.appointmentCode,
    appointmentDate: formatDateOnly(record.appointment.appointmentDate),
    session: record.appointment.session,
    queueNumber: record.appointment.queueNumber,
    patientId: record.patientId,
    patientCode: record.patient.patientCode,
    patientName: record.patient.user.fullName,
    doctorId: record.doctorId,
    doctorName: record.doctor.user.fullName,
    doctorTitle: record.doctor.title,
    departmentName: record.appointment.department.name,
    symptoms: record.symptoms,
    diagnosis: record.diagnosis,
    icdCode: record.icdCode,
    clinicalNotes: record.clinicalNotes,
    treatmentPlan: record.treatmentPlan,
    specialtyResults: (record.specialtyResults || {}) as SpecialtyResultsData,
    status: record.status,
    publishedAt: record.publishedAt ? record.publishedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    vitals: triage ? triage.vitals : null,
    prescription: record.prescription ? formatPrescriptionDto(record.prescription) : null
  };
}

export interface SaveRecordInput {
  appointmentId?: string;
  symptoms?: string;
  diagnosis: string;
  icdCode?: string;
  clinicalNotes?: string;
  treatmentPlan?: string;
  specialtyResults?: SpecialtyResultsData;
  orderedServiceIds?: string[];
  prescription?: {
    notes?: string;
    items: {
      medicineId: string;
      quantity: number;
      dosage: string;
      frequency?: string;
      durationDays?: number;
      instructions?: string;
    }[];
  };
  publish?: boolean;
}

async function publishRecordTx(
  tx: Prisma.TransactionClient,
  recordId: string,
  doctorUserId: string,
  orderedServiceIds: string[] = []
) {
  const record = await tx.medicalRecord.findUnique({
    where: { id: recordId },
    include: {
      appointment: { include: { department: true } },
      doctor: { include: { user: true, department: true } },
      patient: { include: { user: true } },
      prescription: true
    }
  });
  if (!record) {
    throw notFound('Không tìm thấy hồ sơ bệnh án');
  }

  const now = new Date();
  await tx.medicalRecord.update({
    where: { id: recordId },
    data: {
      status: 'PUBLISHED',
      publishedAt: record.publishedAt || now
    }
  });

  if (record.appointment.status !== 'COMPLETED' && record.appointment.status !== 'CANCELLED') {
    await tx.appointment.update({
      where: { id: record.appointmentId },
      data: {
        status: 'COMPLETED',
        completedAt: record.appointment.completedAt || now
      }
    });
  }

  // Collect ordered services from both orderedServiceIds and specialtyResults.labOrders[].serviceId
  const specialty = (record.specialtyResults || {}) as SpecialtyResultsData;
  const labServiceIds = (specialty.labOrders || [])
    .map((o) => o.serviceId)
    .filter((id): id is string => Boolean(id));
  const allServiceIds = Array.from(new Set([...orderedServiceIds, ...labServiceIds]));

  const services =
    allServiceIds.length > 0
      ? await tx.service.findMany({ where: { id: { in: allServiceIds }, isActive: true } })
      : [];

  const hospitalFeeItems: InvoiceItemJson[] = [
    {
      id: crypto.randomUUID(),
      serviceId: null,
      medicineId: null,
      description: `Phí khám ${record.doctor.department.name} - ${record.doctor.user.fullName}`,
      quantity: 1,
      unitPrice: record.doctor.consultationFee,
      lineTotal: record.doctor.consultationFee
    }
  ];

  for (const svc of services) {
    hospitalFeeItems.push({
      id: crypto.randomUUID(),
      serviceId: svc.id,
      medicineId: null,
      description: svc.name,
      quantity: 1,
      unitPrice: svc.unitPrice,
      lineTotal: svc.unitPrice
    });
  }

  const hospitalSubtotal = hospitalFeeItems.reduce((sum, item) => sum + item.lineTotal, 0);

  const existingHospitalInvoice = await tx.invoice.findFirst({
    where: {
      appointmentId: record.appointmentId,
      invoiceType: 'HOSPITAL_FEE'
    }
  });

  if (!existingHospitalInvoice) {
    await tx.invoice.create({
      data: {
        invoiceCode: generateHospitalCode('HD'),
        patientId: record.patientId,
        appointmentId: record.appointmentId,
        invoiceType: 'HOSPITAL_FEE',
        items: hospitalFeeItems as unknown as Prisma.InputJsonValue,
        subtotal: hospitalSubtotal,
        insuranceDiscount: 0,
        totalAmount: hospitalSubtotal,
        status: 'UNPAID'
      }
    });
  } else if (existingHospitalInvoice.status === 'UNPAID') {
    await tx.invoice.update({
      where: { id: existingHospitalInvoice.id },
      data: {
        items: hospitalFeeItems as unknown as Prisma.InputJsonValue,
        subtotal: hospitalSubtotal,
        totalAmount: Math.max(0, hospitalSubtotal - existingHospitalInvoice.insuranceDiscount)
      }
    });
  }

  // Create/update PRESCRIPTION invoice if prescription has items
  const rxItems = record.prescription && Array.isArray(record.prescription.items)
    ? (record.prescription.items as unknown as PrescriptionItemJson[])
    : [];

  if (record.prescription && rxItems.length > 0) {
    const rx = record.prescription;
    const rxInvoiceItems: InvoiceItemJson[] = rxItems.map((item) => ({
      id: crypto.randomUUID(),
      serviceId: null,
      medicineId: item.medicineId,
      description: `${item.medicineName} (${item.quantity} ${item.unit})`,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal
    }));

    const existingRxInvoice = await tx.invoice.findUnique({
      where: { prescriptionId: rx.id }
    });

    if (!existingRxInvoice) {
      await tx.invoice.create({
        data: {
          invoiceCode: generateHospitalCode('HD'),
          patientId: record.patientId,
          appointmentId: record.appointmentId,
          prescriptionId: rx.id,
          invoiceType: 'PRESCRIPTION',
          items: rxInvoiceItems as unknown as Prisma.InputJsonValue,
          subtotal: rx.totalAmount,
          insuranceDiscount: 0,
          totalAmount: rx.totalAmount,
          status: 'UNPAID'
        }
      });
    } else if (existingRxInvoice.status === 'UNPAID') {
      await tx.invoice.update({
        where: { id: existingRxInvoice.id },
        data: {
          items: rxInvoiceItems as unknown as Prisma.InputJsonValue,
          subtotal: rx.totalAmount,
          totalAmount: Math.max(0, rx.totalAmount - existingRxInvoice.insuranceDiscount)
        }
      });
    }
  }

  await tx.notification.create({
    data: {
      userId: record.patient.userId,
      title: `Có kết quả khám mới • ${record.recordCode}`,
      message: `${record.doctor.user.fullName} đã công bố kết quả khám (Chẩn đoán: ${
        record.diagnosis
      })${record.prescription ? ' và đơn thuốc' : ''}. Vui lòng kiểm tra mục Kết quả khám & Thanh toán.`,
      type: 'EXAM_RESULT',
      payload: {
        medicalRecordId: record.id,
        recordCode: record.recordCode,
        appointmentId: record.appointmentId,
        prescriptionId: record.prescription?.id || null
      }
    }
  });

  await tx.auditLog.create({
    data: {
      actorUserId: doctorUserId,
      action: 'RECORD_PUBLISHED',
      entityType: 'MedicalRecord',
      entityId: record.id,
      metadata: {
        recordCode: record.recordCode,
        appointmentId: record.appointmentId,
        hasPrescription: Boolean(record.prescription)
      }
    }
  });
}

export async function saveMedicalRecord(
  doctorId: string,
  doctorUserId: string,
  input: SaveRecordInput,
  existingRecordId?: string
) {
  const result = await prisma.$transaction(async (tx) => {
    let targetRecordId = existingRecordId;
    let appointmentId = input.appointmentId;

    if (existingRecordId) {
      const existing = await tx.medicalRecord.findUnique({
        where: { id: existingRecordId }
      });
      if (!existing) throw notFound('Không tìm thấy hồ sơ bệnh án');
      if (existing.doctorId !== doctorId) {
        throw forbidden('Bạn không có quyền chỉnh sửa hồ sơ bệnh án của bác sĩ khác');
      }
      appointmentId = existing.appointmentId;
    } else {
      if (!appointmentId) {
        throw badRequest('Thiếu appointmentId khi tạo hồ sơ bệnh án');
      }
      const existingByAppt = await tx.medicalRecord.findUnique({
        where: { appointmentId }
      });
      if (existingByAppt) {
        if (existingByAppt.doctorId !== doctorId) {
          throw forbidden('Bạn không có quyền chỉnh sửa hồ sơ này');
        }
        targetRecordId = existingByAppt.id;
      }
    }

    const appointment = await tx.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true }
    });
    if (!appointment) {
      throw notFound('Không tìm thấy lịch hẹn khám');
    }
    if (appointment.doctorId !== doctorId) {
      throw forbidden('Lịch hẹn này thuộc bác sĩ khác');
    }
    if (appointment.status === 'CANCELLED') {
      throw conflict('Không thể tạo hồ sơ cho lịch hẹn đã hủy');
    }

    const normalizedSpecialty: SpecialtyResultsData = {
      examFindings: input.specialtyResults?.examFindings || '',
      imagingNotes: input.specialtyResults?.imagingNotes || '',
      labOrders: Array.isArray(input.specialtyResults?.labOrders)
        ? input.specialtyResults!.labOrders
        : []
    };

    let recordId: string;
    if (targetRecordId) {
      const updated = await tx.medicalRecord.update({
        where: { id: targetRecordId },
        data: {
          symptoms: input.symptoms ?? null,
          diagnosis: input.diagnosis,
          icdCode: input.icdCode ?? null,
          clinicalNotes: input.clinicalNotes ?? null,
          treatmentPlan: input.treatmentPlan ?? null,
          specialtyResults: normalizedSpecialty as unknown as Prisma.InputJsonValue
        }
      });
      recordId = updated.id;
    } else {
      const created = await tx.medicalRecord.create({
        data: {
          recordCode: generateHospitalCode('HS'),
          appointmentId: appointment.id,
          patientId: appointment.patientId,
          doctorId,
          symptoms: input.symptoms ?? null,
          diagnosis: input.diagnosis,
          icdCode: input.icdCode ?? null,
          clinicalNotes: input.clinicalNotes ?? null,
          treatmentPlan: input.treatmentPlan ?? null,
          specialtyResults: normalizedSpecialty as unknown as Prisma.InputJsonValue,
          status: 'DRAFT'
        }
      });
      recordId = created.id;
    }

    let allergyWarnings: AllergyWarningDto[] = [];

    if (input.prescription) {
      const itemsInput = input.prescription.items || [];
      const existingRx = await tx.prescription.findUnique({
        where: { medicalRecordId: recordId }
      });

      if (existingRx && (existingRx.status === 'PAID' || existingRx.status === 'DISPENSED')) {
        if (itemsInput.length > 0) {
          throw conflict('Đơn thuốc đã thanh toán hoặc đã cấp phát, không thể sửa đổi');
        }
      } else if (itemsInput.length > 0) {
        const medicineIds = Array.from(new Set(itemsInput.map((i) => i.medicineId)));
        const medicines = await tx.medicine.findMany({
          where: { id: { in: medicineIds }, isActive: true }
        });
        if (medicines.length !== medicineIds.length) {
          throw badRequest('Một hoặc nhiều loại thuốc không tồn tại hoặc đã ngừng sử dụng');
        }

        const medMap = new Map(medicines.map((m) => [m.id, m]));
        allergyWarnings = checkMedicineAllergies(
          appointment.patient.allergies,
          appointment.patient.chronicConditions,
          medicines
        );

        const rxItemsData: PrescriptionItemJson[] = itemsInput.map((item) => {
          const med = medMap.get(item.medicineId)!;
          const lineTotal = med.unitPrice * item.quantity;
          return {
            id: crypto.randomUUID(),
            medicineId: med.id,
            medicineCode: med.code,
            medicineName: med.name,
            genericName: med.genericName,
            unit: med.unit,
            quantity: item.quantity,
            dosage: item.dosage,
            frequency: item.frequency || null,
            durationDays: item.durationDays ?? null,
            instructions: item.instructions || null,
            unitPrice: med.unitPrice,
            lineTotal
          };
        });

        const totalAmount = rxItemsData.reduce((sum, i) => sum + i.lineTotal, 0);

        if (existingRx) {
          await tx.prescription.update({
            where: { id: existingRx.id },
            data: {
              notes: input.prescription.notes || null,
              allergyWarnings: allergyWarnings as unknown as Prisma.InputJsonValue,
              items: rxItemsData as unknown as Prisma.InputJsonValue,
              totalAmount
            }
          });
        } else {
          await tx.prescription.create({
            data: {
              prescriptionCode: generateHospitalCode('DT'),
              medicalRecordId: recordId,
              patientId: appointment.patientId,
              doctorId,
              notes: input.prescription.notes || null,
              allergyWarnings: allergyWarnings as unknown as Prisma.InputJsonValue,
              items: rxItemsData as unknown as Prisma.InputJsonValue,
              totalAmount,
              status: 'PENDING_PAYMENT'
            }
          });
        }
      } else if (existingRx && existingRx.status === 'PENDING_PAYMENT') {
        await tx.prescription.delete({ where: { id: existingRx.id } });
      }
    }

    if (input.publish) {
      await publishRecordTx(tx, recordId, doctorUserId, input.orderedServiceIds || []);
    }

    const fullRecord = await tx.medicalRecord.findUniqueOrThrow({
      where: { id: recordId },
      include: MEDICAL_RECORD_INCLUDE
    });

    const invoices = await tx.invoice.findMany({
      where: { appointmentId: fullRecord.appointmentId },
      include: INVOICE_INCLUDE
    });

    return {
      medicalRecord: formatMedicalRecordDto(fullRecord),
      prescription: fullRecord.prescription
        ? formatPrescriptionDto(fullRecord.prescription)
        : null,
      invoices: invoices.map(formatInvoiceDto),
      allergyWarnings
    };
  });

  return result;
}

export async function publishExistingMedicalRecord(
  recordId: string,
  doctorId: string,
  doctorUserId: string,
  orderedServiceIds: string[] = []
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.medicalRecord.findUnique({ where: { id: recordId } });
    if (!existing) throw notFound('Không tìm thấy hồ sơ bệnh án');
    if (existing.doctorId !== doctorId) {
      throw forbidden('Bạn không có quyền công bố hồ sơ của bác sĩ khác');
    }

    await publishRecordTx(tx, recordId, doctorUserId, orderedServiceIds);

    const fullRecord = await tx.medicalRecord.findUniqueOrThrow({
      where: { id: recordId },
      include: MEDICAL_RECORD_INCLUDE
    });
    const invoices = await tx.invoice.findMany({
      where: { appointmentId: fullRecord.appointmentId },
      include: INVOICE_INCLUDE
    });

    return {
      medicalRecord: formatMedicalRecordDto(fullRecord),
      prescription: fullRecord.prescription
        ? formatPrescriptionDto(fullRecord.prescription)
        : null,
      invoices: invoices.map(formatInvoiceDto)
    };
  });
}
