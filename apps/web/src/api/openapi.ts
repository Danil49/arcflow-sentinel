import { z } from "zod";
import {
  confirmBody,
  createTraceBody,
  eventsResponse,
  invariantDto,
  problemDto,
  traceDto,
  tracesResponse,
} from "./schemas.js";

const schema = (s: z.ZodType) =>
  z.toJSONSchema(s, { target: "openapi-3.0", unrepresentable: "any" });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (name: string, type = "application/json") => ({
  content: { [type]: { schema: ref(name) } },
});
const problems = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      { description: "Problem", ...content("Problem", "application/problem+json") },
    ]),
  );
const idParam = [
  { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
];
const bearer = [{ bearerAuth: [] }];

/** OpenAPI 3.0 document generated from the same zod schemas the handlers validate with. */
export function openApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "ArcFlow Sentinel API",
      version: "0.3.0",
      description:
        "Lifecycle, invariants and evidence for CCTP V2 USDC transfers between Arc and Base. " +
        "Amounts are decimal strings in 6-decimal atomic units. Errors are RFC 7807 problems.",
    },
    paths: {
      "/api/traces": {
        post: {
          summary: "Trace a source transaction (idempotent)",
          description:
            "201 when new traces were created, 200 with the existing traces otherwise. " +
            "requireAppConfirmation needs an API key.",
          requestBody: { required: true, ...content("CreateTrace") },
          responses: {
            "200": { description: "Existing traces", ...content("Traces") },
            "201": { description: "Created", ...content("Traces") },
            ...problems(400, 401, 415, 422, 500),
          },
        },
        get: {
          summary: "Look up traces by source transaction",
          parameters: [
            { name: "sourceTxHash", in: "query", required: true, schema: { type: "string" } },
            {
              name: "sourceChain",
              in: "query",
              required: true,
              schema: { type: "string", enum: ["base", "arc"] },
            },
          ],
          responses: {
            "200": { description: "Traces", ...content("Traces") },
            ...problems(400, 404),
          },
        },
      },
      "/api/traces/{id}": {
        get: {
          summary: "Get a trace",
          parameters: idParam,
          responses: { "200": { description: "Trace", ...content("Trace") }, ...problems(404) },
        },
      },
      "/api/traces/{id}/events": {
        get: {
          summary: "Raw and decoded observations",
          parameters: idParam,
          responses: { "200": { description: "Events", ...content("Events") }, ...problems(404) },
        },
      },
      "/api/traces/{id}/invariants": {
        get: {
          summary: "Invariant results",
          parameters: idParam,
          responses: {
            "200": {
              description: "Invariants",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { invariants: { type: "array", items: ref("Invariant") } },
                  },
                },
              },
            },
            ...problems(404),
          },
        },
      },
      "/api/traces/{id}/confirm": {
        post: {
          summary: "Application confirmation (MINT_CONFIRMED → APPLICATION_CONFIRMED)",
          security: bearer,
          parameters: idParam,
          requestBody: { required: false, ...content("Confirm") },
          responses: {
            "200": { description: "Trace", ...content("Trace") },
            ...problems(400, 401, 404, 409),
          },
        },
      },
      "/api/webhooks/test": {
        post: {
          summary: "Send a signed test event to every endpoint",
          security: bearer,
          responses: { "202": { description: "Queued" }, ...problems(401, 409) },
        },
      },
      "/api/health/live": {
        get: { summary: "Liveness", responses: { "200": { description: "OK" } } },
      },
      "/api/health/ready": {
        get: {
          summary: "Readiness (database)",
          responses: { "200": { description: "OK" }, "503": { description: "Unavailable" } },
        },
      },
      "/api/health/routes": {
        get: {
          summary: "Chain heads and Iris reachability (cached 15s)",
          responses: { "200": { description: "OK" }, "503": { description: "Degraded" } },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        CreateTrace: schema(createTraceBody),
        Confirm: schema(confirmBody),
        Trace: schema(traceDto),
        Traces: schema(tracesResponse),
        Events: schema(eventsResponse),
        Invariant: schema(invariantDto),
        Problem: schema(problemDto),
      },
    },
    "x-webhooks": {
      headers: [
        "x-sentinel-event-id",
        "x-sentinel-event-type",
        "x-sentinel-sequence",
        "x-sentinel-timestamp",
        "x-sentinel-retry",
        "x-sentinel-signature",
      ],
      signature:
        "v1=hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)); reject timestamps older than 5 minutes; " +
        "ignore events whose sequence is not greater than the last one processed for the trace",
    },
  };
}
