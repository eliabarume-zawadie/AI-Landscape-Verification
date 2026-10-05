// Dev tool: how often is the true same-scene after-photo within the top-K candidates?
// Usage: npx tsx apps/server/src/scripts/calibratePairing.ts NS-DEMO-016
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { pairCandidates, type PairableImage } from "../domain/pairing";
import { MockImageProvider } from "../integrations/images/mock/MockImageProvider";
import { MOCK_SCENARIOS } from "../integrations/netsuite/mock/scenarios";
import { analyzeImageBytes } from "../pipeline/imageMetrics";
import { CONFIG_DIR } from "../test/helpers";

const { thresholds } = loadVerificationConfigFromDir(CONFIG_DIR);
const provider = new MockImageProvider();
for (const s of MOCK_SCENARIOS.filter((x) => process.argv.slice(2).includes(x.externalId))) {
  const items: (PairableImage & { scene: string; stage: string })[] = [];
  for (const spec of s.images) {
    if (spec.defects?.length || spec.nearDuplicateOf) continue;
    const f = await provider.fetch(`mock://${s.externalId}/${spec.ref}`);
    const a = await analyzeImageBytes(f.bytes, { maxInputPixels: thresholds.quality.max_input_pixels });
    items.push({ imageId: spec.ref, ref: spec.ref, fingerprint: a.fingerprints.fingerprint, colorHist: a.fingerprints.colorHist, scene: spec.scene, stage: spec.stage });
  }
  const befores = items.filter((i) => i.stage === "before");
  const afters = items.filter((i) => i.stage === "after");
  for (const k of [1, 3, 5]) {
    const c = pairCandidates(befores, afters, { ...thresholds.pairing, max_full_pairs: 0, candidates_per_before: k });
    const sceneOf = new Map(items.map((i) => [i.imageId, i.scene]));
    const hit = befores.filter((b) => c.some((p) => p.beforeId === b.imageId && sceneOf.get(p.afterId) === b.scene)).length;
    console.log(`${s.externalId}: top-${k} recall ${hit}/${befores.length}`);
  }
}
