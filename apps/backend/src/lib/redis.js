import { Redis } from 'ioredis';
export let redis = null;
if (process.env['REDIS_URL']) {
    redis = new Redis(process.env['REDIS_URL'], { lazyConnect: true });
    redis.on('error', () => {
        // Graceful degradation: cache misses fall through to DB
    });
}
export const CONV_CACHE_TTL = 30; // seconds
export function convCacheKey(userId) {
    return `conversations:${userId}`;
}
//# sourceMappingURL=redis.js.map