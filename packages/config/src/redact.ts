/**
 * Secret redaction for anything that is logged or persisted (error messages, job errors).
 *
 * RPC client errors embed the request URL, and provider URLs carry API keys in their path
 * (e.g. Alchemy's /v2/<key>), so every URL is cut back to scheme + host. Secret values loaded
 * from the environment are additionally masked wherever they appear.
 */
const secrets = new Set<string>();

/** Env keys whose values are secret, or contain a secret (RPC URLs, DB credentials). */
export const SECRET_ENV_KEYS = [
  "ALCHEMY_API_KEY",
  "ARC_RPC_URL",
  "BASE_RPC_URL",
  "TESTNET_ARC_RPC_URL",
  "TESTNET_BASE_RPC_URL",
  "DATABASE_URL",
  "WEBHOOK_SECRET",
  "API_KEYS",
  "EVIDENCE_SIGNING_KEY",
  "ANCHOR_PRIVATE_KEY",
] as const;

export function registerSecret(value: string | undefined | null): void {
  if (!value || value.length < 8) return;
  secrets.add(value);
  if (value.startsWith("0x")) secrets.add(value.slice(2));
  for (const part of value.split(",")) if (part.trim().length >= 8) secrets.add(part.trim());
  try {
    const u = new URL(value);
    for (const seg of u.pathname.split("/")) if (seg.length >= 16) secrets.add(seg);
    if (u.password) secrets.add(u.password);
  } catch {
    /* not a URL */
  }
}

export function registerSecretsFromEnv(env: Record<string, string | undefined>): void {
  for (const k of SECRET_ENV_KEYS) registerSecret(env[k]);
}

const URL_RE = /\b(https?|wss?|postgres(?:ql)?):\/\/([^\s/'"`<>]+)([^\s'"`<>]*)/gi;

export function redact(text: string): string {
  let out = text.replace(URL_RE, (_m, scheme: string, authority: string, rest: string) => {
    const host = authority.includes("@")
      ? authority.slice(authority.lastIndexOf("@") + 1)
      : authority;
    return `${scheme}://${host}${rest ? "/<redacted>" : ""}`;
  });
  // Longest first, so a secret that contains another is masked whole.
  for (const s of [...secrets].sort((a, b) => b.length - a.length))
    out = out.split(s).join("<secret>");
  return out;
}

/** `Name: message` of an error, redacted. Use for every logged or stored error. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redact(raw);
}

/** Test hook. */
export const clearRegisteredSecrets = () => secrets.clear();
