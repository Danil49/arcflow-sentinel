import { getContext } from "@/context";
import { handle } from "@/http";
import { postAnchor } from "@/api/evidence";

type Params = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const POST = handle(async (req: Request, { params }: Params) =>
  postAnchor(getContext(), req, (await params).id),
);
