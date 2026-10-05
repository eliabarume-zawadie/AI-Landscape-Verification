import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { laplacianVarianceOf, analyzeImageBytes } from "./imageMetrics";

const W = 640;
const H = 480;
const LIMIT = { maxInputPixels: 50_000_000 };

/** Checkerboard-ish noisy image: lots of edges → sharp. */
function noisyRaw(seed = 1): Buffer {
  const buf = Buffer.alloc(W * H * 3);
  let s = seed;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = 80 + (s % 96);
  }
  return buf;
}
const raw = (b: Buffer) => sharp(b, { raw: { width: W, height: H, channels: 3 } });

describe("laplacianVarianceOf", () => {
  it("is zero for a flat image and high for edges", () => {
    expect(laplacianVarianceOf(new Uint8Array(100).fill(7), 10, 10)).toBe(0);
    const edges = Uint8Array.from({ length: 100 }, (_, i) => ((i + Math.floor(i / 10)) % 2 ? 255 : 0));
    expect(laplacianVarianceOf(edges, 10, 10)).toBeGreaterThan(10_000);
  });
});

describe("analyzeImageBytes", () => {
  it("measures a sharp JPEG", async () => {
    const bytes = await raw(noisyRaw()).jpeg().toBuffer();
    const { metrics, fingerprints } = await analyzeImageBytes(bytes, LIMIT);
    expect(metrics).toMatchObject({ present: true, decodable: true, format: "jpeg", width: W, height: H });
    expect(metrics.laplacianVariance).toBeGreaterThan(100);
    expect(fingerprints.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprints.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprints.fingerprint).toHaveLength(1024);
  });

  it("sees blur as a large drop in Laplacian variance", async () => {
    const sharpImg = await analyzeImageBytes(await raw(noisyRaw()).jpeg().toBuffer(), LIMIT);
    const blurred = await analyzeImageBytes(await raw(noisyRaw()).blur(10).jpeg().toBuffer(), LIMIT);
    expect(blurred.metrics.laplacianVariance!).toBeLessThan(sharpImg.metrics.laplacianVariance! / 20);
  });

  it("detects darkness via mean luminance", async () => {
    const dark = await analyzeImageBytes(await raw(noisyRaw()).linear(0.1, 0).jpeg().toBuffer(), LIMIT);
    expect(dark.metrics.meanLuminance!).toBeLessThan(20);
  });

  it("reports the decoded format (so unsupported ones can be rejected)", async () => {
    const tiff = await analyzeImageBytes(await raw(noisyRaw()).tiff().toBuffer(), LIMIT);
    expect(tiff.metrics.format).toBe("tiff");
    const png = await analyzeImageBytes(await raw(noisyRaw()).png().toBuffer(), LIMIT);
    expect(png.metrics.format).toBe("png");
  });

  it("marks truncated files as not decodable instead of throwing", async () => {
    const full = await raw(noisyRaw()).jpeg().toBuffer();
    const r = await analyzeImageBytes(full.subarray(0, full.length / 3), LIMIT);
    expect(r.metrics.decodable).toBe(false);
    expect(r.fingerprints.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.fingerprints.dhash).toBeNull();
  });

  it("marks random bytes as not decodable", async () => {
    const r = await analyzeImageBytes(Buffer.from("definitely not an image"), LIMIT);
    expect(r.metrics.decodable).toBe(false);
  });

  it("refuses images above the pixel limit (decompression-bomb guard)", async () => {
    const r = await analyzeImageBytes(await raw(noisyRaw()).jpeg().toBuffer(), { maxInputPixels: 1000 });
    expect(r.metrics.decodable).toBe(false);
  });

  it("reports oriented dimensions for EXIF-rotated photos", async () => {
    const rotated = await raw(noisyRaw()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await analyzeImageBytes(rotated, LIMIT);
    expect([r.metrics.width, r.metrics.height]).toEqual([H, W]);
  });

  it("gives identical fingerprints for identical bytes and close ones for a re-encode", async () => {
    const a = await raw(noisyRaw()).jpeg({ quality: 90 }).toBuffer();
    const b = await raw(noisyRaw()).jpeg({ quality: 70 }).toBuffer();
    const fa = (await analyzeImageBytes(a, LIMIT)).fingerprints;
    const fb = (await analyzeImageBytes(b, LIMIT)).fingerprints;
    expect(fa.sha256).not.toBe(fb.sha256);
    const mad = fa.fingerprint!.reduce((s, v, i) => s + Math.abs(v - fb.fingerprint![i]!), 0) / 1024;
    expect(mad).toBeLessThan(3);
  });
});
