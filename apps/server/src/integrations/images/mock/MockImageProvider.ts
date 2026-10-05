import sharp from "sharp";
import { MOCK_IMAGE_LOCATOR_PREFIX } from "../../netsuite/mock/MockNetSuiteAdapter";
import { MOCK_SCENARIOS, type MockImageSpec, type MockScenario } from "../../netsuite/mock/scenarios";
import { ImageFetchError, type FetchedImage, type ImageProvider } from "../ImageProvider";

/** Rendering is deterministic, so results are cached (bounded) across provider instances. */
const RENDER_CACHE = new Map<string, FetchedImage>();
const RENDER_CACHE_MAX = 400;

const WIDTH = 800;
const HEIGHT = 600;

/**
 * Renders deterministic synthetic landscape photos for mock scenarios so that
 * quality analysis and duplicate detection run on real pixels.
 *
 *  - Same scene  → same layout (horizon, path, shrubs, building), seeded by scene name.
 *  - Each photo  → its own camera offset/zoom and noise, seeded by image ref.
 *  - before      → darker, rougher "tall grass"; after → lighter, mowing stripes.
 *  - nearDuplicateOf → re-render the source photo with a tiny brightness/noise change.
 *  - defects     → real blur / exposure / size / truncation / format / missing.
 */
export class MockImageProvider implements ImageProvider {
  readonly name = "mock-images";
  private readonly specs = new Map<string, { scenario: MockScenario; spec: MockImageSpec }>();

  constructor(scenarios: MockScenario[] = MOCK_SCENARIOS) {
    for (const scenario of scenarios) {
      for (const spec of [...scenario.images, ...(scenario.imagesAddedLater ?? [])]) {
        this.specs.set(`${MOCK_IMAGE_LOCATOR_PREFIX}${scenario.externalId}/${spec.ref}`, { scenario, spec });
      }
    }
  }

  async fetch(locator: string): Promise<FetchedImage> {
    const cached = RENDER_CACHE.get(locator);
    if (cached) return { ...cached, bytes: Buffer.from(cached.bytes) };
    const result = await this.render(locator);
    if (RENDER_CACHE.size >= RENDER_CACHE_MAX) RENDER_CACHE.delete(RENDER_CACHE.keys().next().value!);
    RENDER_CACHE.set(locator, result);
    return { ...result, bytes: Buffer.from(result.bytes) };
  }

  private async render(locator: string): Promise<FetchedImage> {
    const found = this.specs.get(locator);
    if (!found) throw new ImageFetchError(`Mock image not found: ${locator}`, "NOT_FOUND");
    const { scenario, spec } = found;
    const defects = new Set(spec.defects ?? []);
    if (defects.has("missing")) throw new ImageFetchError(`Mock image missing: ${spec.ref}`, "NOT_FOUND");

    const source = spec.nearDuplicateOf
      ? [...scenario.images, ...(scenario.imagesAddedLater ?? [])].find((s) => s.ref === spec.nearDuplicateOf) ?? spec
      : spec;
    const raw = renderRaw(scenario.externalId, source, spec.nearDuplicateOf ? spec.ref : null);

    let img = sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } });
    if (defects.has("blur")) img = img.blur(12);
    if (defects.has("dark")) img = img.linear(0.12, 0);
    if (defects.has("overexposed")) img = img.linear(1.6, 140);
    if (defects.has("tiny")) img = img.resize(200, 150);

    if (defects.has("unsupported_format")) {
      return { bytes: await img.tiff().toBuffer(), contentType: "image/tiff" };
    }
    let bytes = await img.jpeg({ quality: 88 }).toBuffer();
    if (defects.has("corrupt")) bytes = bytes.subarray(0, Math.floor(bytes.length * 0.4));
    return { bytes, contentType: "image/jpeg", metadata: spec.capturedAt ? { capturedAt: spec.capturedAt } : {} };
  }
}

// ------------------------------------------------------------------ rendering

function renderRaw(externalId: string, spec: MockImageSpec, perturbSeed: string | null): Buffer {
  const layout = mulberry32(hash(`${externalId}/${spec.scene}`));
  const horizon = 0.25 + layout() * 0.2;
  const pathSlope = (layout() - 0.5) * 1.6;
  const pathX = 0.2 + layout() * 0.6;
  const pathHalf = 0.04 + layout() * 0.04;
  const shrubs = Array.from({ length: 2 + Math.floor(layout() * 4) }, () => ({
    x: layout(),
    y: horizon + 0.05 + layout() * 0.15,
    r: 0.04 + layout() * 0.06,
  }));
  const building = { x0: layout() * 0.5, x1: 0, h: 0.08 + layout() * 0.12 };
  building.x1 = building.x0 + 0.2 + layout() * 0.3;
  const sky = [120 + layout() * 60, 160 + layout() * 50, 200 + layout() * 50];

  // Per-photo camera: different shots of the same scene are not duplicates.
  const cam = mulberry32(hash(`${externalId}/${spec.ref}/camera`));
  const dx = (cam() - 0.5) * 0.5;
  const dy = (cam() - 0.5) * 0.24;
  const zoom = 0.75 + cam() * 0.5;

  const noise = mulberry32(hash(`${externalId}/${perturbSeed ?? spec.ref}/noise`));
  const brighten = perturbSeed ? 1 + (mulberry32(hash(perturbSeed))() - 0.5) * 0.03 : 1;

  const before = spec.stage === "before";
  const unrelated = spec.stage === "unrelated";
  const buf = Buffer.alloc(WIDTH * HEIGHT * 3);

  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const u = (px / WIDTH - 0.5) / zoom + 0.5 + dx;
      const v = (py / HEIGHT - 0.5) / zoom + 0.5 + dy;
      let r: number, g: number, b: number, amp: number;

      if (unrelated) {
        [r, g, b, amp] = v < horizon ? [sky[0]!, sky[1]!, sky[2]!, 10] : [105, 105, 110, 22];
      } else if (v < horizon) {
        const inBuilding = u > building.x0 && u < building.x1 && v > horizon - building.h;
        [r, g, b, amp] = inBuilding ? [150, 110, 90, 18] : [sky[0]!, sky[1]!, sky[2]!, 10];
      } else if (Math.abs(u - (pathX + pathSlope * (v - horizon))) < pathHalf) {
        [r, g, b, amp] = [170, 165, 155, 16];
      } else if (shrubs.some((s) => (u - s.x) ** 2 + ((v - s.y) * 1.3) ** 2 < s.r ** 2)) {
        [r, g, b, amp] = before ? [35, 70, 30, 40] : [45, 95, 40, 26];
      } else if (before) {
        [r, g, b, amp] = [70, 110, 45, 46]; // tall, uneven grass
      } else {
        const stripe = Math.floor((u + v * 0.3) * 14) % 2 === 0 ? 16 : -6; // mowing stripes
        [r, g, b, amp] = [95 + stripe, 160 + stripe, 70 + stripe / 2, 18];
      }

      const n = (noise() - 0.5) * 2 * amp;
      const i = (py * WIDTH + px) * 3;
      buf[i] = clamp255((r + n) * brighten);
      buf[i + 1] = clamp255((g + n) * brighten);
      buf[i + 2] = clamp255((b + n) * brighten);
    }
  }
  return buf;
}

const clamp255 = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
