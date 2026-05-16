import { AsyncLocalStorage } from "node:async_hooks";

import type { MiddlewareHandler } from "hono";
import type postgres from "postgres";

/**
 * Request abort propagation for Drizzle queries backed by postgres.js.
 *
 * Drizzle does not currently expose a public per-query cancellation handle for
 * the postgres-js driver.  postgres.js itself does: every `sql.unsafe(...)`
 * call returns a Query promise with `.cancel()`.  Drizzle's postgres-js session
 * ultimately executes every SQL statement through that method, so this module
 * wraps `unsafe()` once at the client boundary and records each Query created
 * while a request-scoped `AsyncLocalStorage` context is active.
 *
 * For safe read-only HTTP methods, when Hono's `Request.signal` aborts, the
 * active queries for that request are cancelled.  postgres.js sends a
 * PostgreSQL cancel request on a separate connection, which lets the backend
 * stop work instead of waiting for the role-level `statement_timeout`.
 *
 * This is intentionally a small adapter over postgres.js rather than a Drizzle
 * abstraction.  If Drizzle gains native AbortSignal support, this module should
 * be retired in favor of the official API.
 */

export const POSTGRES_QUERY_CANCELLED_SQLSTATE = "57014";

const WRAPPED_SQL = Symbol("hollo.wrappedPostgresCancellation");

/**
 * The part of postgres.js Query we depend on.
 *
 * Query is a Promise subclass with a public `.cancel()` method.  Its
 * `canceller`/`resolve`/`reject` fields are implementation details.  We use
 * them because postgres.js does not expose the cancellation promise from the
 * public `.cancel()` method: wrapping `resolve`/`reject` lets us stop tracking
 * a query as soon as it settles, and calling `canceller` directly lets us
 * consume asynchronous failures from the separate PostgreSQL cancel connection.
 */
type CancellableQuery = {
  canceller?: ((query: CancellableQuery) => unknown) | null;
  cancel: () => unknown;
  resolve?: (value: unknown) => unknown;
  reject?: (reason?: unknown) => unknown;
};

type QueryCancellationContext = {
  signal: AbortSignal;
  queries: Set<CancellableQuery>;
};

type SqlClient = postgres.Sql | postgres.TransactionSql | postgres.ReservedSql;

type WrappedSqlClient<T extends SqlClient> = T & {
  [WRAPPED_SQL]?: true;
};

const queryCancellation = new AsyncLocalStorage<QueryCancellationContext>();

/**
 * Normalized error for database work cancelled because the HTTP request ended.
 *
 * postgres.js reports a successful cancellation as PostgreSQL SQLSTATE 57014.
 * That SQLSTATE can also come from application-level statement cancellation,
 * so callers should only normalize it to this error while the request signal is
 * known to be aborted.
 */
export class DatabaseQueryAbortedError extends Error {
  constructor(cause: unknown) {
    super("Database query cancelled because the request was aborted", {
      cause,
    });
    this.name = "AbortError";
  }
}

/**
 * Wrap a postgres.js client so queries created by `unsafe()` become cancellable
 * through the current request context.
 *
 * Drizzle's postgres-js adapter executes SQL with `client.unsafe(...)`, so
 * wrapping this one method is enough for normal Drizzle queries.  postgres.js
 * creates child SQL clients for transactions, savepoints, and reserved
 * connections; those children have their own `unsafe()` methods, so this
 * function also wraps `begin()`, `savepoint()`, and `reserve()` and applies the
 * same behavior to the child client before user/Drizzle code receives it.
 *
 * The wrapper mutates the client in place and marks it with a private symbol to
 * make repeated wrapping harmless.  `src/db.ts` applies this once to Hollo's
 * shared postgres client before handing it to Drizzle, but tests and any future
 * raw postgres-js client can use the same helper.
 */
