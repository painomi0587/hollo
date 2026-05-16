-- Custom SQL migration file, put your code below! --
UPDATE "account_owners"
SET "rsa_private_key_jwk" = ("rsa_private_key_jwk" #>> '{}')::jsonb
WHERE jsonb_typeof("rsa_private_key_jwk") = 'string';--> statement-breakpoint
UPDATE "account_owners"
SET "rsa_public_key_jwk" = ("rsa_public_key_jwk" #>> '{}')::jsonb
WHERE jsonb_typeof("rsa_public_key_jwk") = 'string';--> statement-breakpoint
UPDATE "account_owners"
SET "ed25519_private_key_jwk" = ("ed25519_private_key_jwk" #>> '{}')::jsonb
WHERE jsonb_typeof("ed25519_private_key_jwk") = 'string';--> statement-breakpoint
UPDATE "account_owners"
SET "ed25519_public_key_jwk" = ("ed25519_public_key_jwk" #>> '{}')::jsonb
WHERE jsonb_typeof("ed25519_public_key_jwk") = 'string';
