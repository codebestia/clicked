import { Redis } from 'ioredis';
export declare let redis: Redis | null;
export declare const CONV_CACHE_TTL = 30;
export declare function convCacheKey(userId: string): string;
//# sourceMappingURL=redis.d.ts.map