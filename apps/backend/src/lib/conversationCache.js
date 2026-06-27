import { convCacheKey, redis } from './redis.js';
export async function invalidateConversationCaches(userIds) {
    if (!redis || userIds.length === 0) {
        return;
    }
    const client = redis;
    await Promise.allSettled([...new Set(userIds)].map((userId) => client.del(convCacheKey(userId))));
}
//# sourceMappingURL=conversationCache.js.map