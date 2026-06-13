// One-shot fan-out for FEP-044f local-quote authorization IRIs.
//
// Before the 0.9.0 local-quote fix landed, same-instance accepted quotes
// were stored with `quote_authorization_iri = NULL` and the original
// Create<Note> activity was fanned out to followers *without* the
// `quoteAuthorization` field.  Remote FEP-044f-aware servers therefore
// rendered those quotes as unauthorized.
//
// The companion data migration
// (drizzle/20260519035030_backfill_local_quote_authorization_iri) already
// fills in `quote_authorization_iri` for affected rows so that subsequent
// re-fetches of the Note carry the right field.  This script additionally
// pushes an `Update<Note>` for each affected quote so remote followers
// receive the corrected representation without waiting for a stale
// refresh.
//
// Usage:
//   pnpm tsx --env-file-if-exists=.env \
//     scripts/backfill-local-quote-updates.ts [--dry-run] [--delay=<ms>]
//
// Notes:
//   - Safe to re-run; `sendQuoteUpdate` is idempotent on the receiving end.
//   - Fedify enqueues activities via PostgresMessageQueue, so the script
//     finishes fast even for large result sets — the actual outbound
//     delivery happens in the worker.

import "../src/logging";
import db, { postgres } from "../src/db";
// Importing from "../src/federation" (the package index) is essential: it
// pulls in actor, object, and inbox dispatchers as side effects.  Importing
// the bare Federation instance from "./federation" would yield a context
// without any dispatchers registered, which makes sendActivity fail with
// "No actor key pairs dispatcher registered."
import federation from "../src/federation";
import { sendQuoteUpdate } from "../src/federation/inbox";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const delayArg = args.find((a) => a.startsWith("--delay="));
const delayMs = Number(
  delayArg?.slice("--delay=".length) ??
    // oxlint-disable-next-line typescript/dot-notation
    process.env["FANOUT_DELAY_MS"] ??
    "100",
);

const rows = await postgres<{ iri: string }[]>`
  SELECT q.iri
  FROM posts AS q
  INNER JOIN posts AS t ON q.quote_target_id = t.id
  WHERE q.quote_state = 'accepted'
    AND EXISTS (SELECT 1 FROM account_owners WHERE id = q.actor_id)
    AND EXISTS (SELECT 1 FROM account_owners WHERE id = t.actor_id)
  ORDER BY q.published ASC NULLS FIRST, q.id ASC
`;

console.log(`Found ${rows.length} same-instance accepted quotes.`);

if (rows.length === 0) {
  process.exit(0);
}

if (dryRun) {
  for (const row of rows) console.log(`  - ${row.iri}`);
  console.log("(dry run — no activities enqueued)");
  process.exit(0);
}

const firstOwner = await db.query.accountOwners.findFirst({
  with: { account: true },
});
if (firstOwner?.account.iri == null) {
  console.error("No accountOwner present; cannot derive a base URL.");
  process.exit(1);
}
const baseUrl = new URL(new URL(firstOwner.account.iri).origin);
const ctx = federation.createContext(baseUrl, undefined);

let done = 0;
let failed = 0;
for (const row of rows) {
  try {
    await sendQuoteUpdate(ctx, row.iri);
    done++;
    if (done % 10 === 0 || done === rows.length) {
      console.log(`Enqueued ${done}/${rows.length} (failed: ${failed})`);
    }
  } catch (err) {
    failed++;
    console.error(`Failed to enqueue Update for ${row.iri}: ${err}`);
  }
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

console.log(
  `Done. Enqueued: ${done}, Failed: ${failed}, Total: ${rows.length}.`,
);
process.exit(0);
