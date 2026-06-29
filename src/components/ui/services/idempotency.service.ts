import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConfig } from '../config/redis.config';

@Injectable()
export class IdempotencyService {
  private redisClient: Redis;

  constructor() {
    this.redisClient = new Redis({
      host: redisConfig.host,
      port: redisConfig.port,
    });
  }

  /**
   * Checks if an eventId has already been seen for a specific device.
   * If unseen, tracks it with a configurable TTL and returns false.
   * If seen, returns true (signaling a duplicate replay event).
   */
  async isDuplicateEvent(deviceId: string, eventId: string): Promise<boolean> {
    const redisKey = `device:${deviceId}:event_ids`;
    
    // Check if the eventId is already part of the device's Redis Set
    const isMember = await this.redisClient.sismember(redisKey, eventId);
    
    if (isMember === 1) {
      return true; // Duplicate caught
    }

    // Add eventId to the set and refresh/set the configurable TTL window expiration
    await this.redisClient.multi()
      .sadd(redisKey, eventId)
      .expire(redisKey, redisConfig.eventIdTtl)
      .exec();

    return false; // Distinct legitimate event
  }
}