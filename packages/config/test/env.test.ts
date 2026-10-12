import { describe, expect, it } from "vitest";
import { chainEnvSchema, EnvError, parseEnv, pipelineEnvSchema } from "../src/index.js";

describe("parseEnv", () => {
  it("applies defaults", () => {
    expect(parseEnv(chainEnvSchema, {})).toEqual({ CCTP_NETWORK: "mainnet" });
  });

  it("rejects bad values without echoing them", () => {
    expect(() => parseEnv(chainEnvSchema, { ARC_RPC_URL: "not-a-url-secret" })).toThrow(EnvError);
    try {
      parseEnv(chainEnvSchema, { ARC_RPC_URL: "not-a-url-secret" });
    } catch (e) {
      expect((e as Error).message).not.toContain("not-a-url-secret");
    }
  });
});

describe("pipelineEnvSchema", () => {
  const base = { DATABASE_URL: "postgres://x" };

  it("requires a strong secret when webhooks are configured", () => {
    expect(() =>
      parseEnv(pipelineEnvSchema, { ...base, WEBHOOK_URLS: "https://hooks.example.com/a" }),
    ).toThrow(/WEBHOOK_SECRET/);
    const env = parseEnv(pipelineEnvSchema, {
      ...base,
      WEBHOOK_URLS: "https://hooks.example.com/a, http://localhost:9000/b",
      WEBHOOK_SECRET: "x".repeat(32),
    });
    expect(env.WEBHOOK_URLS).toEqual(["https://hooks.example.com/a", "http://localhost:9000/b"]);
  });

  it("rejects plain-http webhook endpoints outside localhost", () => {
    expect(() =>
      parseEnv(pipelineEnvSchema, {
        ...base,
        WEBHOOK_URLS: "http://hooks.example.com",
        WEBHOOK_SECRET: "x".repeat(32),
      }),
    ).toThrow(/https/);
  });

  it("parses partial stage deadline overrides and rejects unknown keys", () => {
    const env = parseEnv(pipelineEnvSchema, {
      ...base,
      STAGE_DEADLINES_JSON: '{"mint":180,"finality":{"standard":60}}',
    });
    expect(env.STAGE_DEADLINES_JSON).toEqual({ mint: 180, finality: { standard: 60 } });
    expect(() =>
      parseEnv(pipelineEnvSchema, { ...base, STAGE_DEADLINES_JSON: '{"nope":1}' }),
    ).toThrow();
    expect(() => parseEnv(pipelineEnvSchema, { ...base, STAGE_DEADLINES_JSON: "{bad" })).toThrow(
      /JSON/,
    );
  });
});

describe("empty values", () => {
  it("treats NAME= (empty) as unset, so blanks copied from .env.example are valid", () => {
    const env = parseEnv(pipelineEnvSchema, {
      DATABASE_URL: "postgres://x",
      EVIDENCE_SIGNING_KEY: "",
      ANCHOR_PRIVATE_KEY: "",
      WEBHOOK_URLS: "",
      WEBHOOK_SECRET: "",
      ANCHOR_MODE: "",
      STAGE_DEADLINES_JSON: "",
    });
    expect(env).toMatchObject({
      WEBHOOK_URLS: [],
      ANCHOR_MODE: "manual",
      ANCHOR_NETWORK: "testnet",
    });
    expect(env.EVIDENCE_SIGNING_KEY).toBeUndefined();
    expect(() => parseEnv(pipelineEnvSchema, { DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });
});
