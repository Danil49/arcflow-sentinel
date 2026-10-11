/** Writes artifacts/EvidenceRegistry.json. Run after editing the contract; commit the result. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileRegistry } from "../src/compile.js";

const artifact = compileRegistry();
const out = fileURLToPath(new URL("../artifacts/EvidenceRegistry.json", import.meta.url));
writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
console.log(
  `${artifact.compiler}: ${(artifact.deployedBytecode.length - 2) / 2} bytes runtime -> artifacts/EvidenceRegistry.json`,
);
