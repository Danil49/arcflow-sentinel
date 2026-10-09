import { getContext } from "@/context";
import { handle } from "@/http";
import { getTracesBySource, postTraces } from "@/api/traces";

export const dynamic = "force-dynamic";
export const POST = handle((req: Request) => postTraces(getContext(), req));
export const GET = handle((req: Request) => getTracesBySource(getContext(), req));
