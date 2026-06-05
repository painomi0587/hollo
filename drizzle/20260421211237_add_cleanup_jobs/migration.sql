CREATE TYPE "public"."cleanup_job_category" AS ENUM('cleanup_thumbnails');--> statement-breakpoint
CREATE TYPE "public"."cleanup_job_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "cleanup_job_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"status" "cleanup_job_status" DEFAULT 'pending' NOT NULL,
	"data" jsonb NOT NULL,
	"error_message" text,
	"processed_at" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleanup_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category" "cleanup_job_category" NOT NULL,
	"status" "cleanup_job_status" DEFAULT 'pending' NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"processed_items" integer DEFAULT 0 NOT NULL,
	"successful_items" integer DEFAULT 0 NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cleanup_job_items" ADD CONSTRAINT "cleanup_job_items_job_id_cleanup_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cleanup_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cleanup_job_items_job_id_status_index" ON "cleanup_job_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "cleanup_jobs_status_created_index" ON "cleanup_jobs" USING btree ("status","created");