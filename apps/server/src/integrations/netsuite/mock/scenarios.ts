/**
 * Mock work items for local development and the required demonstration cases
 * (master prompt §50). These are NOT real NetSuite records and do not imply any
 * NetSuite field structure.
 *
 * Each image carries a rendering spec. Phase 3's MockImageProvider turns specs into
 * real JPEG bytes (so quality/dedup run on actual pixels) and Phase 4's
 * MockVisionProvider uses `scene`/`stage`/`signals` to script observations.
 */

export type MockDefect = "blur" | "dark" | "overexposed" | "corrupt" | "tiny" | "unsupported_format" | "missing";
export type MockStage = "before" | "after" | "progress" | "unrelated";

export interface MockImageSpec {
  ref: string;
  filename: string;
  ordinal: number;
  capturedAt?: string;
  /** Images with the same scene depict the same physical area. */
  scene: string;
  stage: MockStage;
  defects?: MockDefect[];
  /** Render as a near-copy of another image (small perturbation). */
  nearDuplicateOf?: string;
  /** Evidence types the mock vision provider will report, keyed by service. */
  signals?: Record<string, string[]>;
  /** Simulated vision-model misbehaviour for this image. */
  visionResponse?: "MALFORMED_ONCE" | "HALLUCINATED_TYPE" | "REFUSAL";
}

export type MockFailure =
  | { kind: "TRANSIENT"; times: number }
  | { kind: "AUTHENTICATION" }
  | { kind: "VALIDATION" };

export interface MockScenario {
  externalId: string;
  /** Demo case number from the master prompt (§50), if any. */
  demoCase?: number;
  title: string;
  /** What should happen, for humans reading the demo. */
  expected: string;
  clientCode: string;
  name: string;
  serviceDate: string;
  /** How long ago it entered the queue (drives oldest-first ordering). */
  receivedMinutesAgo: number;
  /** Services as supplied by the source system; omitted → client profile defaults. */
  requiredServices?: string[];
  images: MockImageSpec[];
  /** Added to getImages() from the second call onward (reprocessing with new images). */
  imagesAddedLater?: MockImageSpec[];
  failures?: {
    getLocation?: MockFailure;
    getImages?: MockFailure;
    updateVerification?: MockFailure;
    vision?: "OUTAGE" | "MALFORMED";
  };
}

const DATE = "2026-10-04";

let ordinalCounter = 0;
function img(
  prefix: string,
  scene: string,
  stage: MockStage,
  extra: Partial<MockImageSpec> = {},
): MockImageSpec {
  ordinalCounter += 1;
  const n = String(ordinalCounter).padStart(3, "0");
  const hour = stage === "before" ? "08" : stage === "after" ? "11" : "10";
  return {
    ref: `${prefix}-IMG${n}`,
    filename: `${scene}_${stage}_${n}.jpg`,
    ordinal: ordinalCounter,
    capturedAt: `${DATE}T${hour}:${String(ordinalCounter % 60).padStart(2, "0")}:00Z`,
    scene,
    stage,
    ...extra,
  };
}

type AddImage = (scene: string, stage: MockStage, extra?: Partial<MockImageSpec>) => MockImageSpec;

function images(prefix: string, build: (add: AddImage) => MockImageSpec[]): MockImageSpec[] {
  ordinalCounter = 0;
  return build((scene, stage, extra) => img(prefix, scene, stage, extra));
}

const MOWED = { mowing: ["maintained_lawn", "fresh_mow_pattern"] };
const UNMOWED = { mowing: ["tall_overgrown_grass"] };
const EDGED = { edging: ["defined_lawn_boundary", "fresh_edge_line"] };
const UNEDGED = { edging: ["grass_overgrowing_hardscape"] };
const PRUNED = { shrub_pruning: ["shrubs_shaped_uniform", "fresh_cuts_visible"] };
const OVERGROWN_SHRUBS = { shrub_pruning: ["shrubs_overgrown"] };

