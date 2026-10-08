/** JSON-safe projection: bigint -> decimal string, Date -> ISO string. Pure and deterministic. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export function toJsonSafe(value: unknown): JsonValue {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  if (value === undefined) return null;
  return value as JsonValue;
}
