import {
  EMPTY_WITNESS_ROOT,
  identifyJsonSemanticContent,
} from "@red-cup-engineering/semantic-content-identify-service";

function requiredObjectKind(objectKind) {
  if (typeof objectKind !== "string" || objectKind.length === 0) throw new TypeError("semantic object kind is required");
  return objectKind;
}

export function jsonId(value, objectKind) {
  return identifyJsonSemanticContent({
    objectKind: requiredObjectKind(objectKind),
    value,
    witnessRoot: EMPTY_WITNESS_ROOT,
  }).token;
}

export function byteCarrierId(bytes, objectKind, mediaType = "application/octet-stream") {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("byte carrier identity requires a byte sequence");
  return jsonId({ mediaType, bytesBase64: Buffer.from(bytes).toString("base64") }, objectKind);
}