export const MOCK_SCENARIOS: MockScenario[] = [
  {
    externalId: "NS-DEMO-001",
    demoCase: 1,
    title: "High-quality location with strong evidence",
    expected: "Before/after pairs confirmed per area; mowing and edging SUPPORTED/HIGH, shrub pruning SUPPORTED/MEDIUM (one independent photo). Human confirmation still required.",
    clientCode: "DEMO_CLIENT_A",
    name: "Maple Court Apartments",
    serviceDate: DATE,
    receivedMinutesAgo: 600,
    images: images("NS-DEMO-001", (add) => [
      add("front_lawn", "before", { signals: { ...UNMOWED, ...UNEDGED } }),
      add("front_lawn", "after", { signals: { ...MOWED, ...EDGED } }),
      add("side_lawn", "before", { signals: { ...UNMOWED } }),
      add("side_lawn", "after", { signals: { ...MOWED, ...EDGED } }),
      add("entry_shrubs", "before", { signals: OVERGROWN_SHRUBS }),
      add("entry_shrubs", "after", { signals: PRUNED }),
      add("rear_lawn", "after", { signals: { ...MOWED } }),
      add("parking_strip", "after", { signals: { ...EDGED } }),
    ]),
  },
  {
    externalId: "NS-DEMO-002",
    demoCase: 2,
    title: "Multiple required services supplied by the source system",
    expected: "Mowing/edging/shrub pruning SUPPORTED; weed removal assessed separately; one image supports several services.",
    clientCode: "DEMO_CLIENT_A",
    name: "Oak Ridge Office Park",
    serviceDate: DATE,
    receivedMinutesAgo: 540,
    requiredServices: ["mowing", "edging", "weed_removal", "shrub_pruning"],
    images: images("NS-DEMO-002", (add) => [
      add("courtyard", "before", { signals: { ...UNMOWED, ...UNEDGED } }),
      add("courtyard", "after", { signals: { ...MOWED, ...EDGED } }),
      add("north_bed", "before", { signals: { weed_removal: ["weeds_visible"], ...OVERGROWN_SHRUBS } }),
      add("north_bed", "after", { signals: { weed_removal: ["area_free_of_visible_weeds"], ...PRUNED } }),
      add("south_bed", "before", { signals: { weed_removal: ["weeds_visible"] } }),
      add("south_bed", "after", { signals: { weed_removal: ["area_free_of_visible_weeds", "pulled_weeds_collected"] } }),
      add("west_lawn", "before", { signals: UNMOWED }),
      add("west_lawn", "after", { signals: { ...MOWED, ...EDGED } }),
      add("hedge_row", "before", { signals: OVERGROWN_SHRUBS }),
      add("hedge_row", "after", { signals: PRUNED }),
      add("walkway", "after", { signals: EDGED }),
      add("crew", "progress", {
        signals: { mowing: ["equipment_present"], edging: ["equipment_present"] },
        visionResponse: "MALFORMED_ONCE", // first answer is not valid JSON; the retry succeeds
      }),
    ]),
  },
  {
    externalId: "NS-DEMO-003",
    demoCase: 3,
    title: "Ambiguous evidence",
    expected: "Weed removal INSUFFICIENT_EVIDENCE ('weeds reduced' is not completion; no before images). Human review.",
    clientCode: "DEMO_CLIENT_A",
    name: "Birch Lane Retail",
    serviceDate: DATE,
    receivedMinutesAgo: 480,
    requiredServices: ["weed_removal"],
    images: images("NS-DEMO-003", (add) => [
      add("front_bed", "after", { signals: { weed_removal: ["weeds_reduced"] } }),
      add("side_bed", "after", { signals: { weed_removal: ["weeds_reduced"] } }),
      add("parking_island", "after", {
        signals: { weed_removal: ["weeds_reduced", "equipment_present"] },
        visionResponse: "HALLUCINATED_TYPE", // model invents an evidence type; it must be dropped
      }),
      add("street_view", "unrelated"),
    ]),
  },
  {
    externalId: "NS-DEMO-004",
    demoCase: 4,
    title: "Contradictory evidence",
    expected: "Before-photos are baseline, but the AFTER photo IMG005 shows an uncut section: mowing CONTRADICTORY. Human review required.",
    clientCode: "DEMO_CLIENT_A",
    name: "Cedar Grove HOA",
    serviceDate: DATE,
    receivedMinutesAgo: 420,
    requiredServices: ["mowing"],
    images: images("NS-DEMO-004", (add) => [
      add("main_lawn", "before", { signals: UNMOWED }),
      add("main_lawn", "after", { signals: MOWED }),
      add("east_lawn", "before", { signals: UNMOWED }),
      add("east_lawn", "after", { signals: MOWED }),
      add("back_field", "after", { signals: { mowing: ["uncut_section_visible", "tall_overgrown_grass"] } }),
    ]),
  },
  {
    externalId: "NS-DEMO-005",
    demoCase: 5,
    title: "Poor-quality images",
    expected: "Most images unusable (blur/dark/overexposed/corrupt/tiny); unusable images never count as evidence. Human review.",
    clientCode: "DEMO_CLIENT_B",
    name: "Willow Creek Plaza",
    serviceDate: DATE,
    receivedMinutesAgo: 360,
    images: images("NS-DEMO-005", (add) => [
      add("lot_a", "after", { defects: ["blur"], signals: { trash_debris_leaves_removal: ["area_clear_of_debris"] } }),
      add("lot_b", "after", { defects: ["dark"], signals: { trash_debris_leaves_removal: ["area_clear_of_debris"] } }),
      add("lot_c", "after", { defects: ["overexposed"], signals: { mowing: ["maintained_lawn"] } }),
      add("lot_d", "after", { defects: ["corrupt"] }),
      add("lot_e", "after", { defects: ["tiny"] }),
      add("lot_f", "after", { signals: { trash_debris_leaves_removal: ["area_clear_of_debris"] } }),
    ]),
  },
  {
    externalId: "NS-DEMO-006",
    demoCase: 6,
    title: "Duplicate-heavy submission",
    expected: "25 near-identical photos collapse to one evidence cluster; confidence is not inflated. Human review.",
    clientCode: "DEMO_CLIENT_A",
    name: "Pine Street Townhomes",
    serviceDate: DATE,
    receivedMinutesAgo: 300,
    requiredServices: ["mowing"],
    images: images("NS-DEMO-006", (add) => {
      const before = add("lawn", "before", { signals: UNMOWED });
      const first = add("lawn", "after", { signals: MOWED });
      const dups = Array.from({ length: 24 }, () =>
        add("lawn", "after", { nearDuplicateOf: first.ref, signals: MOWED }),
      );
      return [before, first, ...dups];
    }),
  },
  {
    externalId: "NS-DEMO-007",
    demoCase: 7,
    title: "NetSuite synchronization failure",
    expected: "Strong evidence; after the human decision the NetSuite write fails 3 times (transient), is retried with backoff, then succeeds. Decision is never lost.",
    clientCode: "DEMO_CLIENT_A",
    name: "Elm Park Medical",
    serviceDate: DATE,
    receivedMinutesAgo: 240,
    images: images("NS-DEMO-007", (add) => [
      add("front_lawn", "before", { signals: { ...UNMOWED, ...UNEDGED } }),
      add("front_lawn", "after", { signals: { ...MOWED, ...EDGED } }),
      add("shrubs", "before", { signals: OVERGROWN_SHRUBS }),
      add("shrubs", "after", { signals: PRUNED }),
    ]),
    failures: { updateVerification: { kind: "TRANSIENT", times: 3 } },
  },
  {
    externalId: "NS-DEMO-008",
    demoCase: 8,
    title: "AI provider failure",
    expected: "Vision provider is down: retried, then AI_ERROR in the Exception Lane; a team lead can route it to manual review.",
    clientCode: "DEMO_CLIENT_A",
    name: "Spruce Hill School",
    serviceDate: DATE,
    receivedMinutesAgo: 180,
    images: images("NS-DEMO-008", (add) => [
      add("field", "before", { signals: UNMOWED }),
      add("field", "after", { signals: MOWED }),
    ]),
    failures: { vision: "OUTAGE" },
  },
  {
    externalId: "NS-DEMO-009",
    demoCase: 9,
    title: "Human override",
    expected: "Before and after photos show different areas: pairing finds no same-area pair, so mowing is INSUFFICIENT (before/after not established). Used for the human-override demo, where the reviewer's decision and reason are recorded against the AI assessment.",
    clientCode: "DEMO_CLIENT_A",
    name: "Aspen Way Condos",
    serviceDate: DATE,
    receivedMinutesAgo: 120,
    requiredServices: ["mowing"],
    images: images("NS-DEMO-009", (add) => [
      add("north_lawn", "before", { signals: UNMOWED }),
      add("south_lawn", "after", { signals: MOWED }),
      add("east_lawn", "after", { signals: MOWED }),
    ]),
  },
  {
    externalId: "NS-DEMO-010",
    demoCase: 10,
    title: "Reprocessing with additional images",
    expected: "Run 1: after-only photos → before/after not established. Before photos arrive; reprocess → run 2 confirms pairs and re-assesses. Run 1 is preserved; repeat runs reuse cached comparisons.",
    clientCode: "DEMO_CLIENT_A",
    name: "Hawthorn Business Center",
    serviceDate: DATE,
    receivedMinutesAgo: 60,
    requiredServices: ["mowing", "edging"],
    images: images("NS-DEMO-010", (add) => [
      add("front_lawn", "after", { signals: { ...MOWED, ...EDGED } }),
      add("rear_lawn", "after", { signals: { ...MOWED, ...EDGED } }),
    ]),
    imagesAddedLater: images("NS-DEMO-010-LATE", (add) => [
      add("front_lawn", "before", { signals: { ...UNMOWED, ...UNEDGED } }),
      add("rear_lawn", "before", { signals: { ...UNMOWED, ...UNEDGED } }),
    ]).map((s, i) => ({ ...s, ordinal: 3 + i })),
  },
  // ---- additional edge cases
  {
    externalId: "NS-DEMO-011",
    title: "Fertilization (always human review)",
    expected: "Healthy grass is reported as context only; fertilization is never SUPPORTED from appearance. Client C requires human review.",
    clientCode: "DEMO_CLIENT_C",
    name: "Linden Estates",
    serviceDate: DATE,
    receivedMinutesAgo: 30,
    images: images("NS-DEMO-011", (add) => [
      add("lawn", "before", { signals: { ...UNMOWED, weed_removal: ["weeds_visible"] } }),
      add("lawn", "after", {
        signals: { ...MOWED, landscape_fertilization: ["healthy_lawn_appearance"], weed_removal: ["area_free_of_visible_weeds"] },
      }),
      add("spreader", "progress", { signals: { landscape_fertilization: ["equipment_present"] } }),
      add("bed", "before", { signals: { weed_removal: ["weeds_visible"] } }),
      add("bed", "after", { signals: { weed_removal: ["area_free_of_visible_weeds"] } }),
    ]),
  },
  {
    externalId: "NS-DEMO-012",
    title: "Unknown client",
    expected: "No client profile configured → INTEGRATION_ERROR in the Exception Lane.",
    clientCode: "UNCONFIGURED_CLIENT",
    name: "Mystery Property",
    serviceDate: DATE,
    receivedMinutesAgo: 25,
    images: images("NS-DEMO-012", (add) => [add("lawn", "after")]),
  },
  {
    externalId: "NS-DEMO-013",
    title: "Unknown service code",
    expected: "Source requests 'snow_removal' which is not in the service registry → INTEGRATION_ERROR (never silently dropped).",
    clientCode: "DEMO_CLIENT_A",
    name: "Alder Point",
    serviceDate: DATE,
    receivedMinutesAgo: 20,
    requiredServices: ["mowing", "snow_removal"],
    images: images("NS-DEMO-013", (add) => [add("lawn", "after", { signals: MOWED })]),
  },
  {
    externalId: "NS-DEMO-014",
    title: "No images submitted",
    expected: "Zero images → IMAGE_ERROR in the Exception Lane.",
    clientCode: "DEMO_CLIENT_A",
    name: "Sycamore Commons",
    serviceDate: DATE,
    receivedMinutesAgo: 15,
    images: [],
  },
  {
    externalId: "NS-DEMO-015",
    title: "Flaky image listing",
    expected: "getImages fails twice (transient), then succeeds after retries with backoff.",
    clientCode: "DEMO_CLIENT_A",
    name: "Magnolia Square",
    serviceDate: DATE,
    receivedMinutesAgo: 10,
    images: images("NS-DEMO-015", (add) => [
      add("lawn", "before", { signals: UNMOWED }),
      add("lawn", "after", { signals: MOWED }),
    ]),
    failures: { getImages: { kind: "TRANSIENT", times: 2 } },
  },
  {
    externalId: "NS-DEMO-016",
    title: "Large location (170 images)",
    expected: "Processes within limits; duplicates collapse; evidence bundle stays small.",
    clientCode: "DEMO_CLIENT_B",
    name: "Riverside Corporate Campus",
    serviceDate: DATE,
    receivedMinutesAgo: 5,
    images: images("NS-DEMO-016", (add) =>
      Array.from({ length: 170 }, (_, i) => {
        const scene = `zone_${String(Math.floor(i / 10)).padStart(2, "0")}`;
        const stage: MockStage = i % 10 < 3 ? "before" : "after";
        const signals =
          stage === "before"
            ? { ...UNMOWED, trash_debris_leaves_removal: ["leaf_accumulation_visible"] }
            : { ...MOWED, ...EDGED, trash_debris_leaves_removal: ["area_clear_of_debris"] };
        return add(scene, stage, { signals });
      }),
    ),
  },
];
