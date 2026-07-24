import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

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
function lineUnion(graph) {
  const g = `<${graph}> .`;
  return `
    SELECT '<' || occurrence || '> <${P.path}> ' || path_literal || ' ${g}' AS line FROM entries
    UNION SELECT '<' || occurrence || '> <${P.material}> <' || material || '> ${g}' FROM entries
    UNION SELECT '<' || occurrence || '> <${P.parent}> <' || parent_occurrence || '> ${g}' FROM entries WHERE parent_occurrence IS NOT NULL
    UNION SELECT '<' || material || '> <${P.profile}> ' || profile_literal || ' ${g}' FROM entries
    UNION SELECT '<' || material || '> <${P.kind}> ' || kind_literal || ' ${g}' FROM entries
    UNION SELECT '<' || material || '> <${P.mode}> "' || mode || '"^^<${XSD_INTEGER}> ${g}' FROM entries
    UNION SELECT '<' || material || '> <${P.size}> "' || size || '"^^<${XSD_INTEGER}> ${g}' FROM entries WHERE size IS NOT NULL
    UNION SELECT '<' || material || '> <${P.content}> <' || content || '> ${g}' FROM entries WHERE content IS NOT NULL
    UNION SELECT '<' || material || '> <${P.target}> ' || target_literal || ' ${g}' FROM entries WHERE target_literal IS NOT NULL
  `;
}

export async function createTopologyProjection({ observedRoot, providerDataRoot }) {
  const scratchParent = join(resolve(providerDataRoot), ".scratch");
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(join(scratchParent, "infomaterial-topology-"));
  if (within(observedRoot, scratch)) {
    await rm(scratch, { recursive: true, force: true });
    throw new Error("complete topology projection requires scratch outside the observed territory");
  }
  const databasePath = join(scratch, "topology.sqlite"), database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; BEGIN IMMEDIATE; CREATE TABLE entries(path TEXT PRIMARY KEY COLLATE BINARY, path_literal TEXT NOT NULL, parent_path TEXT, occurrence TEXT NOT NULL, material TEXT NOT NULL, profile_literal TEXT NOT NULL, kind_literal TEXT NOT NULL, mode TEXT NOT NULL, size TEXT, content TEXT, target_literal TEXT);");
  const insert = database.prepare("INSERT INTO entries(path,path_literal,parent_path,occurrence,material,profile_literal,kind_literal,mode,size,content,target_literal) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  let rows = 0, closed = false;
  const record = async ({ path, parentPath, occurrence, material, node }) => {
    if (closed) throw new Error("topology projection is closed");
    insert.run(path, literal(path), parentPath, occurrence, material, literal(node.profile), literal(node.kind), String(node.mode), node.kind === "file" ? String(node.size) : null, node.kind === "file" ? node.content : null, node.kind === "symbolic-link" ? literal(node.target) : null);
    rows += 1;
  };
  const abort = async () => {
    if (!closed) { try { database.exec("ROLLBACK"); } catch {} database.close(); closed = true; }
    await rm(scratch, { recursive: true, force: true });
  };
  const prepare = async ({ graph, expectedEntries }) => {
    if (closed) throw new Error("topology projection is closed");
    if (!NI.test(graph)) throw new Error("topology graph must be a SHA-256 ni URI");
    if (rows !== expectedEntries) throw new Error(`topology projection recorded ${rows} of ${expectedEntries} occurrences`);
    database.exec("COMMIT");
    database.exec("UPDATE entries SET parent_path = NULL WHERE path = '.'; CREATE INDEX parent_path_idx ON entries(parent_path);");
    database.exec("ALTER TABLE entries ADD COLUMN parent_occurrence TEXT; UPDATE entries SET parent_occurrence = (SELECT p.occurrence FROM entries p WHERE p.path = entries.parent_path) WHERE parent_path IS NOT NULL;");
    const output = join(scratch, "topology.nq"), stream = createWriteStream(output, { encoding: "utf8", mode: 0o444 }), hash = createHash("sha256");
    let statements = 0, bytes = 0;
    try {
      const query = database.prepare(`SELECT line FROM (${lineUnion(graph)}) ORDER BY CAST(line AS BLOB)`);
      for (const { line } of query.iterate()) {
        const chunk = `${line}\n`; hash.update(chunk); bytes += Buffer.byteLength(chunk); statements += 1;
        if (!stream.write(chunk)) await once(stream, "drain");
      }
      stream.end(); await once(stream, "close");
    } catch (error) { stream.destroy(); throw error; }
    database.close(); closed = true;
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
