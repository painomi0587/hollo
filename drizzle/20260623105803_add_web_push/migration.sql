CREATE TABLE "vapid_keys" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"private_key" text NOT NULL,
	"public_key" text NOT NULL,
	"subject" text DEFAULT 'https://localhost' NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_push_subscriptions" (
	"id" uuid PRIMARY KEY,
	"access_token_code" text NOT NULL UNIQUE,
	"account_owner_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh_key" text NOT NULL,
	"auth_key" text NOT NULL,
	"follow_alerts" boolean DEFAULT false NOT NULL,
	"favourite_alerts" boolean DEFAULT false NOT NULL,
	"reblog_alerts" boolean DEFAULT false NOT NULL,
	"mention_alerts" boolean DEFAULT false NOT NULL,
	"poll_alerts" boolean DEFAULT false NOT NULL,
	"status_alerts" boolean DEFAULT false NOT NULL,
	"follow_request_alerts" boolean DEFAULT false NOT NULL,
	"update_alerts" boolean DEFAULT false NOT NULL,
	"policy" text DEFAULT 'all' NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_zNOjJWQclyrp_fkey" FOREIGN KEY ("access_token_code") REFERENCES "access_tokens"("code") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_account_owner_id_account_owners_id_fkey" FOREIGN KEY ("account_owner_id") REFERENCES "account_owners"("id") ON DELETE CASCADE;