import { betterAuth } from "better-auth";
import { describe, expect, it } from "vitest";

import { dynamoAdapter } from "./adapter";
import { UnsupportedQueryError } from "./errors";
import type { DynamoStore, StoreItem } from "./types";

/**
 * A store that records how it was reached, so these tests can assert on the
 * *access path* the adapter chose rather than on the data it returned.
 */
function createSpyStore(rows: StoreItem[] = []): DynamoStore & {
  listCalls: number;
  indexCalls: number;
} {
  const state = { listCalls: 0, indexCalls: 0 };
  return {
    get listCalls() {
      return state.listCalls;
    },
    get indexCalls() {
      return state.indexCalls;
    },
    put: async (_m, item) => item,
    getById: async (_m, id) => rows.find((r) => r.id === id) ?? null,
    update: async () => null,
    deleteById: async () => undefined,
    queryIndex: async ({ key }) => {
      state.indexCalls++;
      return {
        items: rows.filter((r) =>
          Object.entries(key).every(([k, v]) => r[k] === v),
        ),
      };
    },
    listByType: async () => {
      state.listCalls++;
      return { items: rows };
    },
  };
}

const authWith = (config: Parameters<typeof dynamoAdapter>[0]) =>
  betterAuth({
    secret: "better-auth-dynamodb-test-secret-0123456789",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    database: dynamoAdapter(config),
  });

const adapterFor = async (config: Parameters<typeof dynamoAdapter>[0]) => {
  const auth = authWith(config);
  return (await auth.$context).adapter;
};

describe("no-hidden-scan policy", () => {
  it("refuses a query no index can serve", async () => {
    const store = createSpyStore();
    const adapter = await adapterFor({ store });

    // `name` is not unique, not a foreign key, and not flagged `index: true`,
    // so serving this means reading every user and filtering in memory.
    await expect(
      adapter.findOne({
        model: "user",
        where: [{ field: "name", value: "Ada", operator: "eq" }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);
    expect(store.listCalls).toBe(0);
  });

  it("names the offending fields and the ways out", async () => {
    const adapter = await adapterFor({ store: createSpyStore() });
    await expect(
      adapter.findOne({
        model: "user",
        where: [{ field: "name", value: "Ada", operator: "eq" }],
      }),
    ).rejects.toThrow(/name eq[\s\S]*unsafeAllowScan/);
  });

  it("allows the scan when it is explicitly opted into", async () => {
    const store = createSpyStore([{ id: "u_1", name: "Ada" }]);
    const adapter = await adapterFor({ store, unsafeAllowScan: true });

    await expect(
      adapter.findOne({
        model: "user",
        where: [{ field: "name", value: "Ada", operator: "eq" }],
      }),
    ).resolves.toMatchObject({ id: "u_1" });
    expect(store.listCalls).toBe(1);
  });

  it("never reaches the guard for an indexed field", async () => {
    const store = createSpyStore([{ id: "u_1", email: "ada@example.com" }]);
    const adapter = await adapterFor({ store });

    await expect(
      adapter.findOne({
        model: "user",
        where: [{ field: "email", value: "ada@example.com", operator: "eq" }],
      }),
    ).resolves.toMatchObject({ id: "u_1" });
    expect(store.indexCalls).toBe(1);
    expect(store.listCalls).toBe(0);
  });

  it("never reaches the guard for a direct id lookup", async () => {
    const store = createSpyStore([{ id: "u_1", email: "ada@example.com" }]);
    const adapter = await adapterFor({ store });

    await expect(
      adapter.findOne({
        model: "user",
        where: [{ field: "id", value: "u_1", operator: "eq" }],
      }),
    ).resolves.toMatchObject({ id: "u_1" });
    expect(store.indexCalls).toBe(0);
    expect(store.listCalls).toBe(0);
  });
});

describe("id batch loads", () => {
  it("fetches an `id in [...]` set directly, never through a scan", async () => {
    const store = createSpyStore([
      { id: "u_1", email: "a@example.com" },
      { id: "u_2", email: "b@example.com" },
      { id: "u_3", email: "c@example.com" },
    ]);
    const adapter = await adapterFor({ store });

    const rows = await adapter.findMany<{ id: string }>({
      model: "user",
      where: [{ field: "id", value: ["u_1", "u_3"], operator: "in" }],
      limit: 10,
    });

    expect(rows.map((r) => r.id).sort()).toEqual(["u_1", "u_3"]);
    expect(store.listCalls).toBe(0);
    expect(store.indexCalls).toBe(0);
  });

  it("skips ids that do not resolve", async () => {
    const store = createSpyStore([{ id: "u_1", email: "a@example.com" }]);
    const adapter = await adapterFor({ store });

    const rows = await adapter.findMany({
      model: "user",
      where: [{ field: "id", value: ["u_1", "missing"], operator: "in" }],
      limit: 10,
    });
    expect(rows).toHaveLength(1);
  });

  it("counts an id set by resolving it, not by counting the model", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `u_${i}` }));
    const store = createSpyStore(rows);
    let nativeCounts = 0;
    store.count = async () => {
      nativeCounts++;
      return rows.length;
    };
    const adapter = await adapterFor({ store });

    // The native count describes a whole model or an index — not a set of ids.
    // Using it here would answer 20 to a question about 2.
    expect(
      await adapter.count({
        model: "user",
        where: [{ field: "id", value: ["u_1", "u_2"], operator: "in" }],
      }),
    ).toBe(2);
    expect(nativeCounts).toBe(0);
  });

  it("does not use the native count for a single-id lookup either", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `u_${i}` }));
    const store = createSpyStore(rows);
    store.count = async () => rows.length;
    const adapter = await adapterFor({ store });

    expect(
      await adapter.count({
        model: "user",
        where: [{ field: "id", value: "u_1", operator: "eq" }],
      }),
    ).toBe(1);
  });
});

