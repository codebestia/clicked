import type { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis, type RedisOptions } from 'ioredis';

type RedisLike = Pick<Redis, 'on' | 'duplicate' | 'connect' | 'disconnect'>;

export interface AttachRedisAdapterOptions {
  redisUrl?: string;
  /** Inject a Redis ctor for tests. Defaults to the real ioredis Redis. */
  createClient?: (url: string, opts: RedisOptions) => RedisLike;
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Attach the Socket.IO Redis adapter when REDIS_URL is set so multiple
 * backend instances share rooms and broadcasts. If the Redis client
 * cannot connect or later errors out, we log and fall back to the
 * default in-process adapter — single-instance setups (and local dev)
 * keep working without a Redis container (#7).
 *
 * Returns an async settle Promise so tests can await the attachment
 * attempt; production callers can fire-and-forget.
 */
export async function attachRedisAdapter(
  server: Server,
  options: AttachRedisAdapterOptions = {},
): Promise<'attached' | 'skipped' | 'degraded'> {
  const redisUrl = options.redisUrl ?? process.env['REDIS_URL'];
  const logger = options.logger ?? console;

  if (!redisUrl) {
    logger.log(
      '[socket.io] REDIS_URL not set; using in-process adapter (single-instance only).',
    );
    return 'skipped';
  }

  const create = options.createClient ?? defaultCreateClient;

  let degraded = false;
  const degrade = (where: string, err: Error): void => {
    if (degraded) return;
    degraded = true;
    logger.warn(
      `[socket.io] Redis ${where} error; falling back to in-process adapter: ${err.message}`,
    );
  };

  try {
    const pubClient = create(redisUrl, { lazyConnect: true }) as Redis;
    const subClient = pubClient.duplicate() as Redis;
    pubClient.on('error', (err: Error) => degrade('pub', err));
    subClient.on('error', (err: Error) => degrade('sub', err));
    try {
      await Promise.all([pubClient.connect(), subClient.connect()]);
      server.adapter(createAdapter(pubClient, subClient));
      logger.log('[socket.io] Redis adapter attached.');
      return 'attached';
    } catch (err) {
      degrade('connect', err as Error);
      return 'degraded';
    }
  } catch (err) {
    degrade('init', err as Error);
    return 'degraded';
  }
}

function defaultCreateClient(url: string, opts: RedisOptions): Redis {
  return new Redis(url, opts);
}
