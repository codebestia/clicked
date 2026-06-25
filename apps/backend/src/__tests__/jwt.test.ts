import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '../lib/jwt.js';

describe('JWT utilities', () => {
  const payload = { userId: 'user-123', walletAddress: 'GABCDE', deviceId: 'device-abc' };

  it('signs a token without throwing', () => {
    const token = signToken(payload);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('verifies a valid token and returns the payload', () => {
    const token = signToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.userId).toBe(payload.userId);
    expect(decoded.walletAddress).toBe(payload.walletAddress);
    expect(decoded.deviceId).toBe(payload.deviceId);
  });

  it('throws on a tampered token', () => {
    const token = signToken(payload);
    const tampered = token.slice(0, -4) + 'xxxx';
    expect(() => verifyToken(tampered)).toThrow();
  });

  it('throws on an expired token', async () => {
    const jwt = await import('jsonwebtoken');
    const secret = process.env['JWT_SECRET']!;
    const expired = jwt.default.sign(payload, secret, { expiresIn: -1 });
    expect(() => verifyToken(expired)).toThrow(/expired/i);
  });

  it('throws on a legacy token missing deviceId', async () => {
    const jwt = await import('jsonwebtoken');
    const secret = process.env['JWT_SECRET']!;
    // Simulate a legacy token with no deviceId field
    const legacy = jwt.default.sign({ userId: 'user-123', walletAddress: 'GABCDE' }, secret, {
      expiresIn: '7d',
    });
    expect(() => verifyToken(legacy)).toThrow(/deviceId/i);
  });
});