describe("page cap", () => {
  it("propagates through the adapter rather than truncating", async () => {
    const store = createSpyStore();
    // A store that never stops paginating — the cap is the only thing that
    // ends this, and it must end it with an error, not a partial answer.
    let pagesFetched = 0;
    store.queryIndex = async () => {
      pagesFetched++;
      return {
        items: [{ id: "u_1", email: "ada@example.com" }],
        cursor: "more",
      };
    };
    const adapter = await adapterFor({ store, maxPages: 4 });

    await expect(
      adapter.findMany({
        model: "user",
        where: [{ field: "email", value: "ada@example.com", operator: "eq" }],
        limit: 10,
      }),
    ).rejects.toThrow(/maxPages \(4\)/);
    expect(pagesFetched).toBe(4);
  });
});

describe("consumeOne and incrementOne pass the whole where to the store", () => {
  // The adapter finds the row with a read. Only the store's write can tell
  // whether it still matches, so the store must see every clause, not just
  // the id the read resolved.
  const where = [
    { field: "identifier", value: "otp:ada", operator: "eq" as const },
    { field: "value", value: "123456", operator: "eq" as const },
  ];
  const row = { id: "v_1", identifier: "otp:ada", value: "123456" };

  it("hands consumeOne its conditions", async () => {
    const store = createSpyStore([row]);
    const seen: unknown[] = [];
    store.consumeOne = async (_m, _id, conditions) => {
      seen.push(conditions);
      return null;
    };
    const adapter = await adapterFor({ store, unsafeAllowScan: true });

    await adapter.consumeOne({ model: "verification", where });
    expect(seen).toEqual([
      [
        expect.objectContaining({ field: "identifier", value: "otp:ada" }),
        expect.objectContaining({ field: "value", value: "123456" }),
      ],
    ]);
  });

  it("hands incrementOne its conditions", async () => {
    const store = createSpyStore([row]);
    const seen: unknown[] = [];
    store.incrementOne = async (_m, _id, req) => {
      seen.push(req.conditions);
      return null;
    };
    const adapter = await adapterFor({ store, unsafeAllowScan: true });

    await adapter.incrementOne({
      model: "verification",
      where,
      increment: {},
      set: { value: "654321" },
    });
    expect(seen).toEqual([
      [
        expect.objectContaining({ field: "identifier", value: "otp:ada" }),
        expect.objectContaining({ field: "value", value: "123456" }),
      ],
    ]);
  });

  it("re-checks the where in the non-atomic fallbacks", async () => {
    // The row changes between the adapter's lookup and the fallback's own
    // read; the fallback must notice rather than act on the stale match.
    const store = createSpyStore([row]);
    let writes = 0;
    store.deleteById = async () => {
      writes++;
    };
    store.update = async () => {
      writes++;
      return null;
    };
    store.getById = async () => ({ ...row, value: "changed" });
    const adapter = await adapterFor({ store, unsafeAllowScan: true });

    await expect(
      adapter.consumeOne({ model: "verification", where }),
    ).resolves.toBeNull();
    await expect(
      adapter.incrementOne({
        model: "verification",
        where,
        increment: {},
        set: { value: "654321" },
      }),
    ).resolves.toBeNull();
    expect(writes).toBe(0);
  });
});
