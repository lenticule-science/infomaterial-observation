import { createTopologyProjection } from "./topology-projection.mjs";
import { observeInfomaterial } from "./material-merkle.mjs";

export async function executeInfomaterialObservation({ patchRoot, maximumEntries, maximumBytes, observedAt, providerDataRoot, store }) {
  if (!store?.record) throw new Error("contracted witness-journal RDF store is required before observation");
  const started = process.hrtime.bigint();
  const topologyProjection = await createTopologyProjection({ observedRoot: patchRoot, providerDataRoot });
  let preparedTopology;
  try {
    const result = await observeInfomaterial(patchRoot, { maximumEntries, maximumBytes, onOccurrence: topologyProjection.record });
    preparedTopology = await topologyProjection.prepare({ graph: result.semanticId, expectedEntries: result.observation.entries });
    const topology = await preparedTopology.commit();
    const receipt = { ...result.observation, semanticId: result.semanticId, canonicalBytesBase64: result.canonicalBytes.toString("base64"), topologyProjection: topology, observedAt, patchRoot, globalInstantClaimed: false, territorialCoverClaimed: false, conductorClaimed: false, customerMutation: false, provider: "urn:ame:infomaterial-observation", elapsedNanoseconds: process.hrtime.bigint() - started };
    await store.record({ category: "infomaterial-patch-observation.receipt", recordedAt: observedAt, record: receipt });
    return { ...result, receipt };
  } catch (error) {
    await Promise.allSettled([preparedTopology?.rollback(), topologyProjection.abort()]);
    throw error;
  }
}
