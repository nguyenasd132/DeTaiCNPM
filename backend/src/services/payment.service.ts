import { prisma } from '../config/prisma';
import { PaymentMethod, PrescriptionItemJson } from '../types';
import { generateHospitalCode } from '../utils/codes';
import { conflict, forbidden, notFound } from '../utils/errors';
import { formatInvoiceDto, INVOICE_INCLUDE } from './invoice.formatter';
import { formatPrescriptionDto, PRESCRIPTION_INCLUDE } from './record.service';

export { formatInvoiceDto, INVOICE_INCLUDE };

export async function initiatePatientPayment(
  patientId: string,
  userId: string,
  input: { invoiceId: string; method: 'QR_TRANSFER' | 'COUNTER_CASH'; notes?: string }
) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: input.invoiceId },
      include: { patient: { include: { user: true } } }
    });
    if (!invoice) throw notFound('Không tìm thấy hóa đơn');
    if (invoice.patientId !== patientId) {
      throw forbidden('Hóa đơn này không thuộc về bạn');
    }
    if (invoice.status === 'PAID') {
      throw conflict('Hóa đơn này đã được thanh toán');
    }
    if (invoice.status === 'CANCELLED') {
      throw conflict('Hóa đơn đã bị hủy');
    }

    await tx.payment.updateMany({
      where: { invoiceId: invoice.id, status: 'PENDING' },
      data: { status: 'FAILED', notes: 'Thay thế bởi yêu cầu thanh toán mới' }
    });

    const qrReference =
      input.method === 'QR_TRANSFER' ? `ANTAM-${invoice.invoiceCode}` : null;

    const payment = await tx.payment.create({
      data: {
        paymentCode: generateHospitalCode('TT'),
        invoiceId: invoice.id,
        patientId,
        amount: invoice.totalAmount,
        method: input.method,
        status: 'PENDING',
        qrReference,
        notes: input.notes?.trim() || null
      }
    });

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PENDING_VERIFICATION' }
    });

    await tx.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'PAYMENT_INITIATED',
        entityType: 'Payment',
        entityId: payment.id,
        metadata: {
          invoiceCode: invoice.invoiceCode,
          method: input.method,
          amount: invoice.totalAmount
        }
      }
    });

    const fullInvoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: INVOICE_INCLUDE
    });

    return {
      payment: {
        id: payment.id,
        paymentCode: payment.paymentCode,
        invoiceId: payment.invoiceId,
        invoiceCode: invoice.invoiceCode,
        patientId: payment.patientId,
        patientCode: invoice.patient.patientCode,
        patientName: invoice.patient.user.fullName,
        amount: payment.amount,
        method: payment.method,
        status: payment.status,
        qrReference: payment.qrReference,
        confirmedByNurseName: null,
        confirmedAt: null,
        notes: payment.notes,
        createdAt: payment.createdAt.toISOString()
      },
      invoice: formatInvoiceDto(fullInvoice),
      ...(input.method === 'QR_TRANSFER'
        ? {
            qrInfo: {
              bankName: 'Vietcombank - CN TP.HCM',
              accountNumber: '1029384756',
              accountName: 'BENH VIEN DA KHOA AN TAM',
              amount: invoice.totalAmount,
              transferContent: `ANTAM ${invoice.invoiceCode}`,
              qrDataString: `ANTAM|VCB|1029384756|${invoice.totalAmount}|${invoice.invoiceCode}`
            }
          }
        : {})
    };
  });
}

