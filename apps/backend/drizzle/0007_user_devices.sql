CREATE TYPE "public"."device_platform" AS ENUM('web', 'ios', 'android');--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"device_name" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"identity_public_key" text NOT NULL,
	"registration_id" integer,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_user_id_device_id_unique" ON "user_devices" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX "user_devices_user_id_active_idx" ON "user_devices" USING btree ("user_id") WHERE "revoked_at" IS NULL;
