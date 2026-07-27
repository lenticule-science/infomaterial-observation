import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { once } from "node:events";

const NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u;
const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";
const P = Object.freeze({
  path: "urn:emsenn:infomaterial:path",
  parent: "urn:emsenn:infomaterial:parent-occurrence",
  material: "urn:emsenn:infomaterial:material",
  profile: "urn:emsenn:infomaterial:profile",
  kind: "urn:emsenn:infomaterial:kind",
  mode: "urn:emsenn:infomaterial:mode",
  size: "urn:emsenn:infomaterial:size",
  content: "urn:emsenn:infomaterial:content",
  target: "urn:emsenn:infomaterial:symlink-target",
});

function literal(value) { return JSON.stringify(String(value).normalize("NFC")); }
function within(root, candidate) { const rel = relative(resolve(root), resolve(candidate)); return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\")); }
async function fileIdentity(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return `ni:///sha-256;${hash.digest("base64url")}`; }
function topologyLines(entries, graph) {
  const occurrences = new Map(entries.map((entry) => [entry.path, entry.occurrence]));
  const g = `<${graph}> .`, lines = new Set();
  for (const entry of entries) {
    lines.add(`<${entry.occurrence}> <${P.path}> ${entry.pathLiteral} ${g}`);
    lines.add(`<${entry.occurrence}> <${P.material}> <${entry.material}> ${g}`);
    if (entry.parentPath !== null) lines.add(`<${entry.occurrence}> <${P.parent}> <${occurrences.get(entry.parentPath)}> ${g}`);
    lines.add(`<${entry.material}> <${P.profile}> ${entry.profileLiteral} ${g}`);
    lines.add(`<${entry.material}> <${P.kind}> ${entry.kindLiteral} ${g}`);
    lines.add(`<${entry.material}> <${P.mode}> "${entry.mode}"^^<${XSD_INTEGER}> ${g}`);
    if (entry.size !== null) lines.add(`<${entry.material}> <${P.size}> "${entry.size}"^^<${XSD_INTEGER}> ${g}`);
    if (entry.content !== null) lines.add(`<${entry.material}> <${P.content}> <${entry.content}> ${g}`);
    if (entry.targetLiteral !== null) lines.add(`<${entry.material}> <${P.target}> ${entry.targetLiteral} ${g}`);
  }
  return [...lines].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export async function createTopologyProjection({ observedRoot, providerDataRoot }) {
  const scratchParent = join(resolve(providerDataRoot), ".scratch");
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(join(scratchParent, "infomaterial-topology-"));
  if (within(observedRoot, scratch)) {
    await rm(scratch, { recursive: true, force: true });
    throw new Error("complete topology projection requires scratch outside the observed territory");
  }
  const entries = [], paths = new Set();
  let closed = false;
  const record = async ({ path, parentPath, occurrence, material, node }) => {
    if (closed) throw new Error("topology projection is closed");
    if (paths.has(path)) throw new Error(`topology projection received duplicate path ${path}`);
    paths.add(path);
    entries.push({ path, pathLiteral: literal(path), parentPath: path === "." ? null : parentPath, occurrence, material,
      profileLiteral: literal(node.profile), kindLiteral: literal(node.kind), mode: String(node.mode),
      size: node.kind === "file" ? String(node.size) : null, content: node.kind === "file" ? node.content : null,
      targetLiteral: node.kind === "symbolic-link" ? literal(node.target) : null });
  };
  const abort = async () => {
    closed = true;
    await rm(scratch, { recursive: true, force: true });
  };
  const prepare = async ({ graph, expectedEntries }) => {
    if (closed) throw new Error("topology projection is closed");
    if (!NI.test(graph)) throw new Error("topology graph must be a SHA-256 ni URI");
    if (entries.length !== expectedEntries) throw new Error(`topology projection recorded ${entries.length} of ${expectedEntries} occurrences`);
    for (const entry of entries) if (entry.parentPath !== null && !paths.has(entry.parentPath)) throw new Error(`topology parent is absent: ${entry.parentPath}`);
    const output = join(scratch, "topology.nq"), stream = createWriteStream(output, { encoding: "utf8", mode: 0o444 }), hash = createHash("sha256");
    let statements = 0, bytes = 0;
    try {
      for (const line of topologyLines(entries, graph)) {
        const chunk = `${line}\n`; hash.update(chunk); bytes += Buffer.byteLength(chunk); statements += 1;
        if (!stream.write(chunk)) await once(stream, "drain");
      }
      stream.end(); await once(stream, "close");
    } catch (error) { stream.destroy(); throw error; }
    closed = true;
    const digest = hash.digest("base64url"), identity = `ni:///sha-256;${digest}`;
    const destination = join(resolve(providerDataRoot), "material-topology", "sha-256", digest.slice(0, 2), `${digest}.nq`);
    const artifact = { identity, mediaType: "application/n-quads", canonicalization: "RDF Dataset Canonicalization 1.0; no blank nodes", graph, statements, bytes, path: destination };
    let committed = false, created = false;
    const commit = async () => {
      if (committed) throw new Error("topology projection is already committed");
      await mkdir(dirname(destination), { recursive: true });
      try {
        const existing = await stat(destination);
        if (existing.size !== bytes || await fileIdentity(destination) !== identity) throw new Error("existing topology artifact does not match its content-addressed destination");
        await rm(output, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await rename(output, destination); created = true;
      }
      const written = await stat(destination);
      if (written.size !== bytes) throw new Error("topology projection byte count changed during placement");
      committed = true; await rm(scratch, { recursive: true, force: true }); return artifact;
    };
    const rollback = async () => { if (created) await rm(destination, { force: true }); await rm(scratch, { recursive: true, force: true }); };
    return { artifact, commit, rollback };
  };
  return { record, prepare, abort };
}
