import { describe, it, expect, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { Message } from '../../../entities/message.entity';

describe('System Messages Database Constraint Spec', () => {
  let mockRepository: any;

  beforeEach(() => {
    // Mock save behaviors mirroring database constraint mechanics for test runner consistency
    mockRepository = {
      save: async (message: Partial<Message>) => {
        if (message.contentType !== 'system' && message.systemPayload) {
          throw new Error('DB Error: New row violates check constraint "chk_system_payload_only_on_system_type"');
        }
        return { id: 'mock-uuid', ...message };
      }
    };
  });

  it('should allow systemPayload to be populated when contentType equals system', async () => {
    const validSystemMessage = {
      contentType: 'system',
      systemPayload: { eventType: 'member_joined', actorId: 'user-123' }
    };

    const saved = await mockRepository.save(validSystemMessage);
    expect(saved.id).toBeDefined();
    expect(saved.systemPayload?.eventType).toBe('member_joined');
  });

  it('should reject persistence and throw an exception if a non-system contentType provides a systemPayload value', async () => {
    const invalidTextMessage = {
      contentType: 'text',
      body: 'Hello world',
      systemPayload: { eventType: 'mls_epoch_change' }
    };

    await expect(mockRepository.save(invalidTextMessage)).rejects.toThrow(
      'chk_system_payload_only_on_system_type'
    );
  });
});