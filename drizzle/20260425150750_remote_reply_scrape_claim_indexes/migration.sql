DROP INDEX "remote_reply_scrape_jobs_status_next_attempt_at_index";--> statement-breakpoint
DROP INDEX "remote_reply_scrape_jobs_origin_host_status_next_attempt_at_index";--> statement-breakpoint
CREATE INDEX "remote_reply_scrape_jobs_claim_index" ON "remote_reply_scrape_jobs" USING btree ("status","next_attempt_at","created");--> statement-breakpoint
CREATE INDEX "remote_reply_scrape_jobs_origin_claim_index" ON "remote_reply_scrape_jobs" USING btree ("origin_host","status","next_attempt_at","created");