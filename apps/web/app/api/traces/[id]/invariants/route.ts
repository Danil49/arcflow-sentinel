import { getContext } from "@/context";
import { handle } from "@/http";
import { getInvariants } from "@/api/traces";

type Params = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const GET = handle(async (_req: Request, { params }: Params) =>
  getInvariants(getContext(), (await params).id),
);
