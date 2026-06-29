import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', name: 'contentType' })
  contentType!: string; // e.g., 'text', 'image', 'system'

  @Column({ type: 'text', nullable: true })
  body?: string;

  // Added structured JSONB payload field for unencrypted routing/UX engine events
  @Column({ type: 'jsonb', nullable: true, name: 'systemPayload' })
  systemPayload?: {
    eventType: 'member_joined' | 'member_left' | 'device_added' | 'device_revoked' | 'conversation_renamed' | 'mls_epoch_change';
    actorId?: string;
    metadata?: Record<string, any>;
  } | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}