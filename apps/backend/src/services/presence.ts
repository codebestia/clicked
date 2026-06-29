/**
 * Online presence tracking (#13).
 *
 * Stores presence:user:{userId} -> { deviceId -> lastSeen } in Redis as a hash.
 * Every device connection updates its own field and the key expires after the
 * configured TTL unless refreshed by heartbeats. A user is considered online
 * when at least one device entry remains.
 *
 * - On connect:   set the device field to now, set TTL 90s
 * - On heartbeat: refresh the device field and TTL
 * - On disconnect/timeout: remove the device field; if empty, remove the key
 * - GET /users/:id/presence → { online: boolean }
 */
import type { Redis } from 'ioredis';

const PRESENCE_TTL = 90; // seconds

function presenceKey(userId: string): string {
  return `presence:user:${userId}`;
}

function lastSeenValue(): string {
  return String(Date.now());
}

/**
 * Register a device connection for a user. Stores the device as a hash field
 * and refreshes the presence TTL.
 */
export async function setOnline(redis: Redis, userId: string, deviceId: string): Promise<void> {
  const key = presenceKey(userId);
  await redis.hset(key, deviceId, lastSeenValue());
  await redis.expire(key, PRESENCE_TTL);
}

/**
 * Refresh the presence entry for a specific device (called on heartbeat).
 */
export async function refreshPresence(redis: Redis, userId: string, deviceId: string): Promise<void> {
  const key = presenceKey(userId);
  await redis.hset(key, deviceId, lastSeenValue());
  await redis.expire(key, PRESENCE_TTL);
}

/**
 * Remove a device connection from the user's presence hash.
 * Returns true if the user has gone fully offline (no remaining devices).
 */
export async function setOffline(redis: Redis, userId: string, deviceId: string): Promise<boolean> {
  const key = presenceKey(userId);
  await redis.hdel(key, deviceId);
  const remaining = await redis.hgetall(key);
  if (!remaining || Object.keys(remaining).length === 0) {
    await redis.del(key);
    return true;
  }
  return false;
}

/**
 * Forcefully mark a device offline by deleting its hash field.
 * Used when a heartbeat timeout or device revocation occurs.
 */
export async function markDeviceOffline(redis: Redis, userId: string, deviceId: string): Promise<void> {
  const key = presenceKey(userId);
  await redis.hdel(key, deviceId);
  const remaining = await redis.hgetall(key);
  if (!remaining || Object.keys(remaining).length === 0) {
    await redis.del(key);
  }
}

/**
 * Check if a user is currently online.
 */
export async function isOnline(redis: Redis, userId: string): Promise<boolean> {
  const key = presenceKey(userId);
  const entries = await redis.hgetall(key);
  return Object.keys(entries ?? {}).length > 0;
}
