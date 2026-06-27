const PRESENCE_TTL = 60; // seconds
function presenceKey(userId) {
    return `presence:${userId}`;
}
/**
 * Register a socket connection for a user. Adds the socketId to the
 * user's presence set and sets/refreshes the TTL.
 */
export async function setOnline(redis, userId, socketId) {
    const key = presenceKey(userId);
    await redis.sadd(key, socketId);
    await redis.expire(key, PRESENCE_TTL);
}
/**
 * Refresh the presence TTL (called on heartbeat).
 */
export async function refreshPresence(redis, userId) {
    const key = presenceKey(userId);
    const exists = await redis.exists(key);
    if (exists) {
        await redis.expire(key, PRESENCE_TTL);
    }
}
/**
 * Remove a socket connection from the user's presence set.
 * Returns true if the user has gone fully offline (no remaining sockets).
 */
export async function setOffline(redis, userId, socketId) {
    const key = presenceKey(userId);
    await redis.srem(key, socketId);
    const remaining = await redis.scard(key);
    if (remaining === 0) {
        await redis.del(key);
        return true;
    }
    return false;
}
/**
 * Check if a user is currently online.
 */
export async function isOnline(redis, userId) {
    const key = presenceKey(userId);
    const count = await redis.scard(key);
    return count > 0;
}
//# sourceMappingURL=presence.js.map