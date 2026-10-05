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
| `MockVisionProvider` | `MOCK_AI=true` | Reports the scenario's scripted signals; simulates outage, malformed, hallucination, refusal |
| `AnthropicVisionProvider` | `MOCK_AI=false`, `VISION_PROVIDER=anthropic`, `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true` | `claude-opus-5-5` by default; structured JSON output; effort `high`; server-side refusal fallback; served model recorded per image |

Adding a provider means implementing `VisionProvider.analyzeImage` (return raw output, served model, usage, refusal). Validation, caching and recording are shared.

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
