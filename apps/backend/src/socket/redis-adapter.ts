/**
 * Wire `@socket.io/redis-adapter` to a Socket.IO server so multiple
 * backend instances share rooms via the existing Redis container
 * (#7).
 *
 * Failure mode: if `REDIS_URL` isn't reachable we log the error and
 * leave the in-process default adapter in place. The HTTP server stays
 * up and clients keep receiving messages from sockets connected to the
 * same instance — exactly the "degrades gracefully (falls back to
 * local)" behaviour the issue asks for.
 */
import type { Server as IOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, type RedisClientType } from 'redis';

export interface RedisAdapterAttachResult {
  /** True when both pub + sub clients connected and the adapter was
   *  attached. False when REDIS_URL is unset or any client failed. */
  attached: boolean;
  /** Reason string when `attached === false`. */
  reason?: string;
  /** Optional handles for shutdown / tests. */
  pubClient?: RedisClientType;
  subClient?: RedisClientType;
}

export async function attachRedisAdapter(
  io: IOServer,
  options: { url?: string } = {},
): Promise<RedisAdapterAttachResult> {
  const url = options.url ?? process.env['REDIS_URL'];
  if (!url) {
    return { attached: false, reason: 'REDIS_URL is not set' };
  }

  const pubClient = createClient({ url }) as RedisClientType;
  const subClient = pubClient.duplicate();

  // Don't let a connection error abort the process — surface it and
  // continue with the in-memory adapter.
  pubClient.on('error', (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[redis-adapter] pub client error:', err);
  });
  subClient.on('error', (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[redis-adapter] sub client error:', err);
  });

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
  } catch (err) {
    return {
      attached: false,
      reason:
        err instanceof Error ? `connect failed: ${err.message}` : 'connect failed',
      pubClient,
      subClient,
    };
  }

  io.adapter(createAdapter(pubClient, subClient));
  return { attached: true, pubClient, subClient };
}
