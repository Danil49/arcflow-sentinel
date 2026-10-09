import { getContext } from "@/context";
import { handle } from "@/http";
import { getEvents } from "@/api/traces";

type Params = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const GET = handle(async (_req: Request, { params }: Params) =>
  getEvents(getContext(), (await params).id),
);
