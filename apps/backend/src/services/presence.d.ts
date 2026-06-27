/**
 * Online presence tracking (#13).
 *
 * Stores userId → socketId mapping in Redis with a 60-second TTL that is
 * refreshed on every heartbeat. Uses a Redis set per userId to support
 * multiple tabs/connections but counting as a single presence entry.
 *
 * - On connect:   add socketId to `presence:{userId}` set, set TTL 60s
 * - On heartbeat: refresh TTL to 60s
 * - On disconnect: remove socketId from set, if set empty → user_offline
 * - GET /users/:id/presence → { online: boolean }
 */
import type { Redis } from 'ioredis';
/**
 * Register a socket connection for a user. Adds the socketId to the
 * user's presence set and sets/refreshes the TTL.
 */
export declare function setOnline(redis: Redis, userId: string, socketId: string): Promise<void>;
/**
 * Refresh the presence TTL (called on heartbeat).
 */
export declare function refreshPresence(redis: Redis, userId: string): Promise<void>;
/**
 * Remove a socket connection from the user's presence set.
 * Returns true if the user has gone fully offline (no remaining sockets).
 */
export declare function setOffline(redis: Redis, userId: string, socketId: string): Promise<boolean>;
/**
 * Check if a user is currently online.
 */
export declare function isOnline(redis: Redis, userId: string): Promise<boolean>;
//# sourceMappingURL=presence.d.ts.map