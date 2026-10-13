import { openApiDocument } from "../../api/openapi.js";
import { ENDPOINT_META, GROUPS, STATUS_WORDS, type EndpointMeta, type GroupId } from "./meta.js";
import { schemaFields, type FieldRow } from "./schema-fields.js";

export interface DocParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  type: string;
}

export interface DocEndpoint extends EndpointMeta {
  id: string;
  method: "GET" | "POST";
  path: string;
  summary: string;
  auth: boolean;
  params: DocParam[];
  body: FieldRow[] | null;
  responses: { status: string; meaning: string }[];
  curl: string;
}

type Op = {
  summary: string;
  security?: unknown[];
  parameters?: {
    name: string;
    in: "path" | "query";
    required?: boolean;
    schema?: { type?: string; enum?: string[]; format?: string };
  }[];
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  responses: Record<string, { description: string }>;
};

const slug = (method: string, path: string) =>
  `${method}-${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Example call. Uses shell variables so it can be pasted after the quick-start exports. */
function curlFor(method: string, path: string, meta: EndpointMeta, auth: boolean): string {
  const url = `$BASE${path.replace("{id}", "$TRACE_ID")}${meta.query ? `?${meta.query}` : ""}`;
  const parts = [`curl${method === "GET" ? "" : ` -X ${method}`} "${url}"`];
  if (auth) parts.push(`-H "authorization: Bearer $API_KEY"`);
  if (meta.body !== undefined) {
    parts.push(`-H "content-type: application/json"`, `-d '${JSON.stringify(meta.body)}'`);
  }
  return parts.join(" \\\n  ");
}

/** The docs page model, built from the same OpenAPI document served at /api/openapi.json. */
export function buildDocsModel() {
  const doc = openApiDocument();
  const schemas = doc.components.schemas as Record<string, unknown>;
  const endpoints: DocEndpoint[] = [];
  const missing: string[] = [];

  for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, Op>>)) {
    for (const [m, op] of Object.entries(ops)) {
      const method = m.toUpperCase() as "GET" | "POST";
      const key = `${method} ${path}`;
      const meta = ENDPOINT_META[key];
      if (!meta) {
        missing.push(key);
        continue;
      }
      const auth = Boolean(op.security?.length);
      const ref = op.requestBody?.content?.["application/json"]?.schema?.$ref;
      const bodySchema = ref ? schemas[ref.split("/").pop()!] : undefined;
      endpoints.push({
        ...meta,
        id: slug(method, path),
        method,
        path,
        summary: op.summary,
        auth,
        params: (op.parameters ?? []).map((p) => ({
          name: p.name,
          in: p.in,
          required: Boolean(p.required),
          type: p.schema?.enum
            ? p.schema.enum.map((v) => JSON.stringify(v)).join(" | ")
            : (p.schema?.format ?? p.schema?.type ?? "string"),
        })),
        body: bodySchema ? schemaFields(bodySchema as never) : null,
        responses: Object.keys(op.responses)
          .sort()
          .map((status) => ({
            status,
            meaning:
              meta.statusNotes?.[status] ??
              STATUS_WORDS[status] ??
              op.responses[status]!.description,
          })),
        curl: curlFor(method, path, meta, auth),
      });
    }
  }

  const groups = GROUPS.map((g) => ({
    ...g,
    endpoints: endpoints.filter((e) => e.group === (g.id as GroupId)),
  }));
  return { groups, endpoints, missing, version: doc.info.version, webhooks: doc["x-webhooks"] };
}
