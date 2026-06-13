import type postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  DatabaseQueryAbortedError,
  isPostgresQueryCancelError,
  isPostgresQueryCancellationMethod,
  isRequestAbortError,
  postgresQueryCancellationMiddleware,
  withPostgresQueryCancellation,
  wrapPostgresClient,
} from "./db-cancel";

class FakeQuery<T> extends Promise<T> {
  cancelCalls = 0;
  canceller: ((query: unknown) => unknown) | null = null;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;

  constructor(
    private readonly cancelReason = Object.assign(
      new Error("canceling statement due to user request"),
      { code: "57014" },
    ),
  ) {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    super((resolveQuery, rejectQuery) => {
      resolve = resolveQuery;
      reject = rejectQuery;
    });
    this.resolve = resolve;
    this.reject = reject;
  }

  static override get [Symbol.species]() {
    return Promise;
  }

  cancel() {
    this.cancelCalls++;
    this.reject(this.cancelReason);
  }
}

function createSqlClient(queries: FakeQuery<unknown>[] = []): postgres.Sql {
  return {
    unsafe() {
      const query = new FakeQuery<unknown>();
      queries.push(query);
      return query;
    },
  } as unknown as postgres.Sql;
}

describe("withPostgresQueryCancellation", () => {
  it("cancels active postgres.js queries when the request signal aborts", async () => {
    const controller = new AbortController();
    const queries: FakeQuery<unknown>[] = [];
    const client = wrapPostgresClient(createSqlClient(queries));

    await expect(
      withPostgresQueryCancellation(controller.signal, async () => {
        const query = client.unsafe("select 1");
        controller.abort();
        await query;
      }),
    ).rejects.toBeInstanceOf(DatabaseQueryAbortedError);

    expect(queries[0].cancelCalls).toBe(1);
  });

  it("does not cancel queries that already settled before the abort", async () => {
    const controller = new AbortController();
    const queries: FakeQuery<unknown>[] = [];
    const client = wrapPostgresClient(createSqlClient(queries));

    await withPostgresQueryCancellation(controller.signal, async () => {
      const query = client.unsafe("select 1");
      queries[0].resolve([]);
      await query;
      controller.abort();
    });

    expect(queries[0].cancelCalls).toBe(0);
  });

  it("consumes asynchronous postgres.js cancel request failures", async () => {
    const controller = new AbortController();
    const queries: FakeQuery<unknown>[] = [];
    const client = wrapPostgresClient(createSqlClient(queries));
    let cancelFailureWasConsumed = false;

    await withPostgresQueryCancellation(controller.signal, () => {
      const query = client.unsafe("select 1");
      queries[0].canceller = () => ({
        catch(onRejected: (error: unknown) => unknown) {
          cancelFailureWasConsumed = true;
          onRejected(new Error("cancel connection failed"));
        },
      });
      controller.abort();
      query.catch(() => {});
    });

    expect(cancelFailureWasConsumed).toBe(true);
    expect(queries[0].canceller).toBeNull();
    expect(queries[0].cancelCalls).toBe(0);
  });

  it("tracks queries created by transaction clients", async () => {
    const controller = new AbortController();
    const queries: FakeQuery<unknown>[] = [];
    const txClient = createSqlClient(
      queries,
    ) as unknown as postgres.TransactionSql;
    const client = {
      ...createSqlClient(),
      async begin(
        callbackOrOptions:
          | string
          | ((sql: postgres.TransactionSql) => unknown | Promise<unknown>),
        callback?: (sql: postgres.TransactionSql) => unknown | Promise<unknown>,
      ) {
        const run =
          typeof callbackOrOptions === "function"
            ? callbackOrOptions
            : callback!;
        return await run(txClient);
      },
    } as unknown as postgres.Sql;

    const wrappedClient = wrapPostgresClient(client);
    await expect(
      withPostgresQueryCancellation(controller.signal, async () => {
        await wrappedClient.begin(async (tx) => {
          const query = tx.unsafe("select 1");
          controller.abort();
          await query;
        });
      }),
    ).rejects.toBeInstanceOf(DatabaseQueryAbortedError);

    expect(queries[0].cancelCalls).toBe(1);
  });
});

describe("postgresQueryCancellationMiddleware", () => {
  it("enables cancellation for GET requests", async () => {
    const controller = new AbortController();
    const queries: FakeQuery<unknown>[] = [];
    const client = wrapPostgresClient(createSqlClient(queries));
    const middleware = postgresQueryCancellationMiddleware();

    const response = await middleware(
      {
        req: {
          url: "https://hollo.test/api/v1/timelines/home",
          raw: { method: "GET", signal: controller.signal },
        },
      } as never,
      async () => {
        const query = client.unsafe("select 1");
        controller.abort();
        await query;
      },
    );

    expect(response?.status).toBe(499);
    expect(queries[0].cancelCalls).toBe(1);
  });

  it("does not cancel queries for mutation requests", async () => {
    const controller = new AbortController();
    const queries: FakeQuery<unknown>[] = [];
    const client = wrapPostgresClient(createSqlClient(queries));
    const middleware = postgresQueryCancellationMiddleware();

    const response = await middleware(
      {
        req: {
          url: "https://hollo.test/api/v1/statuses",
          raw: { method: "POST", signal: controller.signal },
        },
      } as never,
      async () => {
        const query = client.unsafe("insert into jobs values (1)");
        controller.abort();
        queries[0].resolve([]);
        await query;
      },
    );

    expect(response).toBeUndefined();
    expect(queries[0].cancelCalls).toBe(0);
  });
});

describe("query cancel error helpers", () => {
  it("limits request-driven query cancellation to safe read methods", () => {
    expect(isPostgresQueryCancellationMethod("GET")).toBe(true);
    expect(isPostgresQueryCancellationMethod("HEAD")).toBe(true);
    expect(isPostgresQueryCancellationMethod("POST")).toBe(false);
    expect(isPostgresQueryCancellationMethod("PUT")).toBe(false);
    expect(isPostgresQueryCancellationMethod("PATCH")).toBe(false);
    expect(isPostgresQueryCancellationMethod("DELETE")).toBe(false);
  });

  it("detects SQLSTATE 57014 through wrapper error causes", () => {
    const cause = Object.assign(
      new Error("canceling statement due to user request"),
      { code: "57014" },
    );
    const error = new Error("Failed query", { cause });
    const controller = new AbortController();

    expect(isPostgresQueryCancelError(error)).toBe(true);
    expect(isRequestAbortError(error, controller.signal)).toBe(false);

    controller.abort();
    expect(isRequestAbortError(error, controller.signal)).toBe(true);
  });
});
