import { checkTerm, decodeSemantic, semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { decodeRelationalValue } from "@red-cup-engineering/rmn-semantic-conformance/relational-value";
import { MATERIAL_PROFILE } from "./material-merkle.mjs";

const NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u;
function sameScalar(left, right) { return String(left) === String(right); }

export function validateInfomaterialObservationReceipt(receipt) {
  if (receipt?.type !== "InfomaterialPatchObservation" || receipt.profile !== MATERIAL_PROFILE || receipt.patchComplete !== true) throw new Error("canonical finite patch observation receipt required");
  if (!NI.test(receipt.semanticId ?? "") || !NI.test(receipt.materialRoot ?? "")) throw new Error("patch receipt lacks exact ni identities");
  if (receipt.globalInstantClaimed !== false || receipt.territorialCoverClaimed !== false) throw new Error("patch receipt overclaims global time or territorial cover");
  if (!["file", "directory", "symbolic-link"].includes(receipt.rootKind)) throw new Error("patch receipt lacks an exact root kind");
  if (typeof receipt.canonicalBytesBase64 !== "string") throw new Error("patch receipt lacks canonical RMN bytes");
  const bytes = Buffer.from(receipt.canonicalBytesBase64, "base64");
  if (bytes.toString("base64") !== receipt.canonicalBytesBase64) throw new Error("patch receipt RMN bytes are not canonical base64");
  const term = decodeSemantic(bytes);
  if (term?.[0] !== "ascribe" || term.length !== 3) throw new Error("patch receipt RMN object is not ascribed");
  checkTerm(term[2], term[1]);
  if (semanticId(term) !== receipt.semanticId) throw new Error("patch receipt semantic identity does not match its canonical bytes");
  const value = decodeRelationalValue(term[1], term[2]);
  for (const field of ["type", "profile", "materialRoot", "rootKind", "entries", "regularFileBytes", "patchComplete", "globalInstantClaimed", "territorialCoverClaimed"]) if (!sameScalar(value[field], receipt[field])) throw new Error(`patch receipt field ${field} differs from its canonical RMN object`);
  return receipt;
}
