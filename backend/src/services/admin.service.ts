import { prisma } from '../config/prisma';
import { addDays, formatDateOnly, getTodayDateString, toDateOnly } from '../utils/date';
import { APPOINTMENT_FULL_INCLUDE, formatAppointmentDto } from './appointment.service';
import { getBedsWithStats } from './bed.service';

export async function getAdminDashboardData(dateInput?: string) {
  const targetDateStr = dateInput || getTodayDateString();
  const targetDate = toDateOnly(targetDateStr);
  const yesterdayStr = addDays(targetDateStr, -1);
  const yesterdayDate = toDateOnly(yesterdayStr);

  const fourteenDaysAgoStr = addDays(targetDateStr, -13);
  const fourteenDaysAgoDate = toDateOnly(fourteenDaysAgoStr);

  const [
    todayAppts,
    yesterdayCount,
    rangeAppts,
    doctors,
    bedStats,
    paidInvoices,
    unpaidInvoices
  ] = await Promise.all([
    prisma.appointment.findMany({
      where: { appointmentDate: targetDate },
      include: APPOINTMENT_FULL_INCLUDE,
      orderBy: [{ session: 'asc' }, { queueNumber: 'asc' }]
    }),
    prisma.appointment.count({
      where: {
        appointmentDate: yesterdayDate,
        status: { not: 'CANCELLED' }
      }
    }),
    prisma.appointment.findMany({
      where: {
        appointmentDate: { gte: fourteenDaysAgoDate, lte: targetDate },
        status: { not: 'CANCELLED' }
      },
      select: { appointmentDate: true }
    }),
    prisma.doctor.findMany({
      where: { user: { isActive: true } },
      include: {
        user: true,
        department: true,
        room: true
      },
      orderBy: { user: { fullName: 'asc' } }
    }),
    getBedsWithStats({}),
    prisma.invoice.findMany({
      where: { status: 'PAID' },
      select: {
        invoiceType: true,
        totalAmount: true,
        paidAt: true
      }
    }),
    prisma.invoice.findMany({
      where: { status: { in: ['UNPAID', 'PENDING_VERIFICATION'] } },
      select: { totalAmount: true }
    })
  ]);

  const nonCancelledToday = todayAppts.filter((a) => a.status !== 'CANCELLED');
  const todayVisitsCount = nonCancelledToday.length;
  const percentChange =
    yesterdayCount > 0
      ? Math.round(((todayVisitsCount - yesterdayCount) / yesterdayCount) * 100)
      : todayVisitsCount > 0
        ? 100
        : 0;

  const upcomingCount = todayAppts.filter((a) =>
    ['BOOKED', 'CHECKED_IN'].includes(a.status)
  ).length;
  const inProgressCount = todayAppts.filter((a) => a.status === 'IN_PROGRESS').length;
  const completedCount = todayAppts.filter((a) => a.status === 'COMPLETED').length;
  const cancelledCount = todayAppts.filter((a) => a.status === 'CANCELLED').length;

  // On-duty doctors grouped by department
  const onDutyDoctors = doctors.filter((d) => d.isOnDuty);
  const deptDoctorCount = new Map<string, number>();
  for (const doc of onDutyDoctors) {
    deptDoctorCount.set(
      doc.department.name,
      (deptDoctorCount.get(doc.department.name) || 0) + 1
    );
  }

  const todayCountByDoctor = new Map<string, number>();
  for (const appt of nonCancelledToday) {
    todayCountByDoctor.set(appt.doctorId, (todayCountByDoctor.get(appt.doctorId) || 0) + 1);
  }

  // 7-day visits comparison (last 7 days vs prior 7 days)
  const countsByDate = new Map<string, number>();
  for (const row of rangeAppts) {
    const key = formatDateOnly(row.appointmentDate);
    countsByDate.set(key, (countsByDate.get(key) || 0) + 1);
  }

  const visitsComparison7Days: {
    date: string;
    label: string;
    currentWeekCount: number;
    previousWeekCount: number;
  }[] = [];

  for (let offset = -6; offset <= 0; offset++) {
    const currDate = addDays(targetDateStr, offset);
    const prevDate = addDays(currDate, -7);
    const [, mm, dd] = currDate.split('-');
    visitsComparison7Days.push({
      date: currDate,
      label: `${dd}/${mm}`,
      currentWeekCount: countsByDate.get(currDate) || 0,
      previousWeekCount: countsByDate.get(prevDate) || 0
    });
  }

  // Revenue analytics
  let totalPaid = 0;
  let hospitalFeesPaid = 0;
  let prescriptionsPaid = 0;
  let todayRevenue = 0;
  let monthRevenue = 0;
  const targetMonthPrefix = targetDateStr.slice(0, 7);

  for (const inv of paidInvoices) {
    totalPaid += inv.totalAmount;
    if (inv.invoiceType === 'HOSPITAL_FEE') hospitalFeesPaid += inv.totalAmount;
    if (inv.invoiceType === 'PRESCRIPTION') prescriptionsPaid += inv.totalAmount;

    if (inv.paidAt) {
      const paidDateStr = formatDateOnly(inv.paidAt);
      if (paidDateStr === targetDateStr) {
        todayRevenue += inv.totalAmount;
      }
      if (paidDateStr.startsWith(targetMonthPrefix)) {
        monthRevenue += inv.totalAmount;
      }
    }
  }

  const totalUnpaid = unpaidInvoices.reduce((sum, i) => sum + i.totalAmount, 0);

  return {
    date: targetDateStr,
    kpis: {
      todayVisits: {
        count: todayVisitsCount,
        yesterdayCount,
        percentChange
      },
      todayAppointments: {
        total: todayAppts.length,
        upcoming: upcomingCount,
        inProgress: inProgressCount,
        completed: completedCount,
        cancelled: cancelledCount
      },
      onDutyDoctors: {
        count: onDutyDoctors.length,
        totalDoctors: doctors.length,
        byDepartment: Array.from(deptDoctorCount.entries()).map(([departmentName, count]) => ({
          departmentName,
          count
        }))
      },
      bedOccupancy: bedStats.summary
    },
    visitsComparison7Days,
    onDutyDoctorsList: onDutyDoctors.map((doc) => ({
      id: doc.id,
      fullName: doc.user.fullName,
      title: doc.title,
      specialty: doc.specialty,
      departmentName: doc.department.name,
      roomName: doc.room ? doc.room.name : null,
      isOnDuty: doc.isOnDuty,
      todayQueueCount: todayCountByDoctor.get(doc.id) || 0
    })),
    todayAppointmentsList: todayAppts.map((a) => formatAppointmentDto(a, null)),
    bedOccupancyByDepartment: bedStats.byDepartment,
    revenueSummary: {
      totalPaid,
      totalUnpaid,
      hospitalFeesPaid,
      prescriptionsPaid,
      todayRevenue,
      monthRevenue
    }
  };
}

