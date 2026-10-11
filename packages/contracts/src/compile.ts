import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import solc from "solc";
import type { Abi, Hex } from "viem";

/**
 * Compiles the registry with the solc npm package (pure JS/wasm: no Foundry or native binary).
 * Settings are pinned so the committed artifact is reproducible; test/artifact.test.ts recompiles
 * and compares.
 */
export const COMPILER_SETTINGS = {
  // Arc targets the Osaka EVM baseline, a superset of Prague; Prague keeps the bytecode
  // deployable on every EVM chain this project might touch.
  evmVersion: "prague",
  optimizer: { enabled: true, runs: 200 },
  metadata: { bytecodeHash: "none" },
} as const;

export interface Artifact {
  contractName: "EvidenceRegistry";
  compiler: string;
  settings: typeof COMPILER_SETTINGS;
  sourceSha256: string;
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
}

export const SOURCE_PATH = fileURLToPath(new URL("./EvidenceRegistry.sol", import.meta.url));

export function compileRegistry(source = readFileSync(SOURCE_PATH, "utf8")): Artifact {
  const input = {
    language: "Solidity",
    sources: { "EvidenceRegistry.sol": { content: source } },
    settings: {
      ...COMPILER_SETTINGS,
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<
      string,
      Record<
        string,
        { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }
      >
    >;
  };
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = output.contracts["EvidenceRegistry.sol"]!["EvidenceRegistry"]!;
  return {
    contractName: "EvidenceRegistry",
    compiler: `solc-js ${solc.version()}`,
    settings: COMPILER_SETTINGS,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    abi: c.abi,
    bytecode: `0x${c.evm.bytecode.object}`,
    deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
  };
}
