import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockRevokeDevice = vi.fn();
const mockFindManyDevices = vi.fn();

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockDisconnectSockets = vi.fn();
const mockIn = vi.fn(() => ({ disconnectSockets: mockDisconnectSockets }));
const mockPublish = vi.fn();

vi.mock('../services/deviceRevocation.js', () => ({
  revokeDevice: mockRevokeDevice,
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findMany: mockFindManyDevices },
    },
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId', createdAt: 'createdAt' },
}));

vi.mock('drizzle-orm', () => ({
  asc: vi.fn(),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock('../lib/socket.js', () => ({
  getSocketServer: () => ({ to: mockTo, in: mockIn }),
}));

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return { publish: mockPublish };
  },
}));

vi.mock('../lib/deviceBus.js', () => ({
  deviceRoom: (id: string) => `device:${id}`,
  publishDeviceRevoked: (_redis: unknown, event: unknown) => mockPublish(event),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string } }).auth = { userId: 'user-1' };
    next();
  },
}));

const { devicesRouter } = await import('../routes/devices.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/devices', devicesRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /devices', () => {
  it("lists the caller's devices", async () => {
    mockFindManyDevices.mockResolvedValue([
      {
        id: 'dev-1',
        name: 'Laptop',
        publicKey: 'pk',
        revokedAt: null,
        lastSeenAt: null,
        createdAt: new Date('2026-01-01'),
      },
    ]);

    const res = await request(makeApp()).get('/devices');

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0]).toMatchObject({ id: 'dev-1', name: 'Laptop' });
  });
});

describe('DELETE /devices/:id', () => {
  it('returns 404 when the device does not exist', async () => {
    mockRevokeDevice.mockResolvedValue({ ok: false, status: 404, error: 'Device not found' });

    const res = await request(makeApp()).delete('/devices/missing');

    expect(res.status).toBe(404);
    expect(mockDisconnectSockets).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns 403 when the device belongs to another user', async () => {
    mockRevokeDevice.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You do not own this device',
    });

    const res = await request(makeApp()).delete('/devices/dev-9');

    expect(res.status).toBe(403);
  });

  it('returns 409 when revoking the last active device', async () => {
    mockRevokeDevice.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'Cannot revoke the last active device',
    });

    const res = await request(makeApp()).delete('/devices/dev-1');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot revoke the last active device');
    expect(mockDisconnectSockets).not.toHaveBeenCalled();
  });

  it('revokes the device, disconnects sockets, notifies peers, and publishes on the bus', async () => {
    const revokedAt = new Date('2026-06-25T00:00:00.000Z');
    mockRevokeDevice.mockResolvedValue({
      ok: true,
      device: {
        id: 'dev-1',
        name: 'Laptop',
        publicKey: 'pk',
        revokedAt,
        lastSeenAt: null,
        createdAt: new Date('2026-01-01'),
      },
      conversationIds: ['conv-1', 'conv-2'],
    });

    const res = await request(makeApp()).delete('/devices/dev-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'dev-1' });

    // Live sockets bound to the device are disconnected.
    expect(mockIn).toHaveBeenCalledWith('device:dev-1');
    expect(mockDisconnectSockets).toHaveBeenCalledWith(true);

    // Peers in each shared conversation receive a key-change notice.
    expect(mockTo).toHaveBeenCalledWith('conv-1');
    expect(mockTo).toHaveBeenCalledWith('conv-2');
    expect(mockEmit).toHaveBeenCalledWith(
      'key_change',
      expect.objectContaining({ userId: 'user-1', deviceId: 'dev-1' }),
    );

    // Revocation is published on the Redis bus for cross-instance fan-out.
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'dev-1',
        userId: 'user-1',
        conversationIds: ['conv-1', 'conv-2'],
      }),
    );
  });
});
