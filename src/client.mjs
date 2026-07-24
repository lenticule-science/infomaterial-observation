import { randomUUID } from "node:crypto";
import { Message, Role } from "@a2a-js/sdk";
import { a2aResultParts, sendRmnTask } from "@emsenn/a2a-rmn-task-client-service";
import { extractRmnPart, rmnPart } from "@emsenn/a2a-rmn-part-service";
import { checkTerm, decodeSemantic, semanticBytes, semanticId } from "@emsenn/rmn-semantic-conformance";
import { decodeRelationalValue, encodeRelationalValue, RELATIONAL_VALUE_TYPE } from "@emsenn/rmn-semantic-conformance/relational-value";
import { SOVEREIGN_CIRCUIT_INTERFACE_EXTENSION } from "@emsenn/rmn-semantic-conformance/hierarchical-circuit";
import { validateInfomaterialObservationReceipt } from "./receipt.mjs";

const responseParts = a2aResultParts;
export function encodeInfomaterialObservationTaskRequest({ relativePath, maximumEntries, maximumBytes }) {
  const value = { kind: "InfomaterialObservationTask", relativePath, maximumEntries, maximumBytes: String(maximumBytes) };
  const encoded = encodeRelationalValue(value); return ["ascribe", encoded.type, encoded.term];
}
export function decodeInfomaterialObservationTaskRequest(bytes) {
  const term = decodeSemantic(bytes);
  if (!semanticBytes(term).equals(bytes) || term?.[0] !== "ascribe" || term.length !== 3 || JSON.stringify(term[1]) !== JSON.stringify(RELATIONAL_VALUE_TYPE)) throw new Error("infomaterial observation task must be canonical relational RMN");
  checkTerm(term[2], term[1]); const value = decodeRelationalValue(term[1], term[2]);
  if (value?.kind !== "InfomaterialObservationTask" || Object.keys(value).sort().join("\0") !== "kind\0maximumBytes\0maximumEntries\0relativePath" || typeof value.relativePath !== "string" || !Number.isSafeInteger(value.maximumEntries) || value.maximumEntries < 1 || value.maximumEntries > 2_000_000 || typeof value.maximumBytes !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.maximumBytes) || BigInt(value.maximumBytes) > 200_000_000_000n) throw new Error("infomaterial observation task has an invalid shape");
  return value;
}
export async function requestInfomaterialObservation({ agentUrl, relativePath, maximumEntries = 1_000_000, maximumBytes = 100_000_000_000n, signal }) {
  const request = encodeInfomaterialObservationTaskRequest({ relativePath, maximumEntries, maximumBytes });
  const message = Message.toJSON({ messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER, parts: [rmnPart(semanticBytes(request), "infomaterial-observation-task.rmn.cbor")], metadata: {}, extensions: [], referenceTaskIds: [] });
  const exchange = await sendRmnTask({ agentUrl, extensions: [SOVEREIGN_CIRCUIT_INTERFACE_EXTENSION], message, ...(signal ? { signal } : {}) }); const output = extractRmnPart(responseParts(exchange.result));
  const term = decodeSemantic(output.bytes); if (!semanticBytes(term).equals(output.bytes) || term?.[0] !== "ascribe" || term.length !== 3) throw new Error("infomaterial provider returned noncanonical RMN");
  const value = decodeRelationalValue(term[1], term[2]); const receipt = { ...value, semanticId: semanticId(term), canonicalBytesBase64: output.bytes.toString("base64") };
  validateInfomaterialObservationReceipt(receipt); return { receipt, exchange };
}
