ALTER TABLE "account_owners" ADD CONSTRAINT "ck_account_owners_rsa_private_key_jwk_object" CHECK (jsonb_typeof("rsa_private_key_jwk") = 'object');--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "ck_account_owners_rsa_public_key_jwk_object" CHECK (jsonb_typeof("rsa_public_key_jwk") = 'object');--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "ck_account_owners_ed25519_private_key_jwk_object" CHECK (jsonb_typeof("ed25519_private_key_jwk") = 'object');--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "ck_account_owners_ed25519_public_key_jwk_object" CHECK (jsonb_typeof("ed25519_public_key_jwk") = 'object');