export async function confirmNursePayment(
  idOrInvoiceId: string,
  nurseId: string,
  nurseUserId: string,
  input: { method?: PaymentMethod; notes?: string }
) {
  return prisma.$transaction(async (tx) => {
    const maybePayment = await tx.payment.findUnique({ where: { id: idOrInvoiceId } });
    const targetInvoiceId = maybePayment ? maybePayment.invoiceId : idOrInvoiceId;

    const lockedInvoices = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text AS status
      FROM invoices
      WHERE id = ${targetInvoiceId}
      FOR UPDATE
    `;
    if (!lockedInvoices || lockedInvoices.length === 0) {
      throw notFound('Không tìm thấy hóa đơn cần xác nhận thanh toán');
    }

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: targetInvoiceId },
      include: { patient: true }
    });

    if (invoice.status === 'PAID') {
      throw conflict('Hóa đơn này đã được xác nhận thanh toán trước đó');
    }
    if (invoice.status === 'CANCELLED') {
      throw conflict('Hóa đơn đã bị hủy, không thể xác nhận thanh toán');
    }

    const now = new Date();
    const pendingPayment =
      maybePayment && maybePayment.status === 'PENDING'
        ? maybePayment
        : await tx.payment.findFirst({
            where: { invoiceId: invoice.id, status: 'PENDING' },
            orderBy: { createdAt: 'desc' }
          });

    const confirmedPayment = pendingPayment
      ? await tx.payment.update({
          where: { id: pendingPayment.id },
          data: {
            status: 'CONFIRMED',
            method: input.method || pendingPayment.method,
            confirmedByNurseId: nurseId,
            confirmedAt: now,
            notes: input.notes?.trim() || pendingPayment.notes
          }
        })
      : await tx.payment.create({
          data: {
            paymentCode: generateHospitalCode('TT'),
            invoiceId: invoice.id,
            patientId: invoice.patientId,
            amount: invoice.totalAmount,
            method: input.method || 'COUNTER_CASH',
            status: 'CONFIRMED',
            confirmedByNurseId: nurseId,
            confirmedAt: now,
            notes: input.notes?.trim() || 'Thu tiền trực tiếp tại quầy'
          }
        });

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'PAID',
        paidAt: now
      }
    });

    let updatedPrescription = null;
    if (invoice.prescriptionId) {
      const rx = await tx.prescription.findUnique({ where: { id: invoice.prescriptionId } });
      if (rx && rx.status === 'PENDING_PAYMENT') {
        const savedRx = await tx.prescription.update({
          where: { id: rx.id },
          data: { status: 'PAID' },
          include: PRESCRIPTION_INCLUDE
        });
        updatedPrescription = formatPrescriptionDto(savedRx);
      } else if (rx) {
        const fullRx = await tx.prescription.findUniqueOrThrow({
          where: { id: rx.id },
          include: PRESCRIPTION_INCLUDE
        });
        updatedPrescription = formatPrescriptionDto(fullRx);
      }
    }

    await tx.notification.create({
      data: {
        userId: invoice.patient.userId,
        title: `Thanh toán thành công • ${invoice.invoiceCode}`,
        message: `Hóa đơn ${invoice.invoiceCode} (${invoice.totalAmount.toLocaleString(
          'vi-VN'
        )}đ) đã được xác nhận thanh toán.${
          invoice.prescriptionId ? ' Vui lòng đến quầy dược để nhận thuốc.' : ''
        }`,
        type: 'PAYMENT',
        payload: {
          invoiceId: invoice.id,
          invoiceCode: invoice.invoiceCode,
          paymentId: confirmedPayment.id,
          prescriptionId: invoice.prescriptionId
        }
      }
    });

    await tx.auditLog.create({
      data: {
        actorUserId: nurseUserId,
        action: 'PAYMENT_CONFIRMED',
        entityType: 'Payment',
        entityId: confirmedPayment.id,
        metadata: {
          invoiceId: invoice.id,
          invoiceCode: invoice.invoiceCode,
          prescriptionId: invoice.prescriptionId,
          amount: invoice.totalAmount,
          method: confirmedPayment.method
        }
      }
    });

    const fullInvoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: INVOICE_INCLUDE
    });

    const formattedInvoice = formatInvoiceDto(fullInvoice);
    const formattedPayment = formattedInvoice.payments.find(
      (p) => p.id === confirmedPayment.id
    )!;

    return {
      payment: formattedPayment,
      invoice: formattedInvoice,
      prescription: updatedPrescription
    };
  });
}

export async function rejectNursePayment(
  idOrInvoiceId: string,
  nurseId: string,
  nurseUserId: string,
  reason?: string
) {
  return prisma.$transaction(async (tx) => {
    const maybePayment = await tx.payment.findUnique({ where: { id: idOrInvoiceId } });
    const targetInvoiceId = maybePayment ? maybePayment.invoiceId : idOrInvoiceId;

    const invoice = await tx.invoice.findUnique({
      where: { id: targetInvoiceId },
      include: { patient: true }
    });
    if (!invoice) throw notFound('Không tìm thấy hóa đơn');
    if (invoice.status === 'PAID') {
      throw conflict('Hóa đơn đã thanh toán, không thể từ chối');
    }

    const pendingPayment =
      maybePayment ||
      (await tx.payment.findFirst({
        where: { invoiceId: invoice.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' }
      }));

    if (!pendingPayment) {
      throw conflict('Không có giao dịch chờ xác nhận để từ chối');
    }

    await tx.payment.update({
      where: { id: pendingPayment.id },
      data: {
        status: 'REJECTED',
        confirmedByNurseId: nurseId,
        confirmedAt: new Date(),
        notes: reason?.trim() || 'Chưa nhận được tiền chuyển khoản'
      }
    });

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'UNPAID' }
    });

    await tx.notification.create({
      data: {
        userId: invoice.patient.userId,
        title: `Giao dịch chưa được xác nhận • ${invoice.invoiceCode}`,
        message: `Giao dịch thanh toán cho hóa đơn ${invoice.invoiceCode} bị từ chối (${
          reason?.trim() || 'Chưa đối soát được giao dịch'
        }). Vui lòng kiểm tra lại hoặc thanh toán tại quầy.`,
        type: 'PAYMENT',
        payload: { invoiceId: invoice.id, paymentId: pendingPayment.id }
      }
    });

    await tx.auditLog.create({
      data: {
        actorUserId: nurseUserId,
        action: 'PAYMENT_REJECTED',
        entityType: 'Payment',
        entityId: pendingPayment.id,
        metadata: { invoiceId: invoice.id, reason }
      }
    });

    const fullInvoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: INVOICE_INCLUDE
    });
    const formattedInvoice = formatInvoiceDto(fullInvoice);

    return {
      payment: formattedInvoice.payments.find((p) => p.id === pendingPayment.id),
      invoice: formattedInvoice
    };
  });
}

export async function dispenseNursePrescription(
  prescriptionId: string,
  nurseId: string,
  nurseUserId: string
) {
  return prisma.$transaction(async (tx) => {
    const rx = await tx.prescription.findUnique({
      where: { id: prescriptionId },
      include: {
        patient: true
      }
    });
    if (!rx) throw notFound('Không tìm thấy đơn thuốc');

    if (rx.status === 'PENDING_PAYMENT') {
      throw conflict('Đơn thuốc chưa được thanh toán, vui lòng thu tiền trước khi cấp phát');
    }
    if (rx.status === 'DISPENSED') {
      throw conflict('Đơn thuốc này đã được cấp phát trước đó');
    }
    if (rx.status === 'CANCELLED') {
      throw conflict('Đơn thuốc đã bị hủy');
    }

    const rxItems = Array.isArray(rx.items)
      ? (rx.items as unknown as PrescriptionItemJson[])
      : [];

    for (const item of rxItems) {
      const updated = await tx.medicine.updateMany({
        where: {
          id: item.medicineId,
          stockQuantity: { gte: item.quantity }
        },
        data: {
          stockQuantity: { decrement: item.quantity }
        }
      });
      if (updated.count === 0) {
        throw conflict(
          `Thuốc ${item.medicineName} không đủ tồn kho (cần ${item.quantity} ${item.unit})`,
          undefined,
          'INSUFFICIENT_STOCK'
        );
      }
    }

    const now = new Date();
    const dispensed = await tx.prescription.update({
      where: { id: rx.id },
      data: {
        status: 'DISPENSED',
        dispensedByNurseId: nurseId,
        dispensedAt: now
      },
      include: PRESCRIPTION_INCLUDE
    });

    await tx.notification.create({
      data: {
        userId: rx.patient.userId,
        title: `Đã cấp phát thuốc • ${rx.prescriptionCode}`,
        message: `Đơn thuốc ${rx.prescriptionCode} đã được cấp phát đầy đủ. Chúc bạn mau khỏe!`,
        type: 'PRESCRIPTION',
        payload: { prescriptionId: rx.id, prescriptionCode: rx.prescriptionCode }
      }
    });

    await tx.auditLog.create({
      data: {
        actorUserId: nurseUserId,
        action: 'PRESCRIPTION_DISPENSED',
        entityType: 'Prescription',
        entityId: rx.id,
        metadata: { prescriptionCode: rx.prescriptionCode }
      }
    });

    return formatPrescriptionDto(dispensed);
  });
}
