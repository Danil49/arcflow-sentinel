import { getContext } from "@/context";
import { handle } from "@/http";
import { postWebhookTest } from "@/api/webhooks";

export const dynamic = "force-dynamic";
export const POST = handle((req: Request) => postWebhookTest(getContext(), req));
