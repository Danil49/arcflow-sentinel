import { getContext } from "@/context";
import { handle } from "@/http";
import { getPublicKey } from "@/api/evidence";

export const dynamic = "force-dynamic";
export const GET = handle(() => getPublicKey(getContext()));
