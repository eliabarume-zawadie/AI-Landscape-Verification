import { describe, expect, it } from "vitest";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR } from "../test/helpers";
import { assessQuality, type ImageMetrics } from "./quality";

const q = loadVerificationConfigFromDir(CONFIG_DIR).thresholds.quality;

const good: ImageMetrics = {
  present: true,
  decodable: true,
  format: "jpeg",
  width: 1024,
  height: 768,
  bytes: 200_000,
  meanLuminance: 120,
  laplacianVariance: 800,
  darkFraction: 0.01,
  brightFraction: 0.01,
};

describe("assessQuality (PRD §14)", () => {
  it("accepts a sharp, well-exposed image", () => {
    expect(assessQuality(good, q)).toEqual({ score: 1, usable: true, issues: [] });
  });

  it.each<[string, Partial<ImageMetrics>, string]>([
    ["missing", { present: false }, "MISSING"],
    ["corrupt", { decodable: false }, "CORRUPT"],
    ["unsupported format", { format: "tiff" }, "UNSUPPORTED_FORMAT"],
    ["too large", { bytes: q.max_image_bytes + 1 }, "TOO_LARGE"],
    ["too small", { width: 120, height: 90 }, "TOO_SMALL"],
    ["blurry", { laplacianVariance: 10 }, "BLURRY"],
    ["too dark", { meanLuminance: 12 }, "TOO_DARK"],
    ["overexposed", { meanLuminance: 245 }, "OVEREXPOSED"],
  ])("flags %s images as unusable", (_name, patch, issue) => {
    const r = assessQuality({ ...good, ...patch }, q);
    expect(r.usable).toBe(false);
    expect(r.issues).toContain(issue);
  });

  it("scores hard failures as zero", () => {
    expect(assessQuality({ ...good, decodable: false }, q).score).toBe(0);
  });

  it("ranks a borderline image below a clean one", () => {
    const borderline = assessQuality({ ...good, laplacianVariance: q.blur_laplacian_variance_min * 1.2 }, q);
    expect(borderline.usable).toBe(true);
    expect(borderline.score).toBeLessThan(1);
  });

  it("reports multiple issues together", () => {
    const r = assessQuality({ ...good, laplacianVariance: 5, meanLuminance: 10 }, q);
    expect(r.issues).toEqual(expect.arrayContaining(["BLURRY", "TOO_DARK"]));
  });
});
