import { Router } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { forbidden, notFound } from '../utils/errors';
import { sendSuccess } from '../utils/response';

const router = Router();

router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === 'true';
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const userId = req.user!.userId;

    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: {
          userId,
          ...(unreadOnly ? { isRead: false } : {})
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      }),
      prisma.notification.count({
        where: { userId, isRead: false }
      })
    ]);

    return sendSuccess(res, {
      items: items.map((n) => ({
        ...n,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString()
      })),
      unreadCount
    });
  })
);

router.patch(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user!.userId, isRead: false },
      data: { isRead: true, readAt: new Date() }
    });
    return sendSuccess(res, { updatedCount: result.count });
  })
);

router.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const existing = await prisma.notification.findUnique({
      where: { id: req.params.id }
    });
    if (!existing) throw notFound('Không tìm thấy thông báo');
    if (existing.userId !== req.user!.userId) {
      throw forbidden('Bạn không có quyền truy cập thông báo này');
    }

    const updated = await prisma.notification.update({
      where: { id: existing.id },
      data: { isRead: true, readAt: existing.readAt || new Date() }
    });

    return sendSuccess(res, {
      ...updated,
      readAt: updated.readAt ? updated.readAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString()
    });
  })
);

export default router;