function escapeCsvCell(val: unknown): string {
  const str = val === null || val === undefined ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => row.map(escapeCsvCell).join(','))
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function generateCsvReport(
  type: 'appointments' | 'revenue' | 'beds' | 'patients',
  from?: string,
  to?: string
): Promise<{ filename: string; csv: string }> {
  const today = getTodayDateString();
  const dateFilter =
    from || to
      ? {
          ...(from ? { gte: toDateOnly(from) } : {}),
          ...(to ? { lte: toDateOnly(to) } : {})
        }
      : undefined;

  if (type === 'appointments') {
    const appts = await prisma.appointment.findMany({
      where: dateFilter ? { appointmentDate: dateFilter } : undefined,
      include: {
        patient: { include: { user: true } },
        doctor: { include: { user: true } },
        department: true
      },
      orderBy: [{ appointmentDate: 'desc' }, { session: 'asc' }, { queueNumber: 'asc' }]
    });

    const csv = buildCsv(
      [
        'Mã lịch hẹn',
        'Ngày khám',
        'Buổi',
        'STT',
        'Giờ dự kiến',
        'Mã BN',
        'Bệnh nhân',
        'Khoa',
        'Bác sĩ',
        'Hình thức',
        'Trạng thái'
      ],
      appts.map((a) => [
        a.appointmentCode,
        formatDateOnly(a.appointmentDate),
        a.session === 'MORNING' ? 'Buổi Sáng' : 'Buổi Chiều',
        a.queueNumber,
        a.estimatedTime,
        a.patient.patientCode,
        a.patient.user.fullName,
        a.department.name,
        a.doctor.user.fullName,
        a.bookingType,
        a.status
      ])
    );

    return { filename: `bao-cao-lich-hen-${today}.csv`, csv };
  }

  if (type === 'revenue') {
    const invoices = await prisma.invoice.findMany({
      where:
        from || to
          ? {
              createdAt: {
                ...(from ? { gte: toDateOnly(from) } : {}),
                ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {})
              }
            }
          : undefined,
      include: {
        patient: { include: { user: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const csv = buildCsv(
      [
        'Mã hóa đơn',
        'Loại hóa đơn',
        'Mã BN',
        'Bệnh nhân',
        'Tạm tính (VND)',
        'Giảm trừ (VND)',
        'Tổng tiền (VND)',
        'Trạng thái',
        'Ngày tạo',
        'Ngày thanh toán'
      ],
      invoices.map((inv) => [
        inv.invoiceCode,
        inv.invoiceType === 'HOSPITAL_FEE' ? 'Viện phí' : 'Đơn thuốc',
        inv.patient.patientCode,
        inv.patient.user.fullName,
        inv.subtotal,
        inv.insuranceDiscount,
        inv.totalAmount,
        inv.status,
        inv.createdAt.toISOString(),
        inv.paidAt ? inv.paidAt.toISOString() : ''
      ])
    );

    return { filename: `bao-cao-doanh-thu-${today}.csv`, csv };
  }

  if (type === 'beds') {
    const beds = await prisma.bed.findMany({
      include: {
        department: true,
        room: true,
        currentPatient: { include: { user: true } }
      },
      orderBy: [{ department: { name: 'asc' } }, { bedNumber: 'asc' }]
    });

    const csv = buildCsv(
      ['Số giường', 'Khoa', 'Phòng', 'Trạng thái', 'Mã BN', 'Bệnh nhân nằm giường', 'Ngày nhập'],
      beds.map((b) => [
        b.bedNumber,
        b.department.name,
        b.room.name,
        b.status,
        b.currentPatient?.patientCode || '',
        b.currentPatient?.user.fullName || '',
        b.admittedAt ? b.admittedAt.toISOString() : ''
      ])
    );

    return { filename: `bao-cao-giuong-benh-${today}.csv`, csv };
  }

  // patients
  const patients = await prisma.patient.findMany({
    include: { user: true },
    orderBy: { patientCode: 'asc' }
  });

  const csv = buildCsv(
    ['Mã BN', 'Họ tên', 'Email', 'Số điện thoại', 'Ngày sinh', 'Giới tính', 'Nhóm máu', 'Số BHYT'],
    patients.map((p) => [
      p.patientCode,
      p.user.fullName,
      p.user.email,
      p.user.phone || '',
      p.dateOfBirth ? formatDateOnly(p.dateOfBirth) : '',
      p.gender || '',
      p.bloodType || '',
      p.insuranceNumber || ''
    ])
  );

  return { filename: `bao-cao-benh-nhan-${today}.csv`, csv };
}
