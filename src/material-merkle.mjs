import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { semanticBytes } from "@red-cup-engineering/relation-model-notation-runtime";
import { encodeRelationalValue } from "@red-cup-engineering/relation-model-notation-runtime/relational-value";
import { jsonId } from "./semantic-identity.mjs";

export const MATERIAL_PROFILE = "org.emsenn.infomaterial.merkle.v2";
const byteOrder = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

function materialObjectKind(value) {
  if (value?.type === "InfomaterialPatchObservation") return "lenticule.infomaterial.patch-observation";
  const kinds = new Set(["file", "symbolic-link", "directory", "occurrence"]);
  if (kinds.has(value?.kind)) return `lenticule.infomaterial.${value.kind}-node`;
  throw new TypeError("infomaterial value lacks an admitted semantic object kind");
}
function typed(value) {
  const encoded = encodeRelationalValue(value);
  const term = ["ascribe", encoded.type, encoded.term];
  return { id: jsonId(term, materialObjectKind(value)), bytes: semanticBytes(term) };
}
function fileByteCommitmentId(digest) {
  return jsonId({ algorithm: "sha-256", digestBase64url: digest.toString("base64url") }, "lenticule.infomaterial.external-file-byte-commitment");
}
function regularFileNodeFromDigest(digest, size, mode) {
  return { profile: MATERIAL_PROFILE, kind: "file", mode, size, content: fileByteCommitmentId(digest) };
}

export function regularFileMaterial(bytes, mode) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError("regular file material bytes must be a byte sequence");
  if (typeof mode !== "bigint" || mode < 0n) throw new TypeError("regular file material mode must be a nonnegative bigint");
  const body = Buffer.from(bytes);
  const node = regularFileNodeFromDigest(createHash("sha256").update(body).digest(), BigInt(body.length), mode);
  return Object.freeze({ node, materialRoot: typed(node).id });
}
function increment(map, key, amount = 1n) { map.set(key, (map.get(key) ?? 0n) + amount); }
function suffix(name) {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "[none]";
  const value = name.slice(index + 1).normalize("NFC").toLowerCase();
  return Buffer.byteLength(value, "utf8") <= 64 ? value : "[none]";
}
function snapshot(stat) { return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }; }
function sameSnapshot(left, right) { return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every((key) => left[key] === right[key]); }
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest();
}

