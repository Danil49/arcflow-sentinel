import { json } from "@/http";
import { openApiDocument } from "@/api/openapi";

export const dynamic = "force-static";
export const GET = () => json(openApiDocument(), 200, { "cache-control": "public, max-age=300" });
