-- Backfill quote_authorization_iri for accepted same-instance quotes that
-- were created before FEP-044f local auto-approval emitted the IRI.  The
-- IRI scheme matches getQuoteAuthorizationIri() in src/federation/inbox.ts:
-- "${target.iri}/quote_authorizations/${quote.id}".  Only rows where both
-- the quoting and the quoted account are owned by a local accountOwner
-- qualify; remote-targeted quotes are left untouched.
UPDATE "posts" AS q
SET "quote_authorization_iri" =
  t."iri" || '/quote_authorizations/' || q."id"::text
FROM "posts" AS t
WHERE q."quote_target_id" = t."id"
  AND q."quote_state" = 'accepted'
  AND q."quote_authorization_iri" IS NULL
  AND EXISTS (SELECT 1 FROM "account_owners" WHERE "id" = q."actor_id")
  AND EXISTS (SELECT 1 FROM "account_owners" WHERE "id" = t."actor_id");
