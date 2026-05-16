CREATE INDEX IF NOT EXISTS "posts_actor_id_language_index" ON "posts" USING btree ("actor_id","language") WHERE "posts"."language" is not null;
