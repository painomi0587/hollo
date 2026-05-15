CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "accounts_handle_trgm_idx" ON "accounts" USING gin ("handle" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_name_trgm_idx" ON "accounts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "posts_content_html_trgm_idx" ON "posts" USING gin ("content_html" gin_trgm_ops);