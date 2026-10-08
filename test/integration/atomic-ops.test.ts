import type { CleanedWhere } from "@better-auth/core/db/adapter";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DynamoStore } from "../../src/index";
import {
  assignSlots,
  createSingleTableStore,
  deriveIndexMap,
  dynamoAdapter,
  ensureSchema,
  matchesResidual,
} from "../../src/index";
import { startDynamoLocal, type DynamoLocal } from "../support/dynamodb-local";

/**
 * `consumeOne` and `incrementOne` under real concurrency, against DynamoDB
 * Local. The adapter finds the row with a read and the store writes it, so the
 * caller's `where` (the rate limiter's `count < max`, a code's expected value)
 * only holds if the write itself checks it. These tests race the write.
 */
const TABLE = `better-auth-atomic-${process.pid}`;
const MAX = 3;

const OPTIONS = {
  secret: "test-secret-that-is-at-least-32-chars-long",
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: MAX,
    customRules: { "/sign-in/email": { window: 60, max: MAX } },
  },
} as const;

let dynamo: DynamoLocal;
let store: DynamoStore;

const createAuth = () =>
  betterAuth({
    ...OPTIONS,
    database: dynamoAdapter({
      tableName: TABLE,
      documentClient: dynamo.documentClient,
    }),
  });
let auth: ReturnType<typeof createAuth>;
type Adapter = Awaited<ReturnType<typeof createAuth>["$context"]>["adapter"];
let adapter: Adapter;

const cond = (
  field: string,
  operator: CleanedWhere["operator"],
  value: CleanedWhere["value"],
  connector: CleanedWhere["connector"] = "AND",
): CleanedWhere => ({ field, operator, value, connector, mode: "sensitive" });

const verification = (fields: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    identifier: `otp:${randomUUID()}`,
    value: "123456",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
};

beforeAll(async () => {
  dynamo = await startDynamoLocal();
  const indexMap = deriveIndexMap(getAuthTables(OPTIONS));
  await ensureSchema({
    client: dynamo.client,
    tableName: TABLE,
    lookupSlots: assignSlots(indexMap).maxSlots,
  });
  store = createSingleTableStore({
    tableName: TABLE,
    documentClient: dynamo.documentClient,
    indexMap,
  });
  auth = createAuth();
  adapter = (await auth.$context).adapter;
}, 180_000);

afterAll(async () => {
  await dynamo?.stop();
});

describe("incrementOne under the rate limiter's guard", () => {
  it("admits exactly one of many parallel requests at max - 1", async () => {
    const key = `203.0.113.1|/sign-in/email|${randomUUID()}`;
    const lastRequest = Date.now();
    await adapter.create({
      model: "rateLimit",
      data: { key, count: MAX - 1, lastRequest },
    });

    // The same call Better Auth's rate limiter makes inside a window.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        adapter.incrementOne({
          model: "rateLimit",
          where: [
            { field: "key", value: key },
            {
              field: "lastRequest",
              operator: "gt",
              value: lastRequest - 60_000,
            },
            { field: "count", operator: "lt", value: MAX },
          ],
          increment: { count: 1 },
          set: { lastRequest: Date.now() },
        }),
      ),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const row = await adapter.findOne<{ count: number }>({
      model: "rateLimit",
      where: [{ field: "key", value: key }],
    });
    expect(row?.count).toBe(MAX);
  });

  it("lets one of many parallel window resets win", async () => {
    const key = `203.0.113.2|/sign-in/email|${randomUUID()}`;
    const stale = Date.now() - 120_000;
    await adapter.create({
      model: "rateLimit",
      data: { key, count: MAX, lastRequest: stale },
    });

    // The reset Better Auth makes once the window has passed: guarded on the
    // `lastRequest` it read, so only the first resetter starts the new window.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        adapter.incrementOne({
          model: "rateLimit",
          where: [
            { field: "key", value: key },
            { field: "lastRequest", operator: "lte", value: stale },
          ],
          increment: {},
          set: { count: 1, lastRequest: Date.now() },
        }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("holds Better Auth's own rate limiter to max under a burst", async () => {
    const burst = await Promise.all(
      Array.from({ length: 12 }, () =>
        auth.handler(
          new Request("http://localhost:3000/api/auth/sign-in/email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": "198.51.100.9",
            },
            body: JSON.stringify({
              email: "nobody@example.com",
              password: "not-the-password",
            }),
          }),
        ),
      ),
    );
    const limited = burst.filter((r) => r.status === 429).length;
    expect(burst.length - limited).toBe(MAX);
  }, 30_000);
});

