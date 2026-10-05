# AI Pipeline

**Status:** interfaces and service rules defined (Phase 1). Pipeline stages are implemented in Phases 3–8.

## Stages

```text
Image → Format validation → Pixel quality (blur, dark, bright, size) → Exact + near-duplicate clustering
     → Relevance → Service observations (vision) → Before/after pairing → Pair comparison (vision)
     → Evidence aggregation → Contradiction detection → Risk → Recommendation + Lane
```

Every stage writes structured results keyed by `processing_run_id`.

## Image stage (implemented, Phase 3)

| Step | How | Output |
|---|---|---|
| Fetch | `ImageProvider`, `IMAGE_FETCH_CONCURRENCY` in parallel; stored bytes reused | private storage object, `images.sha256` |
| Decode + measure | sharp, single decode, ≤512 px greyscale copy; HEVC HEIC (iPhone) decoded by libheif then handed to sharp | format, oriented size, mean luminance, Laplacian variance, dark/bright fractions |
| Quality | `domain/quality.ts` against active thresholds | score (ranking only), usable, issues |
| Duplicates | `domain/dedup.ts`: SHA-256 exact; near = dHash Hamming ≤ `near_duplicate_hamming_max` **and** 32×32 MAD ≤ `near_duplicate_mad_max` | cluster, representative, kind |

Why two duplicate signals: dHash alone captures structure, and before/after photos of the same scene share structure. Requiring near-identical pixels as well keeps before/after pairs apart. In mock calibration the before/after distance was 38 bits against a threshold of 10.

Unusable images stay visible to reviewers but can never count as positive evidence. Duplicates are clustered for counting only; every image remains viewable.

## Vision stage (implemented, Phase 4)

| Step | Rule |
|---|---|
| Select | Only images that are usable **and** represent their duplicate cluster. Others are recorded as `SKIPPED_UNUSABLE` / `SKIPPED_DUPLICATE` |
| Prepare | Decode (HEIC via libheif), orient, resize to ≤ `VISION_MAX_IMAGE_SIDE`, JPEG |
| Cache | Key = SHA-256 of image + prompt hash + provider/model/settings + rules version + requested services + size |
| Call | `VisionProvider.analyzeImage` with the rendered versioned prompt and a JSON Schema whose enums restrict services/evidence types |
| Validate | `validateImageAnalysis`: structural schema, then registry rules (see below). Malformed → one retry → `MALFORMED` |
| Record | `image_analysis`: status, validated observations, raw response, warnings, served model, cost, latency, relevance; AI visibility issues make the image unusable |
| Fail | Provider outage/rate limit → job retry with backoff. Auth failure → `AI_ERROR` immediately. No valid analysis for any candidate → `AI_ERROR` |

Validation drops (with a warning): unrequested services; evidence types not defined for that service; strength outside 0–1; empty description; any evidence on an image the model marked irrelevant. Polarity (positive / negative / context) always comes from the registry, never from the model.

Analysis statuses: `ANALYZED`, `CACHED`, `SKIPPED_UNUSABLE`, `SKIPPED_DUPLICATE`, `MALFORMED`, `REFUSED`. Only `ANALYZED`/`CACHED` observations can ever become evidence.

### Providers

| Provider | When | Notes |
|---|---|---|
| `MockVisionProvider` | `MOCK_AI=true` (local default) | Reports the scenario's scripted signals; simulates outage, malformed, hallucination, refusal |
| `AnthropicVisionProvider` | `MOCK_AI=false` — **default provider** (`VISION_PROVIDER=anthropic`) | `claude-opus-5-5` unless `VISION_MODEL` is set; structured JSON output; `VISION_EFFORT` (default `high`); server-side refusal fallback (`VISION_FALLBACKS`) |
| `OpenAIVisionProvider` | `MOCK_AI=false`, `VISION_PROVIDER=openai`, `VISION_MODEL` **required** | Chat Completions with strict JSON-schema output, image `detail: high`; `OPENAI_BASE_URL` may point to an OpenAI-compatible endpoint |

Both real providers require `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true`. Switching provider or model changes the cache key and is recorded on every run and image, so results from different models never mix and evaluation can compare them (Phase 13). Model choice for production should come from that evaluation, not from defaults.

Adding a provider means implementing `VisionProvider.analyzeImage` (return raw output, served model, usage, refusal). Validation, caching and recording are shared.

## Evidence engine (implemented, Phase 5)

Pure function `assessService(ctx, service)` in `domain/evidence.ts`. Per required service:

1. **Eligible images**: analysis `ANALYZED`/`CACHED`, usable, representative of its duplicate cluster. One vote per cluster.
2. **Classify observations** by the current rules' polarity. Positive types listed in `insufficient_alone` cannot support alone. (Phase 6) negative evidence in a *before* photo is baseline context; positive evidence in a before photo cannot support.
3. **Status** (first match wins):

