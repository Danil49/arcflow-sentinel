/** A JSON-schema object flattened into readable rows for a field table. */
export interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  format?: string;
  nullable?: boolean;
  description?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
  additionalProperties?: unknown;
  $ref?: string;
}

function typeOf(s: Schema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const alts = s.anyOf ?? s.oneOf;
  if (alts) {
    const parts = alts.filter((a) => a.type !== "null").map(typeOf);
    const nullable = alts.some((a) => a.type === "null");
    return parts.join(" | ") + (nullable ? " | null" : "");
  }
  const base = Array.isArray(s.type)
    ? s.type.filter((t) => t !== "null").join(" | ")
    : (s.type ?? "any");
  let t = base === "array" ? `${s.items ? typeOf(s.items) : "any"}[]` : base;
  if (s.format && base === "string") t = `string (${s.format})`;
  if (base === "object" && !s.properties) t = "object";
  const nullable = s.nullable || (Array.isArray(s.type) && s.type.includes("null"));
  return nullable ? `${t} | null` : t;
}

/**
 * Flattens one level of nesting (`route.sourceChain`), which covers every schema this API
 * exposes; deeper objects are shown as `object`.
 */
export function schemaFields(schema: Schema, prefix = "", depth = 0): FieldRow[] {
  const rows: FieldRow[] = [];
  const required = new Set(schema.required ?? []);
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const full = prefix ? `${prefix}.${name}` : name;
    const nested = prop.type === "object" && prop.properties && depth < 1;
    rows.push({
      name: full,
      type: nested ? "object" : typeOf(prop),
      required: required.has(name),
      description: prop.description ?? null,
    });
    if (nested) rows.push(...schemaFields(prop, full, depth + 1));
  }
  return rows;
}
