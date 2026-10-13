import { describe, expect, it } from "vitest";
import { openApiDocument } from "../src/api/openapi.js";
import { buildDocsModel } from "../src/ui/api-docs/model.js";
import { schemaFields } from "../src/ui/api-docs/schema-fields.js";
import { nextTheme, THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from "../src/ui/theme.js";

describe("API docs model", () => {
  const model = buildDocsModel();

  it("documents every OpenAPI operation, each in a group (no drift)", () => {
    expect(model.missing).toEqual([]);
    const ops = Object.entries(openApiDocument().paths).flatMap(([p, o]) =>
      Object.keys(o).map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(model.endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual(ops.sort());
    expect(model.groups.flatMap((g) => g.endpoints)).toHaveLength(ops.length);
    expect(new Set(model.endpoints.map((e) => e.id)).size).toBe(ops.length); // unique anchors
  });

  it("marks privileged endpoints and puts the key and body in their example calls", () => {
    const byKey = Object.fromEntries(model.endpoints.map((e) => [`${e.method} ${e.path}`, e]));
    expect(byKey["POST /api/traces/{id}/confirm"]).toMatchObject({ auth: true });
    expect(byKey["POST /api/traces/{id}/confirm"]!.curl).toContain(
      '-H "authorization: Bearer $API_KEY"',
    );
    expect(byKey["POST /api/traces/{id}/confirm"]!.curl).toContain(`-d '{"reference":"order-42"}'`);
    expect(byKey["POST /api/traces"]).toMatchObject({ auth: false });
    expect(byKey["POST /api/traces"]!.curl).not.toContain("authorization");
    expect(byKey["GET /api/traces/{id}"]!.curl).toBe('curl "$BASE/api/traces/$TRACE_ID"');
    expect(byKey["GET /api/traces"]!.curl).toContain("?sourceTxHash=0x");
  });

  it("derives request-body field tables from the zod schemas", () => {
    const create = model.endpoints.find((e) => e.method === "POST" && e.path === "/api/traces")!;
    expect(create.body?.map((f) => [f.name, f.required])).toEqual([
      ["sourceTxHash", true],
      ["sourceChain", true],
      ["requireAppConfirmation", false],
    ]);
    expect(create.body?.find((f) => f.name === "sourceChain")?.type).toBe('"base" | "arc"');
    expect(create.responses.find((r) => r.status === "422")?.meaning).toMatch(/no CCTP V2 burn/);
  });
});

describe("schemaFields", () => {
  it("flattens one level, shows arrays, enums and nullability", () => {
    const rows = schemaFields({
      type: "object",
      required: ["id", "route"],
      properties: {
        id: { type: "string", format: "uuid", description: "Trace id" },
        route: { type: "object", required: ["a"], properties: { a: { type: "integer" } } },
        tags: { type: "array", items: { type: "string" } },
        reason: { type: "string", enum: ["STUCK", "FAILED"], nullable: true },
        x: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
    expect(rows).toEqual([
      { name: "id", type: "string (uuid)", required: true, description: "Trace id" },
      { name: "route", type: "object", required: true, description: null },
      { name: "route.a", type: "integer", required: true, description: null },
      { name: "tags", type: "string[]", required: false, description: null },
      { name: "reason", type: '"STUCK" | "FAILED"', required: false, description: null },
      { name: "x", type: "string | null", required: false, description: null },
    ]);
  });
});

describe("theme", () => {
  it("cycles System → Light → Dark → System and boots from storage", () => {
    expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual([
      "light",
      "dark",
      "system",
    ]);
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    // The boot script must apply a stored choice and swallow storage errors.
    const el = { dataset: {} as Record<string, string> };
    const run = (stored: string | null, throws = false) => {
      el.dataset = {};
      new Function("localStorage", "document", THEME_BOOT_SCRIPT)(
        {
          getItem: () => {
            if (throws) throw new Error("blocked");
            return stored;
          },
        },
        { documentElement: el },
      );
      return el.dataset.theme;
    };
    expect(run("dark")).toBe("dark");
    expect(run("light")).toBe("light");
    expect(run("bogus")).toBeUndefined();
    expect(run(null, true)).toBeUndefined();
  });
});
