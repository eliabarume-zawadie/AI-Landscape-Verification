import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { DECISION_LABEL, RECOMMENDATION_LABEL, STATUS_LABEL } from "../labels";

interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
  suppressed: boolean;
  ci95?: { low: number; high: number } | null;
}
interface Item {
  reviewId: string;
  locationId: string;
  externalId: string;
  name: string | null;
  clientName: string;
  reviewerName: string;
  decision: string;
  aiRecommendation: string | null;
  aiServices: Record<string, { status: string; confidence: string }>;
  agreement: "AGREE" | "DISAGREE" | "AI_DEFERRED" | null;
  aiApproveHumanReject: boolean;
  aiSeconds: number | null;
  humanSeconds: number | null;
  decidedAt: string;
}
interface Report {
  enabled: boolean;
  automationLevel: number;
  minSample: number;
  summary: {
    decisions: number;
    agreement: Rate;
    aiDeferred: Rate;
    aiApproveHumanReject: Rate;
    aiRejectHumanApprove: Rate;
    byService: Record<string, Rate>;
    aiSecondsMedian: number | null;
    humanSecondsMedian: number | null;
  };
  items: Item[];
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (k: number) => {
  const d = new Date();
  d.setDate(d.getDate() - k);
  return localDate(d);
};
const secs = (v: number | null) => (v === null ? "—" : v < 90 ? `${v < 10 ? v.toFixed(1) : Math.round(v)} s` : `${Math.round(v / 60)} min`);
const AGREEMENT: Record<string, string> = { AGREE: "Agreed", DISAGREE: "Disagreed", AI_DEFERRED: "AI couldn't decide" };

function RateTile({ label, r, of, min }: { label: string; r: Rate; of: string; min: number }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      {r.value !== null ? <span className="tile-value">{Math.round(r.value * 100)}%</span> : <span className="tile-value muted-value">Not enough data</span>}
      <span className="tile-note">
        {r.denominator ? `${r.numerator} of ${r.denominator} ${of}` : `no ${of} yet`}
        {r.value === null && r.denominator > 0 && `; needs ${min}`}
        {r.ci95 && r.denominator > 0 && ` · 95% range ${Math.round(r.ci95.low * 100)}–${Math.round(r.ci95.high * 100)}%`}
      </span>
    </div>
  );
}

/** PRD §89 shadow mode: AI vs human, recorded silently. Team leads. */
export function ShadowPage() {
  const [days, setDays] = useState(29);
  const [r, setR] = useState<Report | null>(null);
  const [onlyDisagreements, setOnlyDisagreements] = useState(true);
  useEffect(() => {
    setR(null);
    api<Report>(`/api/shadow?from=${daysAgo(days)}&to=${localDate(new Date())}`).then(setR);
  }, [days]);
  const items = useMemo(() => (r?.items ?? []).filter((i) => !onlyDisagreements || i.agreement === "DISAGREE"), [r, onlyDisagreements]);

  return (
    <div className="page dash">
      <div className="queue-head">
        <div>
          <h1>Shadow results</h1>
          <p className="muted" style={{ margin: "4px 0 0", maxWidth: 860 }}>
            In shadow mode the AI analyses live locations but reviewers don’t see its result, and it has no effect on decisions. This page compares what the AI would have suggested with what people decided. Reviewers aren’t always right either; disagreements are cases to look at, not proven AI errors.
          </p>
        </div>
      </div>
      {r && (
        <div className={`dx ${r.enabled ? "dx-ok" : "dx-info"}`}>
          <span className="dx-icon" aria-hidden>
            {r.enabled ? "✓" : "i"}
          </span>
          {r.enabled
            ? "Shadow mode is on: new locations are analysed with the AI result hidden from reviewers."
            : "Shadow mode is off: reviewers see AI suggestions. Set SHADOW_MODE=true and restart to run the AI in the background only. Earlier shadow decisions are still shown below."}
        </div>
      )}
      <div className="filters">
        <div className="seg" role="group" aria-label="Period">
          {[
            [0, "Today"],
            [6, "7 days"],
            [29, "30 days"],
            [89, "90 days"],
          ].map(([k, l]) => (
            <button key={k} aria-pressed={days === k} onClick={() => setDays(k as number)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {!r ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <section>
            <h2>AI vs reviewers · {r.summary.decisions} decisions</h2>
            <div className="tiles">
              <RateTile label="Agreed with the reviewer" r={r.summary.agreement} of="AI suggestions" min={r.minSample} />
              <RateTile label="AI would have approved, reviewer rejected" r={r.summary.aiApproveHumanReject} of="approve suggestions" min={r.minSample} />
              <RateTile label="AI would have rejected, reviewer approved" r={r.summary.aiRejectHumanApprove} of="reject suggestions" min={r.minSample} />
              <RateTile label="AI couldn’t decide" r={r.summary.aiDeferred} of="decisions" min={r.minSample} />
              <div className="tile">
                <span className="tile-label">Time per location</span>
                <span className="tile-value">{secs(r.summary.humanSecondsMedian)}</span>
                <span className="tile-note">reviewer (median) · AI {secs(r.summary.aiSecondsMedian)}</span>
              </div>
            </div>
            {Object.keys(r.summary.byService).length > 0 && (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="list" style={{ maxWidth: 640 }}>
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th className="num">AI verdicts</th>
                      <th className="num">Agreed with reviewer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(r.summary.byService)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([svc, rt]) => (
                        <tr key={svc}>
                          <td>{svc.replaceAll("_", " ")}</td>
                          <td className="num">{rt.denominator}</td>
                          <td className="num">{rt.value !== null ? `${Math.round(rt.value * 100)}%` : <span className="muted">{rt.numerator} of {rt.denominator}</span>}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2>Decisions</h2>
            <label className="check">
              <input type="checkbox" checked={onlyDisagreements} onChange={(e) => setOnlyDisagreements(e.target.checked)} /> Only disagreements
            </label>
            {items.length === 0 ? (
              <p className="muted">{r.items.length === 0 ? "No shadow-mode decisions in this period." : "No disagreements in this period."}</p>
            ) : (
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="list">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th>AI would have said</th>
                      <th>Reviewer decided</th>
                      <th>Result</th>
                      <th className="num">AI time</th>
                      <th className="num">Reviewer time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.reviewId}>
                        <td>
                          <Link to={`/locations/${i.locationId}`} className="mono">
                            {i.externalId}
                          </Link>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {i.clientName} · {i.reviewerName} · {new Date(i.decidedAt).toLocaleString()}
                          </div>
                        </td>
                        <td>
                          {i.aiRecommendation ? (RECOMMENDATION_LABEL[i.aiRecommendation] ?? i.aiRecommendation) : "—"}
                          <div className="muted" style={{ fontSize: 12 }}>
                            {Object.entries(i.aiServices)
                              .map(([s, a]) => `${s.replaceAll("_", " ")}: ${(STATUS_LABEL[a.status] ?? a.status).toLowerCase()}`)
                              .join(" · ")}
                          </div>
                        </td>
                        <td>{DECISION_LABEL[i.decision] ?? i.decision}</td>
                        <td>
                          <span className={`outcome ${i.aiApproveHumanReject ? "o-false_approval" : i.agreement === "AGREE" ? "o-correct" : "o-deferred"}`}>
                            {i.aiApproveHumanReject ? "AI would have approved" : i.agreement ? AGREEMENT[i.agreement] : "Escalated"}
                          </span>
                        </td>
                        <td className="num">{secs(i.aiSeconds)}</td>
                        <td className="num">{secs(i.humanSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
