import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IdempotencyService } from '../idempotency.service';

// Mock ioredis execution flows entirely
vi.mock('ioredis', () => {
  return {
    Redis: vi.fn().mockImplementation(() => {
      const db = new Set<string>();
      return {
        sismember: vi.fn().mockImplementation(async (key, val) => db.has(`${key}:${val}`) ? 1 : 0),
        multi: vi.fn().mockReturnValue({
          sadd: vi.fn().mockReturnThis(),
          expire: vi.fn().mockReturnThis(),
          exec: vi.fn().mockImplementation(async function(this: any) {
            db.add(`device:mock-device:event_ids:mock-event-123`);
            return [];
          }),
        }),
      };
    }),
  };
});

describe('Idempotency Replay Protection Spec', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService();
  });

  it('should accept distinct legitimate events and return false', async () => {
    const isDuplicate = await service.isDuplicateEvent('mock-device', 'mock-event-123');
    expect(isDuplicate).toBe(false);
  });

  it('should identify and reject re-sent eventId within the configured window', async () => {
    // First tracking execution passes
    await service.isDuplicateEvent('mock-device', 'mock-event-123');
    
    // Immediate subsequent duplicate replay check yields true
    const isDuplicateAgain = await service.isDuplicateEvent('mock-device', 'mock-event-123');
    expect(isDuplicateAgain).toBe(true);
  });
});