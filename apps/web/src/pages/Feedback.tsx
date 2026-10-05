import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type FeedbackRow, type FeedbackSummary, type NoteScopes } from "../api";
import { DECISION_LABEL, REASON_LABEL, RECOMMENDATION_LABEL, STATUS_LABEL } from "../labels";

const PAGE = 100;

/** Date input (YYYY-MM-DD, local) → ISO instant; `endOfDay` makes the "to" date inclusive. */
function dayBound(value: string, endOfDay: boolean): string {
  const d = new Date(`${value}T00:00:00`);
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** PRD §30 feedback for team leads. Read-only; feeds evaluation, never the AI directly. */
export function FeedbackPage() {
  const [services, setServices] = useState<NoteScopes["services"]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [service, setService] = useState("");
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    api<NoteScopes>("/api/knowledge/scopes").then((s) => setServices(s.services)).catch(() => undefined);
  }, []);

  const query = useMemo(() => {
    const s = new URLSearchParams();
    if (from) s.set("from", dayBound(from, false));
    if (to) s.set("to", dayBound(to, true));
    if (reason) s.set("reason", reason);
    if (service) s.set("service", service);
    if (overridesOnly) s.set("overridesOnly", "true");
    return s;
  }, [from, to, reason, service, overridesOnly]);

  useEffect(() => {
    setOffset(0);
    setRows(null);
    api<{ rows: FeedbackRow[]; summary: FeedbackSummary }>(`/api/feedback?${query}&limit=${PAGE}`).then((r) => {
      setRows(r.rows);
      setSummary(r.summary);
    });
  }, [query]);

  const more = async () => {
    const next = offset + PAGE;
    const r = await api<{ rows: FeedbackRow[] }>(`/api/feedback?${query}&limit=${PAGE}&offset=${next}`);
    setRows((prev) => [...(prev ?? []), ...r.rows]);
    setOffset(next);
  };

  const serviceName = (code: string | null) => (code ? (services.find((s) => s.code === code)?.name ?? code.replaceAll("_", " ")) : "Whole location");

  return (
    <div className="page">
      <div className="queue-head">
        <div>
          <h1>Feedback on the AI</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Every decision where a reviewer gave a reason. Use it to see where the AI goes wrong. It doesn’t change the AI on its own: it goes into the evaluation set once a team lead checks it.
          </p>
        </div>
        <a className="btn" href={`/api/feedback/export.csv?${query}`} download>
          Download CSV
        </a>
      </div>

      <div className="filters">
        <label className="check">
          From <input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="check">
          To <input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Any reason</option>
          {Object.entries(REASON_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v.replace(" (describe)", "")}
            </option>
          ))}
        </select>
        <select aria-label="Service" value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">Any service</option>
          {services.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={overridesOnly} onChange={(e) => setOverridesOnly(e.target.checked)} /> Only decisions against the AI
        </label>
      </div>

      {summary && summary.total > 0 && (
        <div className="fb-summary" aria-label="Summary">
          <div>
            <b>{summary.total}</b> <span className="muted">feedback rows</span>
          </div>
          <ul>
            {summary.byReason.map((r) => (
              <li key={r.key}>
                <button className="linkish" onClick={() => setReason(reason === r.key ? "" : r.key)} aria-pressed={reason === r.key}>
                  {(REASON_LABEL[r.key] ?? r.key).replace(" (describe)", "")}
                </button>{" "}
                <span className="mono">{r.n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No feedback {query.toString() ? "matches these filters" : "yet. It appears here when reviewers give a reason with their decision"}.</p>
      ) : (
        <>
          <table className="list">
            <thead>
              <tr>
                <th>When</th>
                <th>Location</th>
                <th>Service</th>
                <th>AI said</th>
                <th>Reviewer decided</th>
                <th>Reason</th>
                <th>Photo</th>
                <th>Reviewer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <Link to={`/locations/${r.locationId}`} className="mono">
                      {r.locationExternalId}
                    </Link>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {r.clientName}
                    </div>
                  </td>
                  <td>{serviceName(r.serviceCode)}</td>
                  <td>
                    {r.aiStatus ? (STATUS_LABEL[r.aiStatus] ?? r.aiStatus) : r.aiRecommendation ? (RECOMMENDATION_LABEL[r.aiRecommendation] ?? r.aiRecommendation) : "—"}
                    {r.aiConfidence && <div className="muted" style={{ fontSize: 12 }}>{r.aiConfidence.toLowerCase()} confidence</div>}
                  </td>
                  <td>
                    {DECISION_LABEL[r.humanDecision] ?? r.humanDecision}
                    {r.isOverride && (
                      <span className="pill" style={{ marginLeft: 6 }}>
                        against AI
                      </span>
                    )}
                  </td>
                  <td>
                    {(REASON_LABEL[r.reasonCode] ?? r.reasonCode).replace(" (describe)", "")}
                    {r.reasonText && <div className="muted" style={{ fontSize: 13 }}>“{r.reasonText}”</div>}
                  </td>
                  <td className="mono">{r.imageRef ? r.imageRef.replace(/^.*-(IMG\d+)$/, "$1") : "—"}</td>
                  <td>{r.reviewerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summary && rows.length < summary.total && (
            <button className="btn" style={{ marginTop: 12 }} onClick={more}>
              Show more ({summary.total - rows.length} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}
