import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { errorText, redact } from "@sentinel/config";
import { toJsonSafe } from "@sentinel/core";
import { TraceInputError } from "@sentinel/worker";
import type { ApiContext } from "./context.js";

/** RFC 7807 problem details. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail ?? title);
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(toJsonSafe(body)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const problem = (e: HttpError) => {
  const retryAfter = e.extra?.retryAfterSec;
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: e.title,
      status: e.status,
      detail: e.detail,
      ...e.extra,
    }),
    {
      status: e.status,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        ...(typeof retryAfter === "number" ? { "retry-after": String(retryAfter) } : {}),
      },
    },
  );
};

/**
 * Wraps a handler: maps known errors to problem responses and hides internals for anything
 * unexpected (logged server-side with a correlation id only).
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) return problem(err);
      if (err instanceof TraceInputError)
        return problem(new HttpError(422, "Unprocessable trace", redact(err.message)));
      const id = crypto.randomUUID();
      console.error(
        JSON.stringify({ msg: "unhandled api error", errorId: id, error: errorText(err) }),
      );
      return problem(new HttpError(500, "Internal error", `error id ${id}`));
    }
  };
}

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json"))
    throw new HttpError(415, "Unsupported media type", "expected application/json");
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  return parse(schema, raw);
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, "Validation failed", undefined, {
      errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

const bearer = (req: Request) =>
  req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;

export function isAuthorized(ctx: ApiContext, req: Request): boolean {
  const token = bearer(req);
  if (!token) return false;
  const given = Buffer.from(token);
  return ctx.apiKeys.some((k) => {
    const key = Buffer.from(k);
    return key.length === given.length && timingSafeEqual(key, given);
  });
}

/**
 * Client identity for rate limiting. Only X-Forwarded-For's rightmost entry is used (the address
 * your trusted proxy saw), and only when TRUST_PROXY is set; otherwise every client shares "anon".
 */
export function clientKey(ctx: ApiContext, req: Request): string {
  if (!ctx.rateLimit.trustProxy) return "anon";
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  return ip ? `ip:${ip}` : "anon";
}

export function requireAuth(ctx: ApiContext, req: Request): void {
  if (!isAuthorized(ctx, req)) {
    throw new HttpError(
      401,
      "Unauthorized",
      "a valid API key is required (Authorization: Bearer <key>)",
    );
  }
}
