# AI Evaluation

**Status:** planned (Phase 13). Needs real labelled historical examples (unknown U11).

## Golden dataset

One example = location, client, required service(s), images, expected result per service, reviewer decision, reason.

The dataset must cover: clear positives, clear negatives, ambiguous cases, poor images, duplicates, contradictions, multiple services, missing before/after, different clients and conditions.

## Metrics (per model/prompt/rules version)

- Precision, recall, **false approval rate**, false rejection rate
- Broken down by service, client, image quality, and scene type
- Human override rate (from shadow/assist operation)
- Confidence calibration (reliability curve per band)
- Cost and latency per location

No accuracy target is assumed. Business stakeholders set thresholds after seeing measured performance (PRD §54). Any level-4+ automation also needs explicit business approval and a code change. Config alone cannot enable it.

## Feedback loop

Reviewer overrides → `feedback` table → candidate golden examples → evaluation → review → approval → deployment. Production behaviour never changes automatically from feedback (PRD §57).
