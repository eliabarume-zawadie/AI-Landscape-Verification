import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, type LocationRow } from "../api";
import { RiskTag } from "../components/bits";
import { age, LOCATION_STATUS_LABEL, RECOMMENDATION_LABEL } from "../labels";

type LaneKey = "HUMAN_REVIEW" | "FAST" | "EXCEPTION" | "ALL";
const LANES: { key: LaneKey; label: string; hint: string }[] = [
  { key: "HUMAN_REVIEW", label: "Needs review", hint: "AI flagged something, or a person must decide" },
  { key: "FAST", label: "Fast lane", hint: "Strong evidence, low risk — confirm quickly" },
  { key: "EXCEPTION", label: "Problems", hint: "Photo, AI or data problems to resolve" },
  { key: "ALL", label: "Search all", hint: "Every location, any status" },
];

interface Summary {
  byLane: Record<string, number>;
  byStatus: Record<string, number>;
}

export function QueuePage() {
  const [params, setParams] = useSearchParams();
  const lane = (params.get("lane") as LaneKey | null) ?? "HUMAN_REVIEW";
  const navigate = useNavigate();
  const message = (useLocation().state as { message?: string } | null)?.message;
  const [rows, setRows] = useState<LocationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [risk, setRisk] = useState(params.get("risk") ?? "");
  const [sort, setSort] = useState(params.get("sort") ?? "oldest");

  useEffect(() => {
    api<Summary>("/api/queue/summary").then(setSummary).catch(() => undefined);
  }, [lane]);

  useEffect(() => {
    const s = new URLSearchParams({ sort, limit: "100" });
    if (lane !== "ALL") s.set("lane", lane);
    if (q.trim()) s.set("q", q.trim());
    if (risk) s.set("risk", risk);
    setRows(null);
    api<{ items: LocationRow[]; total: number }>(`/api/locations?${s}`).then((r) => {
      setRows(r.items);
      setTotal(r.total);
    });
  }, [lane, q, risk, sort]);

  const start = async () => {
    const r = await api<{ locationId: string | null }>(`/api/review/next?lane=${lane === "FAST" ? "FAST" : "HUMAN_REVIEW"}`);
    if (r.locationId) navigate(`/review/${r.locationId}?lane=${lane === "FAST" ? "FAST" : "HUMAN_REVIEW"}`);
  };

  const open = (r: LocationRow) =>
    navigate(r.status === "HUMAN_REVIEW" || r.status === "ESCALATED" ? `/review/${r.id}?lane=${r.lane === "FAST" ? "FAST" : "HUMAN_REVIEW"}` : `/locations/${r.id}`);

  return (
    <div className="page">
      <div className="queue-head">
        <div>
          <h1>Verification queue</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Oldest first. Open a location to see the AI's evidence and decide.
          </p>
        </div>
        {(lane === "HUMAN_REVIEW" || lane === "FAST") && (
          <div style={{ display: "flex", gap: 8 }}>
            {lane === "FAST" && (
              <button className="btn" onClick={() => navigate("/fast-lane")}>
                Confirm in batch
              </button>
            )}
            <button className="btn primary" onClick={start} disabled={!rows?.length}>
              Start reviewing
            </button>
          </div>
        )}
      </div>
      {message && <p className="muted">{message}</p>}

      <div className="lanes" role="group" aria-label="Lanes">
        {LANES.map((l) => (
          <button key={l.key} className="lane" aria-pressed={lane === l.key} title={l.hint} onClick={() => setParams({ lane: l.key })}>
            <span>{l.label}</span>
            {l.key !== "ALL" && <b>{summary?.byLane[l.key] ?? 0}</b>}
          </button>
        ))}
      </div>

      <div className="filters">
        <input aria-label="Search" placeholder="Search location ID or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Risk" value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="">Any risk</option>
          <option value="HIGH">High risk</option>
          <option value="MEDIUM">Medium risk</option>
          <option value="LOW">Low risk</option>
        </select>
        <select aria-label="Order" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="oldest">Oldest first</option>
          <option value="risk">Highest risk first</option>
          <option value="newest">Newest first</option>
        </select>
        <span className="muted" style={{ alignSelf: "center" }}>
          {rows ? `${total} location${total === 1 ? "" : "s"}` : "Loading…"}
        </span>
      </div>

      {rows && rows.length === 0 ? (
        <p className="muted">{lane === "EXCEPTION" ? "No problems to resolve." : "Nothing here. The queue is clear."}</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Location</th>
              <th>Client</th>
              <th>Services</th>
              <th>Photos</th>
              <th>Risk</th>
              <th>AI suggests</th>
              <th>Status</th>
              <th>Waiting</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="row" tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => e.key === "Enter" && open(r)}>
                <td>
                  <div>{r.name ?? r.externalId}</div>
                  <div className="mono muted">{r.externalId}</div>
                </td>
                <td>{r.client}</td>
                <td>{r.services.map((s) => s.replaceAll("_", " ")).join(", ")}</td>
                <td>{r.imageCount}</td>
                <td>
                  <RiskTag level={r.riskLevel} />
                </td>
                <td>{r.aiRecommendation ? RECOMMENDATION_LABEL[r.aiRecommendation] : <span className="muted">—</span>}</td>
                <td>{LOCATION_STATUS_LABEL[r.status] ?? r.status}</td>
                <td>{age(r.receivedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
