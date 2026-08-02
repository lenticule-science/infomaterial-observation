#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Message, Role } from "@a2a-js/sdk";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { createSettlementStore } from "@red-cup-engineering/witness-journal-rdf-projection-service/client";
import { decodeInfomaterialObservationTaskRequest } from "../src/client.mjs";
import { executeInfomaterialObservation } from "../src/execute-observation.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function boundedLocation(root, requested) { if (isAbsolute(requested) || requested.includes("\0")) throw new Error("relativePath must be relative to provider territory"); const location = resolve(root, requested), rel = relative(root, location); if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("relativePath escapes provider territory"); return location; }
const message = Message.fromJSON(JSON.parse(readFileSync(0, "utf8"))); if (message.role !== Role.ROLE_USER) throw new Error("infomaterial observation requires an A2A ROLE_USER message");
if (!process.env.INFOMATERIAL_TERRITORY_ROOT) throw new Error("INFOMATERIAL_TERRITORY_ROOT is required"); if (!process.env.WITNESS_JOURNAL_RDF_AGENT) throw new Error("WITNESS_JOURNAL_RDF_AGENT is required");
const request = decodeInfomaterialObservationTaskRequest(extractRmnPart(message.parts).bytes), observedAt = new Date().toISOString();
const store = createSettlementStore({ settlementRoot: ROOT, agentUrl: process.env.WITNESS_JOURNAL_RDF_AGENT });
const result = await executeInfomaterialObservation({ patchRoot: boundedLocation(resolve(process.env.INFOMATERIAL_TERRITORY_ROOT), request.relativePath), maximumEntries: request.maximumEntries, maximumBytes: BigInt(request.maximumBytes), observedAt, providerDataRoot: resolve(ROOT, "data"), store });
process.stdout.write(`${JSON.stringify(Message.toJSON({ messageId: randomUUID(), contextId: message.contextId, taskId: message.taskId, role: Role.ROLE_AGENT, parts: [rmnPart(result.canonicalBytes, "infomaterial-observation-receipt.rmn.cbor")], metadata: { disposition: "conformant", receiptNi: result.semanticId, materialRootNi: result.observation.materialRoot }, extensions: [], referenceTaskIds: [] }))}\n`);
