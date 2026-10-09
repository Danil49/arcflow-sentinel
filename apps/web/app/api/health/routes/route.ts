import { getContext } from "@/context";
import { handle } from "@/http";
import { getRoutes } from "@/api/health";

export const dynamic = "force-dynamic";
export const GET = handle(() => getRoutes(getContext()));
