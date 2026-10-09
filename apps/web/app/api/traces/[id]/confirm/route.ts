import { getContext } from "@/context";
import { handle } from "@/http";
import { postConfirm } from "@/api/traces";

type Params = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export const POST = handle(async (req: Request, { params }: Params) =>
  postConfirm(getContext(), req, (await params).id),
);
