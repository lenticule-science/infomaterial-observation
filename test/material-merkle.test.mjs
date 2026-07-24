import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeInfomaterial } from "../src/material-merkle.mjs";
import { createTopologyProjection } from "../src/topology-projection.mjs";

test("the complete material topology has one order-independent RMN identity", async () => {
  const left = await mkdtemp(join(tmpdir(), "infomaterial-left-")), right = await mkdtemp(join(tmpdir(), "infomaterial-right-"));
  await mkdir(join(left, "d")); await writeFile(join(left, "d", "b.txt"), "beta"); await writeFile(join(left, "a.txt"), "alpha"); await symlink("a.txt", join(left, "alias"));
  await symlink("a.txt", join(right, "alias")); await writeFile(join(right, "a.txt"), "alpha"); await mkdir(join(right, "d")); await writeFile(join(right, "d", "b.txt"), "beta");
  const a = await observeInfomaterial(left), b = await observeInfomaterial(right);
  assert.equal(a.observation.materialRoot, b.observation.materialRoot);
  assert.equal(a.semanticId, b.semanticId);
  assert.equal(a.observation.entries, 5);
  assert.equal(a.observation.regularFileBytes, 9n);
  assert.deepEqual(a.observation.counts, { directory: 2n, file: 2n, "symbolic-link": 1n });
});

test("one changed byte changes both material and observation identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "infomaterial-change-"));
  await writeFile(join(root, "x"), "one"); const before = await observeInfomaterial(root);
  await writeFile(join(root, "x"), "two"); const after = await observeInfomaterial(root);
  assert.notEqual(before.observation.materialRoot, after.observation.materialRoot);
  assert.notEqual(before.semanticId, after.semanticId);
});

test("resource ceilings refuse partial observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "infomaterial-limit-")); await writeFile(join(root, "x"), "1234");
  await assert.rejects(observeInfomaterial(root, { maximumEntries: 10, maximumBytes: 3n }), /byte ceiling exceeded/u);
});

test("the assay emits a complete canonical RDF topology for downstream circuit work", async () => {
  const root = await mkdtemp(join(tmpdir(), "infomaterial-topology-root-")), data = await mkdtemp(join(tmpdir(), "infomaterial-topology-data-"));
  await mkdir(join(root, "d")); await writeFile(join(root, "d", "b.txt"), "beta"); await writeFile(join(root, "a.txt"), "alpha"); await symlink("a.txt", join(root, "alias"));
  const projection = await createTopologyProjection({ observedRoot: root, providerDataRoot: data });
  const result = await observeInfomaterial(root, { onOccurrence: projection.record });
  const prepared = await projection.prepare({ graph: result.semanticId, expectedEntries: result.observation.entries });
  const artifact = await prepared.commit();
  const { readFile } = await import("node:fs/promises"), source = await readFile(artifact.path, "utf8"), lines = source.trimEnd().split("\n");
  assert.equal(artifact.mediaType, "application/n-quads");
  assert.ok(lines.length >= result.observation.entries * 3);
  assert.deepEqual(lines, [...lines].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.ok(lines.every((line) => line.endsWith(` <${result.semanticId}> .`) && !line.includes("_:")));
});

test("an optional occurrence measurement is bound to the same mutation-checked file", async () => {
  const root = await mkdtemp(join(tmpdir(), "infomaterial-analysis-root-"));
  await writeFile(join(root, "module.mjs"), 'import "./dependency.mjs";');
  await writeFile(join(root, "dependency.mjs"), "export const value = 1;");
  const occurrences = [];
  const result = await observeInfomaterial(root, {
    onFile: async ({ path, size }) => ({ analyzedPath: path, analyzedSize: size }),
    onOccurrence: async (occurrence) => occurrences.push(occurrence),
  });
  assert.equal(result.observation.entries, 3);
  assert.deepEqual(occurrences.filter(({ node }) => node.kind === "file").map(({ path, analysis }) => ({ path, analysis })), [
    { path: "dependency.mjs", analysis: { analyzedPath: "dependency.mjs", analyzedSize: 23n } },
    { path: "module.mjs", analysis: { analyzedPath: "module.mjs", analyzedSize: 26n } },
  ]);
});

test("one regular file is an independently observable material patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "infomaterial-file-patch-"));
  const path = join(root, "entry.mjs"); await writeFile(path, "export const value = 1;\n");
  const result = await observeInfomaterial(path);
  assert.equal(result.observation.type, "InfomaterialPatchObservation");
  assert.equal(result.observation.rootKind, "file");
  assert.equal(result.observation.patchComplete, true);
  assert.equal(result.observation.entries, 1);
  assert.equal(result.observation.counts.file, 1n);
  assert.equal(result.observation.globalInstantClaimed, false);
  assert.equal(result.observation.territorialCoverClaimed, false);
});
