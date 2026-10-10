/**
 * RFC 8785 JSON Canonicalization Scheme (JCS): object keys sorted by UTF-16 code units, no
 * whitespace, ECMAScript number and string serialization. The output bytes are what gets hashed
 * and signed, so any verifier in any language can reproduce them.
 */
export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError("non-finite number");
      return JSON.stringify(value); // ES6 Number serialization, as JCS requires
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new CanonicalizationError("bigint is not JSON; encode as a decimal string");
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new CanonicalizationError(`unsupported object type ${value.constructor?.name}`);
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      // Default sort compares UTF-16 code units, matching JCS.
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`unsupported type ${typeof value}`);
  }
}
