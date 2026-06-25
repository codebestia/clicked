/**
 * Device revocation core logic (#157).
 *
 * Soft-revokes a device: stamps `revokedAt`, deletes its one-time prekeys, and
 * reports the conversations whose peers must be notified of the key change. All
 * state changes run in a single transaction, and the "cannot revoke the last
 * active device" rule is enforced atomically inside the UPDATE so two concurrent
 * revokes can never strip a user of their final device.
 *
 * Socket teardown and bus/peer notifications are the caller's responsibility
 * (see routes/devices.ts) — this module owns persistence only, which keeps it
 * unit-testable without a Socket.IO server or Redis.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { devices, devicePrekeys, conversationMembers } from '../db/schema.js';
import type { Device } from '../db/schema.js';

export type RevokeDeviceResult =
  | { ok: true; device: Device; conversationIds: string[] }
  | { ok: false; status: 403 | 404 | 409; error: string };

/** Count of a user's devices that are still active (not revoked). */
export async function countActiveDevices(userId: string): Promise<number> {
  return db.$count(devices, and(eq(devices.userId, userId), isNull(devices.revokedAt)));
}

export async function revokeDevice(userId: string, deviceId: string): Promise<RevokeDeviceResult> {
  const device = await db.query.devices.findFirst({ where: eq(devices.id, deviceId) });

  if (!device) {
    return { ok: false, status: 404, error: 'Device not found' };
  }
  if (device.userId !== userId) {
    return { ok: false, status: 403, error: 'You do not own this device' };
  }
  if (device.revokedAt) {
    return { ok: false, status: 409, error: 'Device is already revoked' };
  }
  if ((await countActiveDevices(userId)) <= 1) {
    return { ok: false, status: 409, error: 'Cannot revoke the last active device' };
  }

  // Revoke + drop prekeys atomically. The correlated count guard re-checks the
  // last-device rule under the row lock, closing the check-then-act race above.
  const revoked = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(devices.id, deviceId),
          isNull(devices.revokedAt),
          sql`(SELECT count(*) FROM ${devices} d2 WHERE d2.user_id = ${userId} AND d2.revoked_at IS NULL) > 1`,
        ),
      )
      .returning();

    if (!updated) return null;

    await tx.delete(devicePrekeys).where(eq(devicePrekeys.deviceId, deviceId));
    return updated;
  });

  if (!revoked) {
    // Lost a race with a concurrent revoke of this or the user's other devices.
    return { ok: false, status: 409, error: 'Device is already revoked' };
  }

  const memberships = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.userId, userId),
    columns: { conversationId: true },
  });

  return { ok: true, device: revoked, conversationIds: memberships.map((m) => m.conversationId) };
}
