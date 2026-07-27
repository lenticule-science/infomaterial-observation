import { readFileSync } from "node:fs";
import { compileRmlLaw } from "@red-cup-engineering/rmn-semantic-conformance/law";

export const INFOMATERIAL_OBSERVATION_LAW = compileRmlLaw(
  readFileSync(new URL("../content/contracts/finite-infomaterial-observation.rml", import.meta.url), "utf8"),
);
