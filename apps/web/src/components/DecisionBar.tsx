import { useEffect, useState } from "react";
import { REASON_LABEL } from "../labels";

export type Decision = "APPROVE" | "REJECT" | "ESCALATE";

export interface AiView {
  recommendation: string | null;
  services: { service: string; status: string; confidence: string }[];
}

/**
 * Mirrors the server rule (services/review.ts findConflicts) so the reason picker appears
 * before submitting. The server remains the authority.
 */
export function conflictsFor(decision: Decision, ai: AiView): string[] {
  if (decision === "ESCALATE") return [];
  const out: string[] = [];
  if (decision === "APPROVE" && ai.recommendation === "RECOMMEND_REJECT") out.push("The AI suggested rejecting.");
  if (decision === "REJECT" && ai.recommendation === "RECOMMEND_APPROVE") out.push("The AI suggested approving.");
  for (const s of ai.services) {
    if (decision === "APPROVE" && s.status !== "SUPPORTED") out.push(`${s.service.replaceAll("_", " ")} isn't supported by the evidence.`);
    if (decision === "REJECT" && s.status === "SUPPORTED" && s.confidence === "HIGH") out.push(`${s.service.replaceAll("_", " ")} has strong support.`);
  }
  return out;
}

export function DecisionBar(props: {
  ai: AiView;
  busy: boolean;
  canEscalate: boolean;
  serverError: string | null;
  /** Photos flagged in the viewer; feedback on them needs a reason (PRD §30). */
  flagged?: { imageId: string; ref: string }[];
  onClearFlags?(): void;
  onDecide(d: Decision, reason?: { code: string; text: string }): void;
  onSkip(): void;
}) {
  const flagged = props.flagged ?? [];
  const [pending, setPending] = useState<Decision | null>(null);
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const conflicts = pending ? conflictsFor(pending, props.ai) : [];

  const choose = (d: Decision) => {
    if (props.busy) return;
    if (conflictsFor(d, props.ai).length > 0 || flagged.length > 0) {
      setPending(d); // ask for a reason first
    } else {
      props.onDecide(d);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The target can be the window/document (not an element) when nothing is focused.
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, select, [role=slider]") || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a") choose("APPROVE");
      else if (k === "r") choose("REJECT");
      else if (k === "e" && props.canEscalate) choose("ESCALATE");
      else if (k === "n") props.onSkip();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (pending) {
    const verb = pending === "APPROVE" ? "Approve" : pending === "REJECT" ? "Reject" : "Escalate";
    return (
      <form
        className="decision"
        onSubmit={(e) => {
          e.preventDefault();
          if (code) props.onDecide(pending, { code, text });
        }}
      >
        <div className="reason">
          <strong>{conflicts.length ? `${verb} against the AI?` : `${verb}, with feedback on the AI`}</strong>
          {conflicts.length > 0 && <span className="muted">{conflicts.join(" ")}</span>}
          {flagged.length > 0 && (
            <span className="muted">
              About {flagged.length === 1 ? "photo" : "photos"} <span className="mono">{flagged.map((f) => f.ref.replace(/^.*-(IMG\d+)$/, "$1")).join(", ")}</span>
              {props.onClearFlags && (
                <>
                  {" "}
                  <button type="button" className="linkish" onClick={props.onClearFlags}>
                    clear
                  </button>
                </>
              )}
            </span>
          )}
          <select aria-label="Reason" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus>
            <option value="">Choose a reason…</option>
            {Object.entries(REASON_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <textarea
            aria-label="Note"
            placeholder={code === "OTHER" ? "Describe the reason (required)" : "Note (optional)"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required={code === "OTHER"}
          />
        </div>
        {props.serverError && <span className="error">{props.serverError}</span>}
        <button type="button" className="btn quiet" onClick={() => setPending(null)}>
          Back
        </button>
        <button type="submit" className={`btn ${pending === "APPROVE" ? "approve" : pending === "REJECT" ? "reject" : "primary"}`} disabled={!code || props.busy}>
          {verb} with reason
        </button>
      </form>
    );
  }

  return (
    <div className="decision">
      <button className="btn approve" onClick={() => choose("APPROVE")} disabled={props.busy}>
        Approve <kbd>A</kbd>
      </button>
      <button className="btn reject" onClick={() => choose("REJECT")} disabled={props.busy}>
        Reject <kbd>R</kbd>
      </button>
      {props.canEscalate && (
        <button className="btn quiet" onClick={() => choose("ESCALATE")} disabled={props.busy}>
          Escalate to team lead <kbd>E</kbd>
        </button>
      )}
      {props.serverError && <span className="error">{props.serverError}</span>}
      <span className="spacer" />
      {flagged.length > 0 && (
        <span className="pill" title="Flagged photos are attached to your decision as feedback on the AI">
          {flagged.length} flagged
        </span>
      )}
      <button className="btn quiet" onClick={props.onSkip} disabled={props.busy}>
        Skip to next <kbd>N</kbd>
      </button>
    </div>
  );
}
