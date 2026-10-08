import type { CleanedWhere } from "@better-auth/core/db/adapter";
import { describe, expect, it } from "vitest";

import { andConditions, whereToCondition } from "./where-condition";

const w = (
  field: string,
  operator: CleanedWhere["operator"],
  value: CleanedWhere["value"],
  extra: Partial<CleanedWhere> = {},
): CleanedWhere => ({
  field,
  operator,
  value,
  connector: "AND",
  mode: "sensitive",
  ...extra,
});

describe("whereToCondition", () => {
  it("has nothing to say about an empty where", () => {
    expect(whereToCondition([])).toBeUndefined();
  });

  it("joins AND clauses, and requires one of the OR clauses", () => {
    const condition = whereToCondition([
      w("key", "eq", "k"),
      w("count", "lt", 3),
      w("a", "eq", 1, { connector: "OR" }),
      w("b", "eq", 2, { connector: "OR" }),
    ]);
    expect(condition).toEqual({
      expression: "#w0 = :w0 AND #w1 < :w1 AND (#w2 = :w2 OR #w3 = :w3)",
      names: { "#w0": "key", "#w1": "count", "#w2": "a", "#w3": "b" },
      values: { ":w0": "k", ":w1": 3, ":w2": 1, ":w3": 2 },
      topLevelOr: false,
    });
  });

  it("reuses one name placeholder per field", () => {
    const condition = whereToCondition([
      w("lastRequest", "gt", 1),
      w("lastRequest", "lte", 9),
    ]);
    expect(condition?.names).toEqual({ "#w0": "lastRequest" });
    expect(condition?.expression).toBe("#w0 > :w0 AND #w0 <= :w1");
  });

  it("lets a missing attribute satisfy ne and not_in, as in memory", () => {
    expect(whereToCondition([w("f", "ne", "x")])).toMatchObject({
      expression: "attribute_not_exists(#w0) OR #w0 <> :w0",
      topLevelOr: true,
    });
    expect(
      whereToCondition([w("f", "not_in", ["x", "y"]), w("g", "eq", 1)]),
    ).toMatchObject({
      expression:
        "(attribute_not_exists(#w0) OR NOT #w0 IN (:w0, :w1)) AND #w1 = :w2",
      topLevelOr: false,
    });
  });

  it("parenthesizes only where precedence needs it", () => {
    // DynamoDB rejects redundant parentheses outright.
    const single = whereToCondition([w("f", "eq", 1, { connector: "OR" })])!;
    expect(single).toMatchObject({
      expression: "#w0 = :w0",
      topLevelOr: false,
    });
    const either = whereToCondition([
      w("f", "eq", 1, { connector: "OR" }),
      w("g", "eq", 2, { connector: "OR" }),
    ])!;
    expect(either.topLevelOr).toBe(true);
    expect(
      andConditions(
        { expression: "attribute_exists(#pk)", topLevelOr: false },
        either,
      ),
    ).toBe("attribute_exists(#pk) AND (#w0 = :w0 OR #w1 = :w1)");
  });

  it("uses the given placeholder prefix", () => {
    expect(whereToCondition([w("f", "eq", 1)], "c")).toMatchObject({
      expression: "#c0 = :c0",
    });
  });

  it.each([
    ["case-insensitive", w("email", "eq", "A@x.io", { mode: "insensitive" })],
    ["ends_with", w("email", "ends_with", "@x.io")],
    ["a null operand", w("f", "eq", null)],
    ["an empty in list", w("f", "in", [])],
    ["an oversized in list", w("f", "in", Array.from({ length: 101 }, String))],
    ["a non-string contains", w("f", "contains", 1)],
  ])("refuses %s rather than approximate it", (_, clause) => {
    expect(whereToCondition([w("id", "eq", "x"), clause])).toBeNull();
  });
});
