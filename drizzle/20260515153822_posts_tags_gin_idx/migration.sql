-- CONCURRENTLY omitted: Drizzle migrator wraps each file in a transaction,
-- and CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- On hollo.social (4.2M-row table) this index was pre-applied manually with
-- CONCURRENTLY before deployment, so the IF NOT EXISTS makes it a no-op there.
-- Smaller deployments will take a brief lock during the normal CREATE INDEX.
--
-- jsonb_ops (default) is used instead of jsonb_path_ops because the hashtag
-- queries use ? and ?| operators, which jsonb_path_ops does not support.
CREATE INDEX IF NOT EXISTS "posts_tags_gin_idx" ON "posts" USING gin ("tags");
