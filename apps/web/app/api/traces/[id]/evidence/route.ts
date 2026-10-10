import { getContext } from "@/context";
import { handle } from "@/http";
import { getEvidence } from "@/api/evidence";

type Params = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const GET = handle(async (req: Request, { params }: Params) =>
  getEvidence(getContext(), req, (await params).id),
);
