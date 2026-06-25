/**
 * Device revocation bus (#157).
 *
 * When a device is revoked we publish a `device_revoked` event on a dedicated
 * Redis pub/sub channel so every backend instance — and any out-of-process
 * fan-out worker — can drop the device from delivery and tear down its live
 * sockets. This is the cross-instance signal that complements the Socket.IO
 * Redis adapter (which already mirrors `disconnectSockets` across the cluster).
 */
import type { Redis } from 'ioredis';

export const DEVICE_REVOKED_CHANNEL = 'bus:device_revoked';

export interface DeviceRevokedEvent {
  deviceId: string;
  userId: string;
  revokedAt: string;
  conversationIds: string[];
}

/** Socket.IO room a device's sockets join so they can be addressed as a group. */
export function deviceRoom(deviceId: string): string {
  return `device:${deviceId}`;
}

/** Publish a revocation on the bus. Best-effort: the DB state is the source of truth. */
export async function publishDeviceRevoked(redis: Redis, event: DeviceRevokedEvent): Promise<void> {
  try {
    await redis.publish(DEVICE_REVOKED_CHANNEL, JSON.stringify(event));
  } catch {
    // Bus delivery is best-effort — local disconnect + persisted revocation already applied.
  }
}
