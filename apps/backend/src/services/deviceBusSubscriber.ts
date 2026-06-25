/**
 * Device revocation bus subscriber (#157).
 *
 * Subscribes to the `device_revoked` channel and tears down any sockets bound
 * to a revoked device on the local instance. The publishing instance already
 * disconnects them cluster-wide via the Socket.IO Redis adapter; this consumer
 * makes revocation robust even for deployments running without that adapter and
 * gives other subsystems a single place to react to revocations.
 */
import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import { DEVICE_REVOKED_CHANNEL, deviceRoom, type DeviceRevokedEvent } from '../lib/deviceBus.js';

export function registerDeviceBusSubscriber(io: Server, redis: Redis): void {
  // A connection in subscriber mode cannot issue other commands, so duplicate.
  const subscriber = redis.duplicate();

  subscriber.on('error', () => {
    // Degrade silently — revocation is still persisted and applied on the publisher.
  });

  subscriber.on('message', (channel, raw) => {
    if (channel !== DEVICE_REVOKED_CHANNEL) return;

    let event: DeviceRevokedEvent;
    try {
      event = JSON.parse(raw) as DeviceRevokedEvent;
    } catch {
      return;
    }

    io.in(deviceRoom(event.deviceId)).disconnectSockets(true);
  });

  void subscriber.subscribe(DEVICE_REVOKED_CHANNEL).catch(() => {
    // Subscription failed (Redis down) — connection-level error handler logs it.
  });
}
