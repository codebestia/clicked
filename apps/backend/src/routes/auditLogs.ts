/**
 * GET /audit-logs — a user's own security history (#376).
 *
 * Scoped to the caller: there is no parameter for whose log to read, so a
 * compromised token cannot be used to enumerate anyone else's security events.
 * Returns events where the caller was either the actor or the subject, newest
 * first, cursor-paginated.
 */
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { auditActionEnum, type AuditAction } from '../db/schema.js';
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  MAX_AUDIT_PAGE_SIZE,
  queryAuditLog,
} from '../services/auditLog.js';

export const auditLogsRouter: RouterType = Router();

auditLogsRouter.use(requireAuth);
auditLogsRouter.use(rateLimit('audit_logs'));

export const AuditLogsQuerySchema = z.object({
  action: z.enum(auditActionEnum.enumValues).optional(),
  limit: z.coerce.number().int().positive().optional().default(DEFAULT_AUDIT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});

auditLogsRouter.get('/', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  const parsed = AuditLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    if (req.query['action'] && !auditActionEnum.enumValues.includes(req.query['action'] as any)) {
      res.status(400).json({
        error: 'Unknown action filter',
        allowed: auditActionEnum.enumValues,
      });
      return;
    }
    res.status(400).json({
      error: 'Invalid query parameters',
      details: parsed.error.issues,
    });
    return;
  }

  const { action, limit, cursor } = parsed.data;

  try {
    const { events, nextCursor, hasMore } = await queryAuditLog({
      userId,
      ...(action ? { action: action as AuditAction } : {}),
      ...(cursor ? { cursor } : {}),
      limit: Math.min(limit, MAX_AUDIT_PAGE_SIZE),
    });

    res.json({
      events: events.map((event) => ({
        id: event.id,
        action: event.action,
        actorUserId: event.actorUserId,
        actorDeviceId: event.actorDeviceId,
        subjectUserId: event.subjectUserId,
        targetType: event.targetType,
        targetId: event.targetId,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        metadata: event.metadata,
        createdAt: event.createdAt,
        // Whether this was something the account did, or something done to it.
        direction: event.actorUserId === userId ? 'performed' : 'received',
      })),
      // Null once the end is reached, so a client pages until it is null.
      nextCursor,
      hasMore,
    });
  } catch {
    res.status(500).json({ error: 'Failed to read audit log' });
  }
});