import { Prisma } from '@prisma/client';
import { InvoiceItemJson } from '../types';

export const INVOICE_INCLUDE = {
  patient: { include: { user: true } },
  appointment: { select: { appointmentCode: true } },
  prescription: { select: { prescriptionCode: true } },
  payments: {
    include: {
      confirmedByNurse: { include: { user: true } }
    },
    orderBy: { createdAt: 'desc' as const }
  }
} as const;

export type InvoiceWithRelations = Prisma.InvoiceGetPayload<{
  include: typeof INVOICE_INCLUDE;
}>;

export function formatInvoiceDto(inv: InvoiceWithRelations) {
  const rawItems = Array.isArray(inv.items)
    ? (inv.items as unknown as InvoiceItemJson[])
    : [];

  return {
    id: inv.id,
    invoiceCode: inv.invoiceCode,
    patientId: inv.patientId,
    patientCode: inv.patient.patientCode,
    patientName: inv.patient.user.fullName,
    appointmentId: inv.appointmentId,
    appointmentCode: inv.appointment ? inv.appointment.appointmentCode : null,
    prescriptionId: inv.prescriptionId,
    prescriptionCode: inv.prescription ? inv.prescription.prescriptionCode : null,
    invoiceType: inv.invoiceType,
    subtotal: inv.subtotal,
    insuranceDiscount: inv.insuranceDiscount,
    totalAmount: inv.totalAmount,
    status: inv.status,
    paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
    createdAt: inv.createdAt.toISOString(),
    items: rawItems.map((i, idx) => ({
      id: i.id || `${inv.id}-item-${idx + 1}`,
      serviceId: i.serviceId ?? null,
      medicineId: i.medicineId ?? null,
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal
    })),
    payments: inv.payments.map((p) => ({
      id: p.id,
      paymentCode: p.paymentCode,
      invoiceId: p.invoiceId,
      invoiceCode: inv.invoiceCode,
      patientId: p.patientId,
      patientCode: inv.patient.patientCode,
      patientName: inv.patient.user.fullName,
      amount: p.amount,
      method: p.method,
      status: p.status,
      qrReference: p.qrReference,
      confirmedByNurseName: p.confirmedByNurse ? p.confirmedByNurse.user.fullName : null,
      confirmedAt: p.confirmedAt ? p.confirmedAt.toISOString() : null,
      notes: p.notes,
      createdAt: p.createdAt.toISOString()
    }))
  };
}
