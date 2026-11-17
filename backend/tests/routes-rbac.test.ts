import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  department: { findMany: vi.fn() },
  doctor: { findMany: vi.fn() },
  doctorSchedule: { findMany: vi.fn() },
  appointment: { findMany: vi.fn() },
  bed: { findMany: vi.fn() },
  patient: { findMany: vi.fn() },
  invoice: { findMany: vi.fn() }
}));

vi.mock('../src/config/prisma', () => ({ prisma: mockPrisma }));

import { createApp } from '../src/app';
import { signAuthToken } from '../src/middleware/auth';

const app = createApp();

describe('Express Routes, RBAC Enforcement & Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 on GET /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });

  it('validates login payload and issues JWT for valid user', async () => {
    const badRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: '' });
    expect(badRes.status).toBe(400);
    expect(badRes.body.success).toBe(false);

    const passwordHash = await bcrypt.hash('123456', 4);
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-pat-1',
      email: 'minhanh.patient@antam.vn',
      passwordHash,
      fullName: 'Lê Minh Anh',
      phone: '0909123450',
      role: 'PATIENT',
      avatarUrl: null,
      isActive: true,
      patientProfile: {
        id: 'pat-1',
        patientCode: 'BN-08250',
        dateOfBirth: new Date('1996-05-14T00:00:00.000Z'),
        gender: 'FEMALE',
        address: 'TP.HCM',
        nationalId: null,
        insuranceNumber: 'DN47908250',
        bloodType: 'O+',
        allergies: [],
        chronicConditions: [],
        emergencyContact: null
      },
      doctorProfile: null,
      nurseProfile: null
    });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'minhanh.patient@antam.vn', password: '123456' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);
    expect(loginRes.body.data.token).toBeTruthy();
    expect(loginRes.body.data.user.role).toBe('PATIENT');
  });

  it('enforces 401 when unauthenticated and 403 RBAC across portals', async () => {
    const unauth = await request(app).get('/api/patient/appointments');
    expect(unauth.status).toBe(401);

    const patientToken = signAuthToken({
      userId: 'u-pat-1',
      email: 'p@antam.vn',
      role: 'PATIENT'
    });
    const doctorToken = signAuthToken({
      userId: 'u-doc-1',
      email: 'd@antam.vn',
      role: 'DOCTOR'
    });
    const nurseToken = signAuthToken({
      userId: 'u-nurse-1',
      email: 'n@antam.vn',
      role: 'NURSE'
    });

    // Patient blocked from Doctor, Nurse, Admin portals
    expect(
      (await request(app).get('/api/doctor/queue').set('Authorization', `Bearer ${patientToken}`))
        .status
    ).toBe(403);
    expect(
      (await request(app).get('/api/nurse/beds').set('Authorization', `Bearer ${patientToken}`))
        .status
    ).toBe(403);
    expect(
      (await request(app).get('/api/admin/dashboard').set('Authorization', `Bearer ${patientToken}`))
        .status
    ).toBe(403);

    // Doctor blocked from Patient, Nurse, Admin portals
    expect(
      (
        await request(app)
          .get('/api/patient/appointments')
          .set('Authorization', `Bearer ${doctorToken}`)
      ).status
    ).toBe(403);
    expect(
      (await request(app).get('/api/nurse/payments').set('Authorization', `Bearer ${doctorToken}`))
        .status
    ).toBe(403);
    expect(
      (await request(app).get('/api/admin/dashboard').set('Authorization', `Bearer ${doctorToken}`))
        .status
    ).toBe(403);

    // Nurse blocked from Doctor & Admin portals
    expect(
      (await request(app).get('/api/doctor/queue').set('Authorization', `Bearer ${nurseToken}`))
        .status
    ).toBe(403);
    expect(
      (await request(app).get('/api/admin/departments').set('Authorization', `Bearer ${nurseToken}`))
        .status
    ).toBe(403);
  });

  it('supports public 3-flow schedule availability query', async () => {
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
        lastQueueNumber: 2,
        isAvailable: true,
        doctor: {
          id: 'doc-1',
          doctorCode: 'BS-001',
          specialty: 'Nội tổng quát',
          title: 'ThS.BS',
          consultationFee: 150000,
          departmentId: 'dept-1',
          user: { fullName: 'BS. Hoàng Minh Long' },
          department: { name: 'Nội tổng quát' },
          room: { name: 'Phòng 201' }
        }
      }
    ]);
    mockPrisma.appointment.findMany.mockResolvedValue([]);

    const res = await request(app).get(
      '/api/schedules/availability?flow=BY_DATE&date=2026-11-18&session=MORNING'
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data[0].session).toBe('MORNING');
    expect(res.body.data[0].nextQueueNumber).toBe(3);
  });

  it('exports UTF-8 BOM CSV reports for ADMIN role', async () => {
    const adminToken = signAuthToken({
      userId: 'u-admin-1',
      email: 'admin@antam.vn',
      role: 'ADMIN'
    });
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        appointmentCode: 'LH-TODAY-001',
        appointmentDate: new Date('2026-11-17T00:00:00.000Z'),
        session: 'MORNING',
        queueNumber: 1,
        estimatedTime: '07:30',
        bookingType: 'ONLINE',
        status: 'BOOKED',
        patient: { patientCode: 'BN-08250', user: { fullName: 'Lê Minh Anh' } },
        doctor: { user: { fullName: 'BS. Hoàng Minh Long' } },
        department: { name: 'Nội tổng quát' }
      }
    ]);

    const res = await request(app)
      .get('/api/admin/reports/export?type=appointments')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    expect(res.text).toContain('LH-TODAY-001');
    expect(res.text).toContain('Lê Minh Anh');
  });
});
