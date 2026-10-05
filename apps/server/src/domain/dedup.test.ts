import { describe, expect, it } from "vitest";
import { dedupe, hammingHex64, meanAbsDiff, type DedupInput } from "./dedup";

const t = { near_duplicate_hamming_max: 10, near_duplicate_mad_max: 6 };
const fp = (v: number) => new Uint8Array(1024).fill(v);

const img = (id: string, over: Partial<DedupInput> = {}): DedupInput => ({
  imageId: id,
  ordinal: Number(id.replace(/\D/g, "")) || 0,
  sha256: `sha-${id}`,
  dhash: "f0f0f0f0f0f0f0f0",
  fingerprint: fp(100),
  usable: true,
  qualityScore: 0.9,
  ...over,
});

describe("hash helpers", () => {
  it("computes 64-bit Hamming distance", () => {
    expect(hammingHex64("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingHex64("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingHex64("0000000000000001", "0000000000000003")).toBe(1);
  });
  it("computes mean absolute difference", () => {
    expect(meanAbsDiff(fp(10), fp(14))).toBe(4);
    expect(meanAbsDiff(fp(1), new Uint8Array(3))).toBe(Infinity);
  });
});

describe("dedupe (PRD §15)", () => {
  it("collapses 25 near-identical photos into one evidence cluster", () => {
    const inputs = Array.from({ length: 25 }, (_, i) => img(`i${i + 1}`, { fingerprint: fp(100 + (i % 3)) }));
    const r = dedupe(inputs, t);
    expect(r.uniqueCount).toBe(1);
    expect(r.nearDuplicates).toBe(24);
    expect([...r.results.values()].filter((x) => x.isRepresentative)).toHaveLength(1);
  });

  it("does NOT merge a before/after pair: same structure, different pixels", () => {
    const before = img("i1", { fingerprint: fp(80) });
    const after = img("i2", { fingerprint: fp(130) }); // same dHash, MAD 50
    const r = dedupe([before, after], t);
    expect(r.uniqueCount).toBe(2);
  });

  it("does NOT merge different scenes even if pixels are close on average", () => {
    const a = img("i1", { dhash: "0000000000000000" });
    const b = img("i2", { dhash: "ffffffff00000000" });
    expect(dedupe([a, b], t).uniqueCount).toBe(2);
  });

  it("detects exact duplicates by SHA-256", () => {
    const r = dedupe([img("i1", { sha256: "same" }), img("i2", { sha256: "same", dhash: null, fingerprint: null })], t);
    expect(r.exactDuplicates).toBe(1);
    expect(r.results.get("i2")).toMatchObject({ groupId: "i1", duplicateKind: "EXACT" });
  });

  it("picks the best usable image as representative", () => {
    const r = dedupe(
      [
        img("i1", { usable: false, qualityScore: 0.2 }),
        img("i2", { qualityScore: 0.7 }),
        img("i3", { qualityScore: 0.95 }),
      ],
      t,
    );
    expect(r.results.get("i3")!.isRepresentative).toBe(true);
    expect(r.results.get("i1")!.groupId).toBe("i3");
  });

  it("is transitive (A~B, B~C ⇒ one cluster)", () => {
    const r = dedupe([img("i1", { fingerprint: fp(100) }), img("i2", { fingerprint: fp(105) }), img("i3", { fingerprint: fp(110) })], t);
    expect(r.uniqueCount).toBe(1);
  });

  it("keeps missing images out of the unique count", () => {
    const r = dedupe([img("i1"), img("i2", { sha256: null, dhash: null, fingerprint: null, usable: false, qualityScore: 0 })], t);
    expect(r.uniqueCount).toBe(1);
    expect(r.results.get("i2")!.isRepresentative).toBe(true); // its own singleton
  });
});
