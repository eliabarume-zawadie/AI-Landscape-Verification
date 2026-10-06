# AI Evaluation

**Status:**
- Evaluation set and runner implemented (Phase 13), and tested with demo examples built from the mock scenarios.
- **Real accuracy is unknown** until labelled historical examples are loaded (unknown U11).
- No accuracy target is assumed. Any automation of final decisions needs measured results on a representative set **and** explicit business approval (PRD §54).

## The evaluation set ("golden examples")

One example is a location's photos, its client and required services, and **the correct answer per service** (approve / reject), checked by a person. It may also record what the reviewer decided at the time (which may have been wrong), the reason, and case types.

| Rule | How |
|---|---|
| A person sets the truth | A draft starts from the reviewer's decision; the team lead corrects it against the photos |
| Second pair of eyes | Approving needs a team lead other than the creator. An admin may approve their own; the audit log records it as self-approved |
| Only approved examples count | Drafts and retired examples are never evaluated |
| No silent edits | Once approved, content is frozen by a database trigger. Corrections retire the example and create a new one. Examples are never deleted |
| Repeatable | Photos are copied into storage (`golden/…`), outside image retention, so the same examples can be re-run against a new model. Note this for the retention policy (U14) |

### Adding examples

1. **From a decided location:** on the location page, team leads use **Add to evaluation set**. The photos are copied, the truth is prefilled from the decision, and case types are suggested from what the pipeline saw (contradiction, poor photos, duplicates, missing before/after…).
2. **Import past cases:** `npm run golden:import -- <folder>` (stop `npm run dev` first). The folder holds the photos and a `manifest.json`:

   ```json
   {
     "examples": [
       {
         "title": "2025-06 Elm St weekly visit",
         "client": "DEMO_CLIENT_A",
         "expected": { "mowing": "APPROVE", "edging": "REJECT" },
         "tags": ["BEFORE_AFTER", "MULTIPLE_SERVICES"],
         "reviewerDecision": "APPROVE",
         "reason": "Edging line not visible along the drive",
         "notes": "optional",
         "images": [{ "file": "elm-st/before-1.jpg", "capturedAt": "2025-06-02T09:00:00Z" }, { "file": "elm-st/after-1.heic" }]
       }
     ]
   }
   ```

   Photos must be jpg, png, webp or heic, inside the folder. Import is all-or-nothing, and every problem is listed. Imported examples are drafts that a team lead approves.
3. **Demo examples:** admins can **Add demo examples** to build 10 approved examples from the mock scenarios, with their intended truth (`DEMO_TRUTH` in `services/golden.ts`). They are always labelled as demo data, are excluded from runs unless included explicitly, and every report that includes them says they are not a measure of real performance.

Case types (PRD §55, §85): clear approval, clear rejection, ambiguous, poor photos, duplicates, contradiction, before/after, no before photo, no after photo, several services, difficult conditions. The Evaluation page shows coverage, and case types with no approved real example are flagged.

## Running an evaluation

On **Evaluation → Run an evaluation** (team leads):
- **What runs:** the **exact production pipeline** (same stages, the active service rules, thresholds and client profiles, and the configured AI provider and model) against every approved example.
- **Isolation:** it runs inside a temporary in-memory database, so the live queue, locations, dashboard and NetSuite are never touched. The AI result cache starts empty, so each run measures the model afresh.
- **One at a time:** only one run can be in progress, and it runs in the background.
- **Billing:** if the AI provider is external, the run is billed, and the page asks for confirmation (with the number of photos) first.
- **Model trials (admins):** an admin can enter another model name to trial it **for that run only**. Production keeps using the configured model.

## The report (PRD §56)

The AI's per-service status becomes a prediction:

| AI status | Prediction |
|---|---|
| SUPPORTED | approve |
| NOT_SUPPORTED, CONTRADICTORY | reject |
| INSUFFICIENT_EVIDENCE, UNABLE_TO_DETERMINE | left to a person (not a mistake, not a success) |

| Metric | Definition |
|---|---|
| **False approval rate** | AI approve where the truth is reject ÷ all "should reject" samples. The highest-risk error (PRD §5) |
| False rejection rate | AI reject where the truth is approve ÷ all "should approve" samples |
| Precision | Correct approvals ÷ AI approvals |
| Recall | AI approvals ÷ true approvals (deferrals count as misses) |
| Left to a person | Deferrals ÷ samples |
| Right when it decided | Correct ÷ samples where the AI decided |
| Human override | Examples where the original reviewer decided differently from the AI |
| Didn't finish | Processing failed (e.g. provider outage); excluded from rates, counted separately |

- **95% ranges:** every rate has a 95% Wilson interval. With few examples the interval is wide (0 false approvals out of 5 is "0%, but anywhere from 0 to 43%"), and the report shows it.
- **Small samples:** anything with fewer samples than `thresholds.metrics.min_sample_size` is marked as indicative.
- **Breakdowns:** by service, whole location, client, case type, photo quality (any unusable photo or not), and AI confidence band (calibration).
- **Also shown:** the versions evaluated (provider, model, prompt, rules, thresholds, application) and coverage gaps.
- **Comparing runs:** any two runs can be compared. The page warns when the example sets differ.

## Feedback loop (PRD §57)

Reviewer overrides → `feedback` table and the Feedback page → a team lead turns relevant locations into examples → second lead approves → evaluation → review → business approval → deployment. Production behaviour never changes automatically from feedback or from evaluation results.

Since Phase 10, every decision with a reason writes feedback rows. Each row holds the AI's status and confidence for the service, the overall recommendation, the human decision, the reason, any photo the reviewer flagged, the run and the reviewer. Team leads browse them on the **Feedback** page and export them as CSV (`/api/feedback/export.csv`) to pick candidate examples. Rows marked `isOverride=false` are feedback given while agreeing with the AI.