| Condition | Status |
|---|---|
| No eligible image, and some analyses failed | `UNABLE_TO_DETERMINE` |
| No eligible image | `INSUFFICIENT_EVIDENCE` (`NO_USABLE_ANALYSED_IMAGES`) |
| Support ≥ medium band **and** counter-evidence ≥ `counter_evidence_min_strength` | `CONTRADICTORY` (pairs recorded) |
| Counter-evidence only | `NOT_SUPPORTED` |
| No qualifying positive evidence | `INSUFFICIENT_EVIDENCE` (`ONLY_CONTEXT_EVIDENCE` / `NO_RELEVANT_EVIDENCE`) |
| Best support < service `minimum_confidence_for_assistance` | `INSUFFICIENT_EVIDENCE` (`BELOW_CONFIDENCE_THRESHOLD`) |
| Any requirement unmet or not yet evaluated (before/after, min usable images, distinct scenes) | `INSUFFICIENT_EVIDENCE` (reason per requirement) |
| Otherwise | `SUPPORTED` |

4. **Confidence**: band of the deciding strength; capped at MEDIUM below `min_independent_images_for_high` independent images; LOW for contradictory/insufficient/unable.
5. **Human required** unless `SUPPORTED` + `HIGH` + no rule requiring review + no weak counter-evidence + no failed analyses. (At automation levels ≤ 3 a human decides regardless; this flag drives lanes in Phase 8.)
6. **Decomposed services** (landscape maintenance): most severe component status; own negative evidence can add a contradiction.

Explanations are deterministic templates that cite image refs. No LLM writes them.

## Before/after stage (implemented, Phase 6)

```text
stages (metadata) → candidates (visual shortlist) → pair comparison (model) → distinct-area check (model) → engine inputs
```

| Step | Rule |
|---|---|
| Stage | Filename words + capture-time split (one dominant gap ≥ `min_time_gap_minutes` and ≥ `time_gap_dominance_ratio` × next gap). STRONG when both agree; conflict/none → UNKNOWN. Never from image content or upload order |
| Candidates | Eligible BEFORE × AFTER photos. All combinations up to `max_full_pairs`, else top `candidates_per_before` by colour histogram L1 + `structure_weight` × shift-tolerant structure distance |
| Compare | `comparePair` with `before_after_v1`: `same_area`, `same_area_confidence`, `comparison_possible`, per-service `IMPROVED`/`NO_VISIBLE_CHANGE`/`WORSENED`. Confirmed = same area, comparable, confidence ≥ `min_same_area_confidence` |
| Distinct areas | `same_area_v1` check between confirmed pairs' after-photos; credited only on a confident "different", up to the client's `min_distinct_scenes` |
| Baseline | BEFORE photo with STRONG label, or in a confirmed pair → its negative evidence is baseline context, and it cannot support |
| Established | Confirmed pair + `IMPROVED` ≥ medium + qualifying positive evidence in the after-photo |
| Counter | `NO_VISIBLE_CHANGE`/`WORSENED` ≥ `counter_evidence_min_strength` → negative evidence on the after-photo |

Pair statuses: `CONFIRMED`, `NOT_SAME_AREA`, `NOT_COMPARABLE`, `LOW_CONFIDENCE`, `MALFORMED`, `REFUSED`. All evaluated pairs are stored and shown to reviewers.

## Evidence bundle (implemented, Phase 7)

Per service, in this order (each image listed once, with all its services and roles):

| Priority | Content | Can the cap drop it? |
|---|---|---|
| 1 | Both images of every recorded contradiction | Never |
| 2 | Counter-evidence ≥ `counter_evidence_min_strength` (one per duplicate cluster) | Never |
| 3 | The confirmed before/after pair that established the service | Never |
| 4 | Top `per_service_supporting` supporting images: one per cluster, round-robin across areas, never baseline or unusable | Yes |
| 5 | One context image when the service has no support | Yes |

All images also get an evidence rank for the "strongest first" view: bundle order, then quality/strength/pair/counter-evidence, duplicates after their representative, unusable last.

## Division of responsibility

| Vision model (non-deterministic) | ALVIP code (deterministic, tested, versioned) |
|---|---|
| Per-image quality issues it can see (obstruction, irrelevance) | Pixel quality metrics, usability decision |
| Observations: `{service, evidence_type, polarity, strength, description}` restricted to the evidence types in the service registry | Mapping observations → service status (5 states) |
| Pair change description | Pair candidate selection |
| | Duplicate handling, diversity, contradictions, risk, lanes, recommendation |

## Service rules

[`config/services.json`](../config/services.json) defines, for each service:

- `evidence_types` with polarity: `positive` (can support), `negative` (challenges, feeds contradiction detection), `context` (never support on its own).
- `insufficient_alone`: evidence types that cannot support a service by themselves (e.g. `equipment_present`, `healthy_lawn_appearance`, `weeds_reduced`, `dead_brown_grass_observed`).
- `safety_notes`: guardrails injected into prompts.
- `default_human_review`: `true` for fertilization (PRD §61) and dead/brown grass (requirement unconfirmed, U7).

Schema-level invariants (cannot be configured away): contradictions always require human review; equipment is never sufficient alone.

## Confidence

Model scores are stored internally and mapped to HIGH / MEDIUM / LOW using `confidence_bands` in the active thresholds version. Percentages are not shown until calibration (Phase 13).

## Versioning

Each run records provider, model, model version, prompt version, service-rules version, client-profile version, thresholds version, and application version.
