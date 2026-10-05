// Dev tool: render mock scenarios and print quality + duplicate results.
// Usage: npx tsx apps/server/src/scripts/calibrateMockImages.ts NS-DEMO-001 NS-DEMO-005 ...
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { dedupe, hammingHex64, meanAbsDiff } from "../domain/dedup";
import { assessQuality } from "../domain/quality";
import { MockImageProvider } from "../integrations/images/mock/MockImageProvider";
import { ImageFetchError } from "../integrations/images/ImageProvider";
import { MOCK_SCENARIOS } from "../integrations/netsuite/mock/scenarios";
import { analyzeImageBytes } from "../pipeline/imageMetrics";
import { CONFIG_DIR } from "../test/helpers";

const { thresholds } = loadVerificationConfigFromDir(CONFIG_DIR);
const provider = new MockImageProvider();
const ids = process.argv.slice(2);

for (const s of MOCK_SCENARIOS.filter((x) => ids.length === 0 || ids.includes(x.externalId))) {
  console.log(`\n=== ${s.externalId} — ${s.title}`);
  const analyzed = [];
  for (const spec of s.images) {
    try {
      const f = await provider.fetch(`mock://${s.externalId}/${spec.ref}`);
      const a = await analyzeImageBytes(f.bytes, { maxInputPixels: thresholds.quality.max_input_pixels });
      const q = assessQuality(a.metrics, thresholds.quality);
      analyzed.push({ spec, a, q });
      if (s.images.length <= 30 || analyzed.length <= 12) {
        console.log(
          `${spec.ref.padEnd(18)} ${spec.scene.padEnd(14)} ${spec.stage.padEnd(9)} lap=${String(a.metrics.laplacianVariance).padEnd(8)} mean=${String(a.metrics.meanLuminance).padEnd(7)} q=${q.score} usable=${q.usable} ${q.issues.join(",")}`,
        );
      }
    } catch (e) {
      if (e instanceof ImageFetchError) console.log(`${spec.ref} fetch error ${e.kind}`);
      else throw e;
    }
  }
  const d = dedupe(
    analyzed.map(({ spec, a, q }) => ({
      imageId: spec.ref,
      ordinal: spec.ordinal,
      sha256: a.fingerprints.sha256,
      dhash: a.fingerprints.dhash,
      fingerprint: a.fingerprints.fingerprint,
      usable: q.usable,
      qualityScore: q.score,
    })),
    thresholds.duplicates,
  );
  console.log(`unique=${d.uniqueCount} near=${d.nearDuplicates} exact=${d.exactDuplicates} of ${analyzed.length}`);

  // Closest same-scene pair that is NOT a duplicate — shows the safety margin.
  let closest = { mad: Infinity, ham: 0, pair: "" };
  for (let i = 0; i < analyzed.length; i++) {
    for (let j = i + 1; j < analyzed.length; j++) {
      const x = analyzed[i]!;
      const y = analyzed[j]!;
      if (x.spec.nearDuplicateOf || y.spec.nearDuplicateOf || !x.a.fingerprints.fingerprint || !y.a.fingerprints.fingerprint) continue;
      const mad = meanAbsDiff(x.a.fingerprints.fingerprint, y.a.fingerprints.fingerprint);
      if (mad < closest.mad) {
        closest = { mad, ham: hammingHex64(x.a.fingerprints.dhash!, y.a.fingerprints.dhash!), pair: `${x.spec.ref}(${x.spec.stage}) vs ${y.spec.ref}(${y.spec.stage})` };
      }
    }
  }
  if (closest.pair) console.log(`closest distinct pair: mad=${closest.mad.toFixed(1)} ham=${closest.ham} ${closest.pair}`);
}
