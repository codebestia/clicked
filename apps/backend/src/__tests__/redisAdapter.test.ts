import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

import { attachRedisAdapter } from '../socket/redisAdapter.js';

class FakeServer {
  adapter = vi.fn();
}

class FakeRedis extends EventEmitter {
  connect = vi.fn(async () => undefined);
  disconnect = vi.fn();
  duplicate(): FakeRedis {
    const child = new FakeRedis();
    child.connect = this.connect;
    return child;
  }
}

function silentLogger(): { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { log: vi.fn(), warn: vi.fn() };
}

describe('attachRedisAdapter (#7)', () => {
  it('skips attachment when REDIS_URL is unset', async () => {
    const server = new FakeServer();
    const logger = silentLogger();
    const result = await attachRedisAdapter(server as never, {
      redisUrl: undefined,
      logger,
    });
    expect(result).toBe('skipped');
    expect(server.adapter).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('REDIS_URL not set'),
    );
  });

  it('attaches the Redis adapter when both clients connect', async () => {
    const server = new FakeServer();
    const logger = silentLogger();
    const result = await attachRedisAdapter(server as never, {
      redisUrl: 'redis://localhost:6379',
      logger,
      createClient: () => new FakeRedis() as never,
    });
    expect(result).toBe('attached');
    expect(server.adapter).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully when the pub client connect rejects', async () => {
    const server = new FakeServer();
    const logger = silentLogger();
    const client = new FakeRedis();
    client.connect = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await attachRedisAdapter(server as never, {
      redisUrl: 'redis://localhost:6379',
      logger,
      createClient: () => client as never,
    });
    expect(result).toBe('degraded');
    expect(server.adapter).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED'),
    );
  });

  it('degrades gracefully when client construction throws', async () => {
    const server = new FakeServer();
    const logger = silentLogger();
    const result = await attachRedisAdapter(server as never, {
      redisUrl: 'redis://localhost:6379',
      logger,
      createClient: () => {
        throw new Error('invalid URL');
      },
    });
    expect(result).toBe('degraded');
    expect(server.adapter).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid URL'),
    );
  });
});