export function wrapPostgresClient<T extends SqlClient>(client: T): T {
  const wrappedClient = client as WrappedSqlClient<T>;
  if (wrappedClient[WRAPPED_SQL]) return client;
  wrappedClient[WRAPPED_SQL] = true;

  const originalUnsafe = client.unsafe.bind(client);
  client.unsafe = ((...args: Parameters<postgres.Sql["unsafe"]>) => {
    const query = originalUnsafe(...args);
    return trackPostgresQuery(query);
  }) as typeof client.unsafe;

  if ("begin" in client && typeof client.begin === "function") {
    // `begin()` passes a transaction-scoped SQL client to the callback.  Drizzle
    // uses that client for every query inside `db.transaction(...)`, so the
    // child client must be wrapped before the callback runs.
    const originalBegin = client.begin.bind(client);
    client.begin = ((
      optionsOrCallback:
        | string
        | ((sql: postgres.TransactionSql) => unknown | Promise<unknown>),
      callback?: (sql: postgres.TransactionSql) => unknown | Promise<unknown>,
    ) => {
      if (typeof optionsOrCallback === "function") {
        return originalBegin((sql) =>
          optionsOrCallback(wrapPostgresClient(sql)),
        );
      }
      return originalBegin(optionsOrCallback, (sql) =>
        callback!(wrapPostgresClient(sql)),
      );
    }) as typeof client.begin;
  }

  if ("savepoint" in client && typeof client.savepoint === "function") {
    // Savepoints are nested transaction clients and need the same treatment as
    // top-level transactions.
    const originalSavepoint = client.savepoint.bind(client);
    client.savepoint = ((
      nameOrCallback:
        | string
        | ((sql: postgres.TransactionSql) => unknown | Promise<unknown>),
      callback?: (sql: postgres.TransactionSql) => unknown | Promise<unknown>,
    ) => {
      if (typeof nameOrCallback === "function") {
        return originalSavepoint((sql) =>
          nameOrCallback(wrapPostgresClient(sql)),
        );
      }
      return originalSavepoint(nameOrCallback, (sql) =>
        callback!(wrapPostgresClient(sql)),
      );
    }) as typeof client.savepoint;
  }

  if ("reserve" in client && typeof client.reserve === "function") {
    // Reserved clients keep one connection pinned.  Hollo rarely needs them,
    // but wrapping here keeps raw postgres-js use consistent with Drizzle.
    const originalReserve = client.reserve.bind(client);
    client.reserve = (async () =>
      wrapPostgresClient(await originalReserve())) as typeof client.reserve;
  }

  return client;
}

/**
 * Run code in a request-scoped cancellation context.
 *
 * Any query created by a wrapped postgres.js client while `callback` is running
 * is registered in this context.  If `signal` aborts, all currently active
 * queries are cancelled.  Queries that settle normally remove themselves from
 * the active set, so a late abort does not try to cancel already-completed work.
 *
 * If postgres confirms the cancellation with SQLSTATE 57014 after the signal is
 * aborted, the error is normalized to `DatabaseQueryAbortedError` so top-level
 * handlers can avoid logging expected disconnects as application failures.
 */
export async function withPostgresQueryCancellation<T>(
  signal: AbortSignal | undefined,
  callback: () => T | Promise<T>,
): Promise<T> {
  if (signal == null) return await callback();

  const context: QueryCancellationContext = {
    signal,
    queries: new Set(),
  };
  const onAbort = () => {
    for (const query of context.queries) {
      cancelPostgresQuery(query);
    }
  };

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    return await queryCancellation.run(context, callback);
  } catch (error) {
    throw normalizePostgresCancelError(error, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    context.queries.clear();
  }
}

/**
 * Hono middleware that connects the incoming Request signal to postgres.js
 * query cancellation.
 *
 * Cancellation is intentionally limited to `GET` and `HEAD`.  Aborting a
 * multi-query mutation halfway through a non-transactional handler can leave
 * durable partial state, while read-only request handlers can be cancelled
 * without changing application invariants.  Mutation handlers should opt into
 * cancellation only after their write sequences are made atomic.
 *
 * A client disconnect is not an application error, so abort-normalized errors
 * are turned into the nginx-style 499 status.  If the connection is already
 * closed, the response usually cannot be delivered, but returning 499 also
 * keeps local tests and logs explicit.
 */
export function postgresQueryCancellationMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!isPostgresQueryCancellationMethod(c.req.raw.method)) {
      await next();
      return;
    }
    try {
      await withPostgresQueryCancellation(c.req.raw.signal, next);
    } catch (error) {
      if (isAbortError(error)) return new Response(null, { status: 499 });
      throw error;
    }
  };
}

export function isPostgresQueryCancellationMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * Convert a postgres cancellation error into an AbortError only when the
 * request was actually aborted.
 *
 * PostgreSQL uses SQLSTATE 57014 for several "query was cancelled" cases.  We
 * must not hide unrelated cancellations such as manual `pg_cancel_backend()`,
 * statement timeout variants, or application code cancelling its own query.
 */
