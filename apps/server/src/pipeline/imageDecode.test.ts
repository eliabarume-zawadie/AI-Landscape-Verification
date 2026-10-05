import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { assessQuality } from "../domain/quality";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR, REPO_ROOT } from "../test/helpers";
import { hasHeifBrand, ImageDecodeError, openImage } from "./imageDecode";
import { analyzeImageBytes } from "./imageMetrics";

const LIMIT = { maxInputPixels: 50_000_000 };
const quality = loadVerificationConfigFromDir(CONFIG_DIR).thresholds.quality;

const ftyp = (brand: string) => Uint8Array.from([0, 0, 0, 24, ...Buffer.from("ftyp"), ...Buffer.from(brand), 0, 0, 0, 0]);

describe("hasHeifBrand", () => {
  it("recognises HEIC/HEIF brands in the ftyp box", () => {
    for (const b of ["heic", "heix", "mif1", "msf1", "hevc"]) expect(hasHeifBrand(ftyp(b)), b).toBe(true);
  });
  it("rejects other files", () => {
    expect(hasHeifBrand(ftyp("isom"))).toBe(false); // MP4
    expect(hasHeifBrand(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false); // JPEG
    expect(hasHeifBrand(new Uint8Array(4))).toBe(false);
  });
});

describe("openImage", () => {
  it("uses sharp for ordinary formats", async () => {
    const jpg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3a7" } }).jpeg().toBuffer();
    const o = await openImage(jpg, LIMIT);
    expect(o).toMatchObject({ format: "jpeg", width: 64, height: 48, decoder: "sharp" });
  });

  it("decodes AV1-compressed HEIF (AVIF) natively with sharp", async () => {
    const avif = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3a7" } }).avif().toBuffer();
    const o = await openImage(avif, LIMIT);
    expect(o).toMatchObject({ format: "heif", decoder: "sharp" });
    expect((await o.image().raw().toBuffer({ resolveWithObject: true })).info.width).toBe(64);
  });

  it("throws ImageDecodeError for garbage", async () => {
    await expect(openImage(Buffer.from("nope"), LIMIT)).rejects.toBeInstanceOf(ImageDecodeError);
  });
});

// Real iPhone-style HEVC HEIC. The sample is not committed (third-party licence):
// run `npx tsx apps/server/src/scripts/fetchHeicFixture.ts` to enable these tests.
const HEIC = path.join(REPO_ROOT, "fixtures", "heic", "sample.heic");
describe.runIf(existsSync(HEIC))("HEVC HEIC photos (real file)", () => {
  const bytes = existsSync(HEIC) ? readFileSync(HEIC) : Buffer.alloc(0);

  it("cannot be decoded by sharp alone (why the fallback exists)", async () => {
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: "heif", compression: "hevc" });
    await expect(sharp(bytes).raw().toBuffer()).rejects.toThrow();
  });

  it("decodes via libheif and passes quality analysis", async () => {
    const o = await openImage(bytes, LIMIT);
    expect(o).toMatchObject({ format: "heif", decoder: "libheif", width: 1440, height: 960 });

    const { metrics, fingerprints } = await analyzeImageBytes(bytes, LIMIT);
    expect(metrics).toMatchObject({ decodable: true, format: "heif", decoder: "libheif" });
    expect(fingerprints.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(assessQuality(metrics, quality)).toMatchObject({ usable: true, issues: [] });
  });

  it("enforces the pixel limit before decoding", async () => {
    await expect(openImage(bytes, { maxInputPixels: 1000 })).rejects.toThrow(/pixel limit/);
  });

  it("can be converted to JPEG for viewing", async () => {
    const jpg = await (await openImage(bytes, LIMIT)).image().jpeg().toBuffer();
    expect((await sharp(jpg).metadata()).format).toBe("jpeg");
  });
});