describe("consumeOne under concurrency", () => {
  it("lets exactly one of many parallel consumers win (no markers)", async () => {
    const v = verification();
    await store.put("verification", v);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        adapter.consumeOne({
          model: "verification",
          where: [
            { field: "identifier", value: v.identifier },
            { field: "value", value: v.value },
          ],
        }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await store.getById("verification", v.id)).toBeNull();
  });

  it("lets exactly one of many parallel consumers win (with markers)", async () => {
    const { user } = await auth.api.signUpEmail({
      body: {
        email: `consume-${randomUUID()}@example.com`,
        password: "correct-horse-battery",
        name: "Ada",
      },
    });
    const token = `tok-${randomUUID()}`;
    await adapter.create({
      model: "session",
      data: {
        token,
        userId: user.id,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        adapter.consumeOne({
          model: "session",
          where: [
            { field: "token", value: token },
            { field: "userId", value: user.id },
          ],
        }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  }, 30_000);
});

describe("a where that no longer matches the row is refused by the write", () => {
  // The adapter's read is the stale one here: these call the store with the
  // row id it resolved and a `where` the row has since stopped matching.
  it("consumeOne, single conditional delete", async () => {
    const v = verification();
    await store.put("verification", v);
    await expect(
      store.consumeOne!("verification", v.id, [
        cond("value", "eq", "a-code-that-was-replaced"),
      ]),
    ).resolves.toBeNull();
    expect(await store.getById("verification", v.id)).not.toBeNull();
  });

  it("consumeOne, revision-guarded transaction", async () => {
    const { user } = await auth.api.signUpEmail({
      body: {
        email: `stale-${randomUUID()}@example.com`,
        password: "correct-horse-battery",
        name: "Ada",
      },
    });
    await expect(
      store.consumeOne!("user", user.id, [cond("name", "eq", "Grace")]),
    ).resolves.toBeNull();
    expect(await store.getById("user", user.id)).not.toBeNull();
  }, 30_000);

  it("incrementOne leaves the counter alone", async () => {
    const v = verification({ attempts: 5 });
    await store.put("verification", v);
    await expect(
      store.incrementOne!("verification", v.id, {
        increment: { attempts: 1 },
        conditions: [cond("attempts", "lt", 5)],
      }),
    ).resolves.toBeNull();
    expect(await store.getById("verification", v.id)).toMatchObject({
      attempts: 5,
    });
  });
});

describe("the write's condition agrees with the in-memory match", () => {
  const row = verification({ attempts: 2, label: "alpha-beta" });
  beforeAll(async () => {
    await store.put("verification", row);
  });

  it.each<[string, CleanedWhere[]]>([
    ["eq", [cond("value", "eq", "123456")]],
    ["eq, other type", [cond("attempts", "eq", "2")]],
    ["ne", [cond("value", "ne", "123456")]],
    ["ne, missing attribute", [cond("missing", "ne", "x")]],
    ["lt", [cond("attempts", "lt", 2)]],
    ["lte", [cond("attempts", "lte", 2)]],
    ["gt", [cond("attempts", "gt", 1)]],
    ["gte", [cond("attempts", "gte", 3)]],
    ["in", [cond("attempts", "in", [1, 2])]],
    ["in, no match", [cond("attempts", "in", [3, 4])]],
    ["not_in", [cond("attempts", "not_in", [1, 2])]],
    ["not_in, missing attribute", [cond("missing", "not_in", ["x"])]],
    ["contains", [cond("label", "contains", "ha-be")]],
    ["starts_with", [cond("label", "starts_with", "beta")]],
    [
      "AND with OR",
      [
        cond("value", "eq", "123456"),
        cond("attempts", "eq", 9, "OR"),
        cond("label", "starts_with", "alpha", "OR"),
      ],
    ],
    [
      "OR, none match",
      [cond("attempts", "eq", 9, "OR"), cond("label", "eq", "x", "OR")],
    ],
  ])("%s", async (_, where) => {
    const expected = matchesResidual(
      (await store.getById("verification", row.id))!,
      where,
    );
    const written = await store.incrementOne!("verification", row.id, {
      increment: {},
      conditions: where,
    });
    expect(written !== null).toBe(expected);
  });
});