export function normalizePostgresCancelError(
  error: unknown,
  signal?: AbortSignal,
): unknown {
  if (isAbortError(error)) return error;
  if (signal?.aborted && isPostgresQueryCancelError(error)) {
    return new DatabaseQueryAbortedError(error);
  }
  return error;
}

/**
 * Check for DOM-style abort errors.
 *
 * Hono/Node/fetch code commonly identifies aborts by `name === "AbortError"`.
 * `DatabaseQueryAbortedError` deliberately follows that convention.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Return true when an error should be treated as an expected request abort.
 *
 * Plain `AbortError`s are enough on their own.  SQLSTATE 57014 is considered a
 * request abort only when the caller provides an already-aborted signal.
 */
export function isRequestAbortError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  return (
    isAbortError(error) ||
    (signal?.aborted === true && isPostgresQueryCancelError(error))
  );
}

/**
 * Detect PostgreSQL's `query_canceled` SQLSTATE through wrapper error causes.
 *
 * Drizzle wraps driver failures in `DrizzleQueryError`, postgres.js exposes the
 * SQLSTATE as `code`, and other adapters sometimes use `sqlState` or
 * `sqlstate`.  Walking the cause chain keeps this helper independent of the
 * exact wrapper stack.
 */
export function isPostgresQueryCancelError(error: unknown): boolean {
  for (const current of walkErrorCauses(error)) {
    if (
      getStringProperty(current, "code") === POSTGRES_QUERY_CANCELLED_SQLSTATE
    ) {
      return true;
    }
    if (
      getStringProperty(current, "sqlState") ===
      POSTGRES_QUERY_CANCELLED_SQLSTATE
    ) {
      return true;
    }
    if (
      getStringProperty(current, "sqlstate") ===
      POSTGRES_QUERY_CANCELLED_SQLSTATE
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Cancel a postgres.js Query and consume errors from the cancel request itself.
 *
 * postgres.js Query#cancel() deliberately returns `void` even though the
 * internal canceller creates a Promise for the separate PostgreSQL cancellation
 * connection.  If that connection fails and nobody observes the Promise, Node
 * can report an unhandled rejection.  Calling the internal canceller directly
 * mirrors Query#cancel() while letting us attach a catch handler.
 */
function cancelPostgresQuery(query: CancellableQuery) {
  try {
    if (typeof query.canceller === "function") {
      const canceller = query.canceller;
      query.canceller = null;
      consumeCancelResult(canceller(query));
      return;
    }
    consumeCancelResult(query.cancel());
  } catch {
    // The original query promise will still settle.  Cancellation is a best
    // effort cleanup path triggered after the client has already gone away.
  }
}

function consumeCancelResult(result: unknown) {
  const catchMethod = getUnknownProperty(result, "catch");
  if (typeof catchMethod === "function") {
    void catchMethod.call(result, () => {});
    return;
  }
  if (isThenable(result)) {
    void Promise.resolve(result).catch(() => {});
  }
}

/**
 * Add a Query to the active request context and remove it when it settles.
 *
 * postgres.js does not expose a settlement callback separate from Promise
 * chaining, and adding `.finally()` here would schedule extra user-visible
 * Promise work.  Instead, this wraps the Query instance's own resolve/reject
 * hooks, which postgres.js calls internally when the backend response arrives.
 */
function trackPostgresQuery<T extends CancellableQuery>(query: T): T {
  const context = queryCancellation.getStore();
  if (context == null) return query;

  context.queries.add(query);
  const cleanup = () => {
    context.queries.delete(query);
  };
  if (typeof query.resolve === "function") {
    const originalResolve = query.resolve.bind(query);
    query.resolve = (value) => {
      cleanup();
      return originalResolve(value);
    };
  }
  if (typeof query.reject === "function") {
    const originalReject = query.reject.bind(query);
    query.reject = (reason) => {
      cleanup();
      return originalReject(reason);
    };
  }
  if (context.signal.aborted) {
    cancelPostgresQuery(query);
  }
  return query;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  const then = getUnknownProperty(value, "then");
  return typeof then === "function";
}

/**
 * Iterate an Error plus its `cause` chain without getting stuck on cycles.
 */
function* walkErrorCauses(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = getUnknownProperty(current, "cause");
  }
}

function getStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  const result = getUnknownProperty(value, property);
  return typeof result === "string" ? result : undefined;
}

function getUnknownProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value == null) return undefined;
  if (!(property in value)) return undefined;
  return (value as Record<string, unknown>)[property];
}
