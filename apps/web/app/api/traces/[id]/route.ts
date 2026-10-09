import { getContext } from "@/context";
import { handle } from "@/http";
import { getTraceById } from "@/api/traces";

type Params = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const GET = handle(async (_req: Request, { params }: Params) =>
  getTraceById(getContext(), (await params).id),
);
