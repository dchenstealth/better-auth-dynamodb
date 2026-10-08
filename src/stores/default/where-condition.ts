import type { CleanedWhere } from "@better-auth/core/db/adapter";

/** DynamoDB's limit on operands in one `IN` comparison. */
const MAX_IN_OPERANDS = 100;

/** A condition fragment, and whether it needs parentheses inside an `AND`. */
export interface ConditionPart {
  expression: string;
  /** The expression is an `OR` at its top level. */
  topLevelOr: boolean;
}

/** A `ConditionExpression` with the names and values it references. */
export interface WhereCondition extends ConditionPart {
  names: Record<string, string>;
  values: Record<string, unknown>;
}

/**
 * Translate `where` clauses into a DynamoDB `ConditionExpression` that accepts
 * the rows {@link matchesResidual} accepts: every `AND` clause, plus at least
 * one `OR` clause if there are any.
 *
 * Returns `undefined` for an empty `where`, and `null` when some clause has no
 * faithful DynamoDB equivalent (case-insensitive comparison, `ends_with`, a
 * null or non-scalar operand, an empty or oversized `in` list). The caller must
 * then check the clauses another way, never skip them.
 *
 * Placeholders are prefixed with `prefix` so they cannot collide with the ones
 * the store already uses in the same request. Parentheses appear only where
 * precedence needs them: DynamoDB rejects redundant ones.
 */
export function whereToCondition(
  where: CleanedWhere[],
  prefix = "w",
): WhereCondition | undefined | null {
  if (where.length === 0) return undefined;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  let nextName = 0;
  let nextValue = 0;
  const name = (field: string): string => {
    const existing = Object.entries(names).find(([, f]) => f === field);
    if (existing) return existing[0];
    const placeholder = `#${prefix}${nextName++}`;
    names[placeholder] = field;
    return placeholder;
  };
  const value = (v: unknown): string => {
    const placeholder = `:${prefix}${nextValue++}`;
    values[placeholder] = v;
    return placeholder;
  };

  const simple = (expression: string): ConditionPart => ({
    expression,
    topLevelOr: false,
  });
  // A missing attribute is "not equal" and "not in" anything, as in memory.
  const orMissing = (f: string, expression: string): ConditionPart => ({
    expression: `attribute_not_exists(${f}) OR ${expression}`,
    topLevelOr: true,
  });

  const clause = (w: CleanedWhere): ConditionPart | null => {
    if (w.mode === "insensitive") return null;
    const v = w.value as unknown;
    if (w.operator === "in" || w.operator === "not_in") {
      if (!Array.isArray(v) || v.length === 0 || v.length > MAX_IN_OPERANDS)
        return null;
      if (!v.every(isScalar)) return null;
      const f = name(w.field);
      const list = `${f} IN (${v.map(value).join(", ")})`;
      return w.operator === "in" ? simple(list) : orMissing(f, `NOT ${list}`);
    }
    if (!isScalar(v)) return null;
    const f = name(w.field);
    switch (w.operator) {
      case "eq":
        return simple(`${f} = ${value(v)}`);
      case "ne":
        return orMissing(f, `${f} <> ${value(v)}`);
      case "lt":
        return simple(`${f} < ${value(v)}`);
      case "lte":
        return simple(`${f} <= ${value(v)}`);
      case "gt":
        return simple(`${f} > ${value(v)}`);
      case "gte":
        return simple(`${f} >= ${value(v)}`);
      case "contains":
        return typeof v === "string"
          ? simple(`contains(${f}, ${value(v)})`)
          : null;
      case "starts_with":
        return typeof v === "string"
          ? simple(`begins_with(${f}, ${value(v)})`)
          : null;
      default:
        return null;
    }
  };

  const and: ConditionPart[] = [];
  const or: ConditionPart[] = [];
  for (const w of where) {
    const c = clause(w);
    if (c === null) return null;
    (w.connector === "OR" ? or : and).push(c);
  }
  if (or.length) {
    // AND binds tighter than OR, so the alternatives need no parentheses of
    // their own.
    and.push({
      expression: or.map((p) => p.expression).join(" OR "),
      topLevelOr: or.length > 1 || or[0]!.topLevelOr,
    });
  }
  const joined = and.length === 1 ? and[0]! : simple(andConditions(...and));
  return { ...joined, names, values };
}

/** Join conditions with `AND`, parenthesizing only the ones that need it. */
export function andConditions(...parts: ConditionPart[]): string {
  return parts.length === 1
    ? parts[0]!.expression
    : parts.map(andOperand).join(" AND ");
}

const andOperand = (p: ConditionPart) =>
  p.topLevelOr ? `(${p.expression})` : p.expression;

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  typeof v === "boolean";
