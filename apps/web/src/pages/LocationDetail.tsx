import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, type EvidenceResponse, type LocationDetail } from "../api";
import { isLead, useAuth } from "../auth";
import { RiskTag, StatusTag } from "../components/bits";
import { humanize, LOCATION_STATUS_LABEL, REASON_LABEL, RECOMMENDATION_LABEL } from "../labels";

interface ReviewRow {
  id: string;
  decision: string;
  reviewerName: string | null;
  submittedAt: string;
  isOverride: boolean;
  reasonCode: string | null;
  reasonText: string | null;
  aiRecommendation: string | null;
}

const REPROCESS = [
  ["NEW_IMAGES", "New photos were added"],
  ["IMPROVED_MODEL", "Improved AI model or prompt"],
  ["CONFIG_CHANGE", "Client or service rules changed"],
  ["REVIEWER_DISPUTE", "Reviewer disputes the result"],
  ["TECHNICAL_ERROR", "Technical error"],
] as const;

/** PRD §45 location detail: summary, AI result, decisions, runs and audit history. */
export function LocationDetailPage() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const [d, setD] = useState<LocationDetail | null>(null);
  const [ev, setEv] = useState<EvidenceResponse | null>(null);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [reason, setReason] = useState<string>("TECHNICAL_ERROR");
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      api<LocationDetail>(`/api/locations/${id}`),
      api<EvidenceResponse>(`/api/locations/${id}/evidence`),
      api<{ reviews: ReviewRow[] }>(`/api/locations/${id}/reviews`),
    ]).then(([a, b, c]) => {
      setD(a);
      setEv(b);
      setReviews(c.reviews);
    });
  useEffect(() => {
    load();
  }, [id]);

  const act = async (path: string, body: unknown, done: string) => {
    setMsg(null);
    try {
      await api(path, { method: "POST", body });
      setMsg(done);
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Couldn't complete that action.");
    }
  };

  if (!d || !ev) return <div className="page muted">Loading…</div>;
  const loc = d.location;
  const awaiting = loc.status === "HUMAN_REVIEW" || loc.status === "ESCALATED";
  const isException = ["IMAGE_ERROR", "AI_ERROR", "INTEGRATION_ERROR"].includes(loc.status);

  return (
    <div className="page" style={{ display: "grid", gap: 20, alignContent: "start", maxWidth: 1100 }}>
      <div>
        <Link to="/">← Queue</Link>
        <div className="muted mono" style={{ marginTop: 8 }}>
          {loc.externalId}
        </div>
        <h1>{loc.name ?? loc.externalId}</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {loc.clientName} · {LOCATION_STATUS_LABEL[loc.status] ?? loc.status} · received {new Date(loc.receivedAt).toLocaleString()}
        </p>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {awaiting && (
          <Link className="btn primary" to={`/review/${loc.id}`}>
            Review this location
          </Link>
        )}
        {isLead(user) && isException && (
          <button className="btn" onClick={() => act(`/api/locations/${loc.id}/manual-review`, {}, "Sent to manual review.")}>
            Send to manual review
          </button>
        )}
        {isLead(user) && (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <select aria-label="Reprocess reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REPROCESS.map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => act(`/api/locations/${loc.id}/reprocess`, { reason }, "Reprocessing queued. Earlier results are kept.")}>
              Reprocess
            </button>
          </span>
        )}
        {msg && <span className="muted">{msg}</span>}
      </div>

      {d.openErrors.length > 0 && (
        <section>
          <h2>Open problems</h2>
          <ul>
            {d.openErrors.map((e) => (
              <li key={e.id}>
                <strong>{humanize(e.category)}</strong>: {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ display: "grid", gap: 8 }}>
        <h2>AI assessment {ev.runNumber ? `(run ${ev.runNumber})` : ""}</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <RiskTag level={ev.risk?.level ?? null} />
          <span>{ev.recommendation ? RECOMMENDATION_LABEL[ev.recommendation.value] : "No AI assessment"}</span>
        </div>
        <table className="list">
          <tbody>
            {ev.services.map((s) => (
              <tr key={s.service}>
                <td style={{ width: 220 }}>{s.displayName}</td>
                <td style={{ width: 170 }}>
                  <StatusTag status={s.status} />
                </td>
                <td>{s.explanation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Decisions</h2>
        {reviews.length === 0 ? (
          <p className="muted">No decision yet.</p>
        ) : (
          <table className="list">
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.submittedAt).toLocaleString()}</td>
                  <td>{r.reviewerName}</td>
                  <td>
                    <strong>{humanize(r.decision)}</strong>
                    {r.isOverride && <span className="pill" style={{ marginLeft: 8 }}>against AI</span>}
                  </td>
                  <td>{r.reasonCode ? `${REASON_LABEL[r.reasonCode] ?? r.reasonCode}${r.reasonText ? ` — ${r.reasonText}` : ""}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Processing runs</h2>
        <table className="list">
          <tbody>
            {d.runs.map((r) => (
              <tr key={r.id}>
                <td>Run {r.runNumber}</td>
                <td>{humanize(r.status)}</td>
                <td>{humanize(r.reason)}</td>
                <td className="mono">{r.visionModel ?? "—"}</td>
                <td className="mono">{r.promptVersion ?? "—"}</td>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>History</h2>
        <table className="list">
          <tbody>
            {[...d.audit].reverse().map((a) => (
              <tr key={a.id}>
                <td style={{ whiteSpace: "nowrap" }}>{new Date(a.occurredAt).toLocaleString()}</td>
                <td>{humanize(a.eventType)}</td>
                <td className="muted">{a.actorType.toLowerCase()}</td>
                <td className="muted" style={{ fontSize: 13 }}>
                  {a.eventType === "LOCATION_STATUS_CHANGED" ? `${a.data.from} → ${a.data.to}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
