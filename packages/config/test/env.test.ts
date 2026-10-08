import { describe, expect, it } from "vitest";
import { chainEnvSchema, EnvError, parseEnv } from "../src/index.js";

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
