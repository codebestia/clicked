import * as dotenv from 'dotenv';

// Ensure environment variables are loaded
dotenv.config();

export const redisConfig = {
  // Redis Server Connection Details
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),

  /**
   * Configurable duplicate tracking window Time-To-Live (TTL).
   * Dictates how long an eventId will be preserved in the Redis set 
   * to catch flaky client network re-tries.
   * Default: 86400 seconds (24 hours)
   */
  eventIdTtl: parseInt(process.env.EVENT_ID_TTL_SECONDS || '86400', 10),
};