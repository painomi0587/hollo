CREATE TYPE "public"."remote_reply_scrape_job_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "remote_reply_scrape_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"post_iri" text NOT NULL,
	"replies_iri" text NOT NULL,
	"base_url" text NOT NULL,
	"origin_host" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" "remote_reply_scrape_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"fetched_items" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"error_message" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "remote_reply_scrape_jobs_replies_iri_unique" UNIQUE("replies_iri")
);
--> statement-breakpoint
CREATE TABLE "remote_reply_scrape_origins" (
	"origin_host" text PRIMARY KEY NOT NULL,
	"next_request_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_request_at" timestamp with time zone,
	"processing_job_id" uuid,
	"processing_started_at" timestamp with time zone,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD CONSTRAINT "remote_reply_scrape_jobs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_reply_scrape_jobs_status_next_attempt_at_index" ON "remote_reply_scrape_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "remote_reply_scrape_jobs_origin_host_status_next_attempt_at_index" ON "remote_reply_scrape_jobs" USING btree ("origin_host","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "remote_reply_scrape_origins_next_request_at_index" ON "remote_reply_scrape_origins" USING btree ("next_request_at");--> statement-breakpoint
CREATE INDEX "remote_reply_scrape_origins_processing_job_id_index" ON "remote_reply_scrape_origins" USING btree ("processing_job_id");