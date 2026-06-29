import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSystemPayloadToMessages20260629000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add the nullable jsonb column
    await queryRunner.query(`
      ALTER TABLE "messages" 
      ADD COLUMN "systemPayload" JSONB NULL;
    `);

    // 2. Add the check constraint enforcing conditional emptiness
    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD CONSTRAINT "chk_system_payload_only_on_system_type"
      CHECK (
        ("contentType" = 'system' AND "systemPayload" IS NOT NULL) OR
        ("contentType" != 'system' AND "systemPayload" IS NULL) OR
        ("contentType" = 'system' AND "systemPayload" IS NULL)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages" 
      DROP CONSTRAINT "chk_system_payload_only_on_system_type";
    `);
    await queryRunner.query(`
      ALTER TABLE "messages" 
      DROP COLUMN "systemPayload";
    `);
  }
}