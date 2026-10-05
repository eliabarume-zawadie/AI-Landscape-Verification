# AI Pipeline

**Status:** interfaces and service rules defined (Phase 1). Pipeline stages are implemented in Phases 3–8.

## Stages

```text
Image → Format validation → Pixel quality (blur, dark, bright, size) → Exact + near-duplicate clustering
     → Relevance → Service observations (vision) → Before/after pairing → Pair comparison (vision)
     → Evidence aggregation → Contradiction detection → Risk → Recommendation + Lane
```

Every stage writes structured results keyed by `processing_run_id`.

## Division of responsibility

| Vision model (non-deterministic) | ALVIP code (deterministic, tested, versioned) |
|---|---|
| Per-image quality issues it can see (obstruction, irrelevance) | Pixel quality metrics, usability decision |
| Observations: `{service, evidence_type, polarity, strength, description}` restricted to the evidence types in the service registry | Mapping observations → service status (5 states) |
| Pair change description | Pair candidate selection |
| | Duplicate handling, diversity, contradictions, risk, lanes, recommendation |

## Service rules

[`config/services.v1.json`](../config/services.v1.json) defines, for each service:

- `evidence_types` with polarity: `positive` (can support), `negative` (challenges, feeds contradiction detection), `context` (never support on its own).
- `insufficient_alone`: evidence types that cannot support a service by themselves (e.g. `equipment_present`, `healthy_lawn_appearance`, `weeds_reduced`, `dead_brown_grass_observed`).
- `safety_notes`: guardrails injected into prompts.
- `default_human_review`: `true` for fertilization (PRD §61) and dead/brown grass (requirement unconfirmed, U7).

Schema-level invariants (cannot be configured away): contradictions always require human review; equipment is never sufficient alone.

## Confidence

Model scores are stored internally and mapped to HIGH / MEDIUM / LOW using `confidence_bands` in the active thresholds version. Percentages are not shown until calibration (Phase 13).

## Versioning

Each run records provider, model, model version, prompt version, service-rules version, client-profile version, thresholds version, and application version.
