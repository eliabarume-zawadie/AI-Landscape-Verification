# Controlled rollout and quality checks (PRD §71, §90)

The **Rollout** page (team leads view it; admins change it) sets how much each client relies on the AI. People always make the final decision. Fully automatic approval (PRD stage 6, automation levels 4–5) does not exist as an option and stays disabled in code.

## Modes

| Mode | PRD stage | What happens |
|---|---|---|
| Manual (no AI) | — | No AI analysis. Reviewers verify the photos themselves. Use it as the rollback |
| Shadow | 2 | The AI analyses live locations, but the people deciding don't see the result. Compare on **Shadow results** (docs/AI_EVALUATION.md) |
| AI assists | 3–4 | Reviewers see the AI's evidence, strongest photos and suggestion |
| Fast track | 5 | As assist, plus low-risk "approve" suggestions go to the **Fast Lane**, where a person still confirms in a batch. Only for the services listed, and only when **every** required service of a location is listed |

- **Default and per client:** a setting applies to one client, or to every client without its own setting (the default row). Until anything is set, the server settings apply.

### Server settings

The server settings stay the ceiling and the safety switch:
- **`AUTOMATION_LEVEL`:** 0 → nothing above Manual; 1–2 → nothing above AI assists; 3 → Fast track allowed. The page refuses modes above the ceiling.
- **`SHADOW_MODE=true`:** every client with AI runs in Shadow, whatever the settings say (global kill switch).

### Rules for a change

- **Recorded:** every change needs a written reason (who approved it, and why). Changes are kept forever (append-only) and audited (`ROLLOUT_CHANGED`).
- **Fast track evidence:** turning on fast track asks for evidence, an evaluation run. It counts as **validated** only if:
  - the run used real (non-demo) examples,
  - it had at least the minimum sample for that client,
  - and it made no false approvals.

  Otherwise the admin must confirm that the business approves it anyway, and the setting is shown as **not validated**. This is a floor, not a business threshold: the business decides (PRD §54).
- **Timing:** a change applies to locations processed from then on. A location keeps the mode it was analysed with.
- **Rollback:** when fast track is narrowed or turned off, locations waiting in the Fast Lane that no longer qualify go back to normal review at once.

## Quality checks

A share of **approvals** is re-checked by a second team lead (rejections aren't sampled, because a false approval is the costly error):

| Setting | Default | Applies to |
|---|---|---|
| `QC_SAMPLE_RATE_FAST_LANE` | 0.1 (10%) | Fast Lane batch confirmations |
| `QC_SAMPLE_RATE_APPROVALS` | 0.02 (2%) | Other approvals |

- **Who checks:** the checker can't be the person who made the decision.
- **Disagreeing:** requires the correct decision and the reason.
- **No changes to decisions:** a check never changes the decision, which is immutable and may already be in NetSuite. A disagreement means the record should be corrected in NetSuite, and the location is worth adding to the evaluation set.
- **The signal:** the disagreement rate per sample type and per client is the real-world signal for false approvals. It is shown with a 95% range, and as "not enough checks yet" below the minimum sample.
