CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_email" varchar(254) NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint NOT NULL,
	"transports" text[] DEFAULT (ARRAY[]::text[]) NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"nickname" text NOT NULL,
	"last_used" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_credential_email_credentials_email_fk" FOREIGN KEY ("credential_email") REFERENCES "public"."credentials"("email") ON DELETE cascade ON UPDATE no action;