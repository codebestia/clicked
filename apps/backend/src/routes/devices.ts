import { Router } from 'express';
import type { IRouter } from 'express';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { devices } from '../db/schema.js';
import type { Device } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { redis } from '../lib/redis.js';
import { getSocketServer } from '../lib/socket.js';
import { revokeDevice } from '../services/deviceRevocation.js';
import { deviceRoom, publishDeviceRevoked } from '../lib/deviceBus.js';

export const devicesRouter: IRouter = Router();

devicesRouter.use(requireAuth);

function serializeDevice(device: Device) {
  return {
    id: device.id,
    name: device.name,
    publicKey: device.publicKey,
    revokedAt: device.revokedAt,
    lastSeenAt: device.lastSeenAt,
    createdAt: device.createdAt,
  };
}

// GET /devices — list the caller's devices (active first, newest first).
devicesRouter.get('/', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  const rows = await db.query.devices.findMany({
    where: eq(devices.userId, userId),
    orderBy: asc(devices.createdAt),
  });

  res.json({ devices: rows.map(serializeDevice) });
});

// DELETE /devices/:id — revoke (unlink) a device.
//
// Soft-revokes the device (sets revokedAt, deletes its prekeys), disconnects its
// live sockets, publishes a `device_revoked` event on the Redis bus so the
// device is dropped from future fan-out, and emits a key-change notice to peers
// in shared conversations. Revoking the only active device is rejected with 409.
devicesRouter.delete('/:id', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const deviceId = req.params['id'] as string | undefined;

  if (!deviceId) {
    res.status(400).json({ error: 'Device id is required' });
    return;
  }

  const result = await revokeDevice(userId, deviceId);

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  const { device, conversationIds } = result;
  const revokedAt = device.revokedAt ?? new Date();

  const io = getSocketServer();
  if (io) {
    // Disconnect every socket bound to this device. With the Socket.IO Redis
    // adapter attached this fans out across all instances, severing the
    // revoked device's live bindings everywhere.
    io.in(deviceRoom(device.id)).disconnectSockets(true);

    // Notify peers in shared conversations so clients refresh key material.
    for (const conversationId of conversationIds) {
      io.to(conversationId).emit('key_change', {
        conversationId,
        userId,
        deviceId: device.id,
        revokedAt,
      });
    }
  }

  // Cross-instance / out-of-process signal: drop the device from fan-out.
  if (redis) {
    await publishDeviceRevoked(redis, {
      deviceId: device.id,
      userId,
      revokedAt: revokedAt.toISOString(),
      conversationIds,
    });
  }

  res.json(serializeDevice(device));
});
