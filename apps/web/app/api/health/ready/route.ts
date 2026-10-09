import { getContext } from "@/context";
import { getReady } from "@/api/health";

export const dynamic = "force-dynamic";
export const GET = () => getReady(getContext());
