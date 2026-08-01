#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { encodeRelationalValue } from "@red-cup-engineering/rmn-semantic-conformance/relational-value";
import { createSettlementStore } from "@lenticule-science/witness-journal-rdf-projection-service/client";
import { executeInfomaterialObservation } from "./execute-observation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACTOR = "urn:ame:infomaterial-observation";
const CONTEXT = "https://www.w3.org/ns/activitystreams";
function id(value) { const encoded = encodeRelationalValue(value); return semanticId(["ascribe", encoded.type, encoded.term]); }
function response(type, source, object, at) { const body = { "@context": CONTEXT, type, actor: ACTOR, target: source?.actor ?? null, inReplyTo: source?.id ?? null, object, published: at }; return { id: id(body), ...body }; }
function requestOf(activity) { return activity?.object?.request ?? activity?.object?.sourceActivity?.object; }
function validateRequest(request) {
  if (request?.type !== "FiniteInfomaterialPatchObservationRequest" || request.purpose !== "observe one finite informational material patch") throw new Error("exact finite infomaterial patch observation request required");
  if (!isAbsolute(request.patchRoot)) throw new Error("patchRoot must be absolute");
  if (!Number.isSafeInteger(request.maximumEntries) || request.maximumEntries < 1 || request.maximumEntries > 2_000_000) throw new Error("maximumEntries must be 1..2000000");
  if (typeof request.maximumBytes !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(request.maximumBytes) || BigInt(request.maximumBytes) > 200_000_000_000n) throw new Error("maximumBytes must be canonical decimal text no greater than 200000000000");
  for (const forbidden of ["exclude", "excludes", "ignore", "followSymlinks", "classifier", "cutPolicy", "command", "argv"]) if (Object.hasOwn(request, forbidden)) throw new Error(`caller-selected ${forbidden} is forbidden`);
  return request;
}
function validateCapability(capability, offer, customer, at) {
  if (capability?.type !== "InvocationCapability" || capability.issuer !== customer || capability.holder !== ACTOR || capability.invocationTarget !== ACTOR) throw new Error("exact invocation capability required");
  if (capability.parentOffer !== offer.id || capability.attenuation?.request !== offer.object.requestIdentity || capability.singleUse !== true || Date.parse(capability.expires) <= Date.parse(at)) throw new Error("capability is changed, reusable, or expired");
  if (!capability.allowedActions?.includes("observe-infomaterial") || capability.allowedActions.includes("mutate-territory")) throw new Error("capability effects are absent or overbroad");
}
async function handle(operation, activity, at) {
  if (operation === "solicit-service") {
    if (activity?.["@context"] !== CONTEXT || activity.type !== "Offer" || activity.target !== ACTOR || activity.object?.type !== "ServiceSolicitation") throw new Error("ActivityStreams Offer<ServiceSolicitation> targeted to this provider required");
    const request = validateRequest(requestOf(activity));
    return response("Offer", activity, { type: "ExecutableServiceOffer", request, requestIdentity: id(request), operation: "invoke-service", effects: ["observe-infomaterial", "write-provider-witness-journal"], customerMutation: false }, at);
  }
  if (operation !== "invoke-service" || activity?.["@context"] !== CONTEXT || activity.type !== "Accept" || activity.target !== ACTOR) throw new Error("ActivityStreams Accept<ServiceContract> targeted to this provider required");
  const offer = activity.object?.offer;
  if (offer?.type !== "Offer" || offer.actor !== ACTOR || offer.target !== activity.actor) throw new Error("exact provider offer required");
  const request = validateRequest(offer.object.request);
  if (offer.object.requestIdentity !== id(request)) throw new Error("request identity changed after offer");
  validateCapability(activity.object?.capability, offer, activity.actor, at);
  // Establish every provider-owned dependency before touching customer
  // territory.  A missing WitnessJournal seam must refuse immediately, not after an
  // expensive observation has already produced an unreceipted artifact.
  const store = createSettlementStore({ settlementRoot: ROOT, agentUrl: process.env.WITNESS_JOURNAL_RDF_AGENT });
  const result = await executeInfomaterialObservation({ patchRoot: request.patchRoot, maximumEntries: request.maximumEntries, maximumBytes: BigInt(request.maximumBytes), observedAt: at, providerDataRoot: join(ROOT, "data"), store });
  return response("Accept", activity, result.receipt, at);
}
async function input() { let source = ""; process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) source += chunk; return JSON.parse(source); }
const operationIndex = process.argv.indexOf("--operation"), operation = operationIndex < 0 ? "invoke-service" : process.argv[operationIndex + 1];
const nowIndex = process.argv.indexOf("--now"), at = nowIndex < 0 ? new Date().toISOString() : process.argv[nowIndex + 1];
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const activity = await input();
  try { process.stdout.write(`${JSON.stringify(await handle(operation, activity, at), (_, value) => typeof value === "bigint" ? value.toString() : value)}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(response("Reject", activity, { type: "InfomaterialPatchObservationRefusal", reason: error.message, partialSuccessClaimed: false, customerMutation: false }, at))}\n`); process.exitCode = 2; }
}
