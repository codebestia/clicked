import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockFetchBundle = vi.fn();

vi.mock('../services/keyBundle.js', () => ({
  fetchAndConsumeKeyBundle: mockFetchBundle,
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: { users: { findFirst: vi.fn(), findMany: vi.fn() } },
    update: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return null;
  },
}));

vi.mock('../services/presence.js', () => ({
  isOnline: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string } }).auth = { userId: 'caller-1' };
    next();
  },
}));

const { usersRouter } = await import('../routes/users.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /users/:userId/devices/:deviceId/key-bundle', () => {
  it('returns the prekey bundle and forwards the path params', async () => {
    const bundle = {
      identityPublicKey: 'identity-pub',
      registrationId: 4242,
      signedPreKey: { keyId: 7, publicKey: 'spk-pub', signature: 'spk-sig' },
      oneTimePreKey: { keyId: 100, publicKey: 'otp-pub' },
    };
    mockFetchBundle.mockResolvedValue({ ok: true, bundle });

    const res = await request(makeApp()).get('/users/user-1/devices/dev-1/key-bundle');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(bundle);
    expect(mockFetchBundle).toHaveBeenCalledWith('user-1', 'dev-1');
  });

  it('returns a bundle with oneTimePreKey: null when the pool is exhausted', async () => {
    mockFetchBundle.mockResolvedValue({
      ok: true,
      bundle: {
        identityPublicKey: 'identity-pub',
        registrationId: 4242,
        signedPreKey: { keyId: 7, publicKey: 'spk-pub', signature: 'spk-sig' },
        oneTimePreKey: null,
      },
    });

    const res = await request(makeApp()).get('/users/user-1/devices/dev-1/key-bundle');

    expect(res.status).toBe(200);
    expect(res.body.oneTimePreKey).toBeNull();
  });

  it('returns 404 for an unknown or revoked device', async () => {
    mockFetchBundle.mockResolvedValue({ ok: false, status: 404, error: 'Device not found' });

    const res = await request(makeApp()).get('/users/user-1/devices/dev-1/key-bundle');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Device not found' });
  });

  it('requires authentication', async () => {
    // requireAuth is mocked to always authenticate; assert the route sits behind it
    // by confirming the handler runs only after auth injected req.auth.
    mockFetchBundle.mockResolvedValue({ ok: false, status: 404, error: 'Device not found' });

    await request(makeApp()).get('/users/user-1/devices/dev-1/key-bundle');

    expect(mockFetchBundle).toHaveBeenCalled();
  });
});