export async function observeInfomaterial(root, { maximumEntries = 1_000_000, maximumBytes = 100_000_000_000n, onOccurrence, onFile } = {}) {
  root = resolve(root);
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new TypeError("maximumEntries must be a positive safe integer");
  if (typeof maximumBytes !== "bigint" || maximumBytes < 0n) throw new TypeError("maximumBytes must be a nonnegative bigint");
  if (onOccurrence !== undefined && typeof onOccurrence !== "function") throw new TypeError("onOccurrence must be a function when supplied");
  if (onFile !== undefined && typeof onFile !== "function") throw new TypeError("onFile must be a function when supplied");
  const initialRoot = await lstat(root, { bigint: true });
  if (!initialRoot.isFile() && !initialRoot.isDirectory() && !initialRoot.isSymbolicLink()) throw new Error("patch root must be a regular file, symbolic link, or directory");
  const counts = new Map(), bytesBySuffix = new Map(), filesBySuffix = new Map();
  let entries = 0, regularFileBytes = 0n;
  async function emit(relativePath, parentPath, node, material, analysis = null) {
    if (!onOccurrence) return;
    const occurrence = typed({ profile: MATERIAL_PROFILE, kind: "occurrence", path: relativePath, material: material.id });
    await onOccurrence({ path: relativePath, parentPath, occurrence: occurrence.id, material: material.id, node, analysis });
  }
  async function visit(path, name, isRoot = false, relativePath = ".", parentPath = null) {
    entries += 1;
    if (entries > maximumEntries) throw new Error(`entry ceiling exceeded at ${path}`);
    const beforeStat = await lstat(path, { bigint: true }), before = snapshot(beforeStat);
    if (beforeStat.isFile()) {
      regularFileBytes += beforeStat.size;
      if (regularFileBytes > maximumBytes) throw new Error(`byte ceiling exceeded at ${path}`);
      const digest = await hashFile(path);
      const analysis = onFile ? await onFile({ absolutePath: path, path: relativePath, size: beforeStat.size }) : null;
      const after = snapshot(await lstat(path, { bigint: true }));
      if (!sameSnapshot(before, after)) throw new Error(`concurrent mutation observed at ${path}`);
      increment(counts, "file"); increment(filesBySuffix, suffix(name)); increment(bytesBySuffix, suffix(name), beforeStat.size);
      const node = regularFileNodeFromDigest(digest, beforeStat.size, beforeStat.mode);
      const material = { name: name.normalize("NFC"), kind: node.kind, id: typed(node).id };
      await emit(relativePath, parentPath, node, material, analysis);
      return material;
    }
    if (beforeStat.isSymbolicLink()) {
      const target = (await readlink(path)).normalize("NFC"), after = snapshot(await lstat(path, { bigint: true }));
      if (!sameSnapshot(before, after)) throw new Error(`concurrent mutation observed at ${path}`);
      increment(counts, "symbolic-link");
      const node = { profile: MATERIAL_PROFILE, kind: "symbolic-link", mode: beforeStat.mode, target };
      const material = { name: name.normalize("NFC"), kind: node.kind, id: typed(node).id };
      await emit(relativePath, parentPath, node, material);
      return material;
    }
    if (beforeStat.isDirectory()) {
      const names = [];
      for await (const entry of await opendir(path)) names.push(entry.name.normalize("NFC"));
      names.sort(byteOrder);
      if (new Set(names).size !== names.length) throw new Error(`directory names collide after NFC normalization at ${path}`);
      const children = [];
      for (const child of names) {
        const childPath = isRoot ? child : `${relativePath}/${child}`;
        children.push(await visit(resolve(path, child), child, false, childPath, relativePath));
      }
      const afterNames = [];
      for await (const entry of await opendir(path)) afterNames.push(entry.name.normalize("NFC"));
      afterNames.sort(byteOrder);
      const after = snapshot(await lstat(path, { bigint: true }));
      if (!sameSnapshot(before, after) || names.join("\u0000") !== afterNames.join("\u0000")) throw new Error(`concurrent mutation observed at ${path}`);
      increment(counts, "directory");
      const node = { profile: MATERIAL_PROFILE, kind: "directory", mode: beforeStat.mode, children };
      const material = { name: isRoot ? "." : name.normalize("NFC"), kind: node.kind, id: typed(node).id };
      await emit(relativePath, parentPath, node, material);
      return material;
    }
    throw new Error(`unsupported filesystem material at ${path}`);
  }
  const material = await visit(root, basename(root), true);
  const finalRoot = snapshot(await lstat(root, { bigint: true }));
  if (!sameSnapshot(snapshot(initialRoot), finalRoot)) throw new Error("territory root changed during observation");
  const observation = {
    type: "InfomaterialPatchObservation",
    profile: MATERIAL_PROFILE,
    materialRoot: material.id,
    rootKind: material.kind,
    patchComplete: true,
    globalInstantClaimed: false,
    territorialCoverClaimed: false,
    traversal: "all-patch-directory-entries-no-symlink-following",
    entries,
    regularFileBytes,
    counts: Object.fromEntries([...counts].sort(([a], [b]) => byteOrder(a, b))),
    filesBySuffix: Object.fromEntries([...filesBySuffix].sort(([a], [b]) => byteOrder(a, b))),
    bytesBySuffix: Object.fromEntries([...bytesBySuffix].sort(([a], [b]) => byteOrder(a, b))),
  };
  const document = typed(observation);
  return { observation, semanticId: document.id, canonicalBytes: document.bytes };
}
