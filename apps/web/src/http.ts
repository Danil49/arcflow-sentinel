import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
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

const problem = (e: HttpError) =>
  new Response(
    JSON.stringify({
      type: "about:blank",
      title: e.title,
      status: e.status,
      detail: e.detail,
      ...e.extra,
    }),
    {
      status: e.status,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
    },
  );

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
        return problem(new HttpError(422, "Unprocessable trace", err.message));
      const id = crypto.randomUUID();
      console.error(
        JSON.stringify({ msg: "unhandled api error", errorId: id, error: String(err) }),
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

export function requireAuth(ctx: ApiContext, req: Request): void {
  if (!isAuthorized(ctx, req)) {
    throw new HttpError(
      401,
      "Unauthorized",
      "a valid API key is required (Authorization: Bearer <key>)",
    );
  }
}
