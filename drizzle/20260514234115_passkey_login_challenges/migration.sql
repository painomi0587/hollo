CREATE TABLE "passkey_login_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "passkey_login_challenges_expires_at_index" ON "passkey_login_challenges" USING btree ("expires_at");