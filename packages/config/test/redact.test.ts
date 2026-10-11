import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegisteredSecrets,
  errorText,
  parseEnv,
  pipelineEnvSchema,
  redact,
  registerSecret,
} from "../src/index.js";

afterEach(() => clearRegisteredSecrets());

describe("redact", () => {
  it("cuts URLs back to scheme + host (API keys live in RPC paths)", () => {
    const viemError =
      'HTTP request failed.\nURL: https://arc-mainnet.g.alchemy.com/v2/AbCdEf0123456789xyz\nRequest body: {"method":"eth_getLogs"}';
    expect(redact(viemError)).toBe(
      'HTTP request failed.\nURL: https://arc-mainnet.g.alchemy.com/<redacted>\nRequest body: {"method":"eth_getLogs"}',
    );
    expect(redact("postgres://user:pw@db.internal:5432/sentinel")).toBe(
      "postgres://db.internal:5432/<redacted>",
    );
    expect(redact("see https://basescan.org")).toBe("see https://basescan.org");
  });

  it("masks registered secret values anywhere, including hex keys with or without 0x", () => {
    const key = "0x" + "ab".repeat(32);
    registerSecret(key);
    expect(redact(`signing with ${key} and ${key.slice(2)}`)).toBe(
      "signing with <secret> and <secret>",
    );
  });

  it("parseEnv registers secrets from the environment automatically", () => {
    parseEnv(pipelineEnvSchema, {
      DATABASE_URL: "postgres://u:p@h/db",
      API_KEYS: "k".repeat(24) + ",second-key-0123456789abcdef",
      ANCHOR_PRIVATE_KEY: "cd".repeat(32),
      ARC_RPC_URL: "https://rpc.example.com/v2/supersecretpathkey123",
    });
    expect(redact(`tokens ${"k".repeat(24)} second-key-0123456789abcdef ${"cd".repeat(32)}`)).toBe(
      "tokens <secret> <secret> <secret>",
    );
    expect(redact("key supersecretpathkey123 leaked")).toBe("key <secret> leaked");
  });

  it("errorText formats and redacts", () => {
    expect(errorText(new TypeError("fetch https://x.io/v2/abc failed"))).toBe(
      "TypeError: fetch https://x.io/<redacted> failed",
    );
    expect(errorText("plain")).toBe("plain");
  });
});
