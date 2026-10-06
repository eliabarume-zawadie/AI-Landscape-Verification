import { Fragment, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type EvalRun, type NoteScopes } from "../api";
import { useAuth } from "../auth";
import { DECISION_LABEL, RECOMMENDATION_LABEL } from "../labels";

type Mode = "MANUAL" | "SHADOW" | "ASSIST" | "FAST_TRACK";
interface Effective {
  mode: Mode;
  configuredMode: Mode;
  fastTrackServices: string[];
  source: "CLIENT" | "DEFAULT" | "ENVIRONMENT";
  validated: boolean;
  reason: string | null;
  setAt: string | null;
  setByName: string | null;
}
interface QcStat {
  checked: number;
  disagree: number;
  pending: number;
  rate: number | null;
  ci95: { low: number; high: number } | null;
  smallSample: boolean;
}
interface RolloutResponse {
  ceiling: Mode;
  shadowSwitch: boolean;
  default: Effective;
  clients: { id: string; code: string; name: string; rollout: Effective }[];
  qc: { overall: QcStat; fastLane: QcStat; random: QcStat; byClient: Record<string, QcStat> };
  qcRates: { fastLane: number; approvals: number };
}
interface QcSample {
  id: string;
  locationId: string;
  externalId: string;
  clientName: string;
  reason: string;
  sampledAt: string;
  status: "PENDING" | "DONE";
  decision: string;
  aiRecommendation: string | null;
  reviewerId: string;
  reviewerName: string;
  verdict: string | null;
  correctDecision: string | null;
  note: string | null;
  checkedByName: string | null;
}

export const MODE_LABEL: Record<Mode, string> = { MANUAL: "Manual (no AI)", SHADOW: "Shadow", ASSIST: "AI assists", FAST_TRACK: "Fast track" };
const MODE_HELP: Record<Mode, string> = {
  MANUAL: "No AI analysis. Reviewers verify the photos themselves.",
  SHADOW: "AI analyses in the background; reviewers don't see it. Compare on Shadow results.",
  ASSIST: "Reviewers see the AI's evidence, strongest photos and suggestion. People decide.",
  FAST_TRACK: "As assist, plus low-risk 'approve' suggestions for the chosen services go to the Fast Lane, where a person still confirms.",
};
const RANK: Record<Mode, number> = { MANUAL: 0, SHADOW: 1, ASSIST: 2, FAST_TRACK: 3 };

function qcText(s: QcStat) {
  if (!s.checked) return s.pending ? `${s.pending} waiting` : "none yet";
  const pct = `${Math.round((s.rate ?? 0) * 100)}%`;
  return `${s.disagree} of ${s.checked} disagreed (${pct}${s.ci95 ? `, 95% range ${Math.round(s.ci95.low * 100)}–${Math.round(s.ci95.high * 100)}%` : ""})${s.pending ? ` · ${s.pending} waiting` : ""}`;
}

function ChangeForm({ target, ceiling, services, runs, onDone }: { target: { id: string | null; name: string; current: Effective }; ceiling: Mode; services: NoteScopes["services"]; runs: EvalRun[]; onDone(msg: string): void }) {
  const [mode, setMode] = useState<Mode>(target.current.configuredMode);
  const [svc, setSvc] = useState<string[]>(target.current.fastTrackServices.filter((s) => s !== "*"));
  const [reason, setReason] = useState("");
  const [runId, setRunId] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ movedOutOfFastLane: number }>("/api/rollout", {
        method: "POST",
        body: { clientId: target.id, mode, ...(mode === "FAST_TRACK" ? { fastTrackServices: svc } : {}), reason, ...(runId ? { evaluationRunId: runId } : {}), ...(ack ? { acknowledgeNoValidation: true } : {}) },
      });
      onDone(`${target.name}: ${MODE_LABEL[mode]}.${r.movedOutOfFastLane ? ` ${r.movedOutOfFastLane} location(s) moved out of the Fast Lane.` : ""}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    }
  };
  return (
    <form className="note-form" onSubmit={submit} style={{ marginTop: 8 }}>
      <strong>Change {target.name}</strong>
      <div className="seg" role="group" aria-label="Mode">
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <button type="button" key={m} aria-pressed={mode === m} disabled={RANK[m] > RANK[ceiling]} title={RANK[m] > RANK[ceiling] ? "Above the server's AUTOMATION_LEVEL" : MODE_HELP[m]} onClick={() => setMode(m)}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {MODE_HELP[mode]}
      </p>
      {mode === "FAST_TRACK" && (
        <>
          <div className="coverage" role="group" aria-label="Services allowed in the Fast Lane">
            {services.map((s) => (
              <label key={s.code} className="check pill-check">
                <input type="checkbox" checked={svc.includes(s.code)} onChange={(e) => setSvc(e.target.checked ? [...svc, s.code] : svc.filter((x) => x !== s.code))} /> {s.name}
              </label>
            ))}
          </div>
          <div className="field">
            <label htmlFor="ro-run">Evidence: evaluation run (optional)</label>
            <select id="ro-run" value={runId} onChange={(e) => setRunId(e.target.value)}>
              <option value="">None</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label ?? new Date(r.requestedAt).toLocaleString()} · {r.exampleCount} examples{(r.demoExamples ?? 0) > 0 ? " (incl. demo)" : ""}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> If the evaluation doesn’t validate it: the business approves fast track anyway (recorded as not validated)
          </label>
        </>
      )}
      <div className="field">
        <label htmlFor="ro-reason">Reason and who approved it</label>
        <textarea id="ro-reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ops director approved a mowing-only pilot, email 6 Oct" />
      </div>
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
      <div>
        <button className="btn primary" type="submit" disabled={!reason.trim() || (mode === "FAST_TRACK" && svc.length === 0)}>
          Save
        </button>
      </div>
    </form>
  );
}

function QcRow({ s, me, onDone }: { s: QcSample; me: string; onDone(): void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const send = async (body: object) => {
    setErr(null);
    try {
      await api(`/api/qc/${s.id}`, { method: "POST", body });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save.");
    }
  };
  const own = s.reviewerId === me;
  return (
    <tr>
      <td>
        <Link to={`/locations/${s.locationId}`} className="mono">
          {s.externalId}
        </Link>
        <div className="muted" style={{ fontSize: 12 }}>
          {s.clientName} · {s.reason === "FAST_LANE" ? "Fast Lane confirmation" : "random approval"} · {new Date(s.sampledAt).toLocaleDateString()}
        </div>
      </td>
      <td>
        {DECISION_LABEL[s.decision] ?? s.decision} by {s.reviewerName}
        <div className="muted" style={{ fontSize: 12 }}>{s.aiRecommendation ? RECOMMENDATION_LABEL[s.aiRecommendation] : "no AI suggestion"}</div>
      </td>
      <td>
        {s.status === "DONE" ? (
          <>
            <span className={`outcome ${s.verdict === "DISAGREE" ? "o-false_approval" : "o-correct"}`}>{s.verdict === "DISAGREE" ? `Should be ${s.correctDecision?.toLowerCase()}` : "Confirmed"}</span>
            <div className="muted" style={{ fontSize: 12 }}>
              {s.checkedByName}
              {s.note ? ` · “${s.note}”` : ""}
            </div>
          </>
        ) : own ? (
          <span className="muted">Someone else must check your own decision</span>
        ) : open ? (
          <div style={{ display: "grid", gap: 6 }}>
            <textarea aria-label="Why it should be rejected" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's wrong with the approval?" />
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn reject" disabled={!note.trim()} onClick={() => send({ verdict: "DISAGREE", correctDecision: "REJECT", note })}>
                Should have been rejected
              </button>
              <button className="btn quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn approve" onClick={() => send({ verdict: "CONFIRMED" })}>
              Approval was right
            </button>
            <button className="btn quiet" onClick={() => setOpen(true)}>
              Disagree…
            </button>
          </div>
        )}
        {err && <div className="error">{err}</div>}
      </td>
    </tr>
  );
}

/** PRD §71 / §90: controlled rollout per client, and quality-control sampling. */
export function RolloutPage() {
  const { user } = useAuth();
  const admin = user?.role === "ADMIN";
  const [d, setD] = useState<RolloutResponse | null>(null);
  const [samples, setSamples] = useState<QcSample[]>([]);
  const [services, setServices] = useState<NoteScopes["services"]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api<RolloutResponse>("/api/rollout").then(setD);
    api<{ samples: QcSample[] }>("/api/qc").then((r) => setSamples(r.samples));
  }, [tick]);
  useEffect(() => {
    api<NoteScopes>("/api/knowledge/scopes").then((s) => setServices(s.services)).catch(() => undefined);
    if (admin) api<{ runs: EvalRun[] }>("/api/evaluations").then((r) => setRuns(r.runs.filter((x) => x.status === "SUCCEEDED"))).catch(() => undefined);
  }, [admin]);

  if (!d) return <div className="page muted">Loading…</div>;
  const rows: { key: string; id: string | null; name: string; r: Effective }[] = [
    { key: "default", id: null, name: "Default (all other clients)", r: d.default },
    ...d.clients.map((c) => ({ key: c.id, id: c.id, name: c.name, r: c.rollout })),
  ];
  const done = () => {
    setEditing(null);
    setTick((x) => x + 1);
  };
  const pending = samples.filter((s) => s.status === "PENDING");
  const checked = samples.filter((s) => s.status === "DONE");

  return (
    <div className="page dash">
      <div className="queue-head">
        <div>
          <h1>Rollout</h1>
          <p className="muted" style={{ margin: "4px 0 0", maxWidth: 860 }}>
            How much each client relies on the AI, and the quality checks that keep it honest. People always make the final decision: fully automatic approval is not available.
          </p>
        </div>
      </div>
      <div className="dx dx-info">
        <span className="dx-icon" aria-hidden>
          i
        </span>
        Server limit: {MODE_LABEL[d.ceiling]} (AUTOMATION_LEVEL).{d.shadowSwitch ? " SHADOW_MODE is on, so every client with AI runs in shadow regardless of the settings below." : ""}
      </div>
      {msg && <p className="muted">{msg}</p>}

      <section>
        <h2>Per client</h2>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th>Client</th>
                <th>In effect</th>
                <th>Fast Lane services</th>
                <th>Last change</th>
                <th>Quality checks</th>
                {admin && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, id, name, r }) => (
                <Fragment key={key}>
                  <tr>
                    <td>
                      {name}
                      {r.source !== "CLIENT" && id && <div className="muted" style={{ fontSize: 12 }}>uses the default</div>}
                    </td>
                    <td>
                      <strong>{MODE_LABEL[r.mode]}</strong>
                      {r.mode !== r.configuredMode && <div className="muted" style={{ fontSize: 12 }}>set to {MODE_LABEL[r.configuredMode]}, limited by the server</div>}
                      {r.configuredMode === "FAST_TRACK" && !r.validated && <span className="pill gap" style={{ marginLeft: 6 }}>not validated</span>}
                    </td>
                    <td style={{ fontSize: 13 }}>{r.mode === "FAST_TRACK" ? (r.fastTrackServices.includes("*") ? "All services" : r.fastTrackServices.map((s) => s.replaceAll("_", " ")).join(", ")) : "—"}</td>
                    <td style={{ fontSize: 13 }}>
                      {r.setAt ? `${new Date(r.setAt).toLocaleDateString()} · ${r.setByName ?? "?"}` : "Server settings"}
                      {r.reason && r.setAt && <div className="muted">“{r.reason}”</div>}
                    </td>
                    <td style={{ fontSize: 13 }}>{id ? qcText(d.qc.byClient[name] ?? { checked: 0, disagree: 0, pending: 0, rate: null, ci95: null, smallSample: true }) : ""}</td>
                    {admin && (
                      <td>
                        <button className="btn quiet" onClick={() => setEditing(editing === key ? null : key)}>
                          {editing === key ? "Close" : "Change"}
                        </button>
                      </td>
                    )}
                  </tr>
                  {editing === key && (
                    <tr key={`${key}-edit`}>
                      <td colSpan={6}>
                        <ChangeForm
                          target={{ id, name, current: r }}
                          ceiling={d.ceiling}
                          services={services}
                          runs={runs}
                          onDone={(m) => {
                            setMsg(m);
                            done();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Quality checks</h2>
        <p className="muted" style={{ marginTop: 0, maxWidth: 860 }}>
          A share of approvals ({Math.round(d.qcRates.fastLane * 100)}% of Fast Lane confirmations, {Math.round(d.qcRates.approvals * 100)}% of other approvals) is checked again by a second team lead. A check never changes the decision; a disagreement means the approval should be corrected in NetSuite and is worth adding to the evaluation set.
        </p>
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Fast Lane confirmations</span>
            {d.qc.fastLane.checked && !d.qc.fastLane.smallSample ? <span className="tile-value">{`${Math.round((d.qc.fastLane.rate ?? 0) * 100)}%`}</span> : <span className="tile-value muted-value">{d.qc.fastLane.checked ? "Not enough checks yet" : "—"}</span>}
            <span className="tile-note">{qcText(d.qc.fastLane)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Other approvals</span>
            {d.qc.random.checked && !d.qc.random.smallSample ? <span className="tile-value">{`${Math.round((d.qc.random.rate ?? 0) * 100)}%`}</span> : <span className="tile-value muted-value">{d.qc.random.checked ? "Not enough checks yet" : "—"}</span>}
            <span className="tile-note">{qcText(d.qc.random)}</span>
          </div>
        </div>
        <h3 style={{ marginTop: 16 }}>Waiting for a check ({pending.length})</h3>
        {pending.length === 0 ? (
          <p className="muted">Nothing waiting.</p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <tbody>
                {pending.map((s) => (
                  <QcRow key={s.id} s={s} me={user!.id} onDone={() => setTick((x) => x + 1)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {checked.length > 0 && (
          <>
            <h3 style={{ marginTop: 16 }}>Checked</h3>
            <div className="table-wrap">
              <table className="list">
                <tbody>
                  {checked.slice(0, 50).map((s) => (
                    <QcRow key={s.id} s={s} me={user!.id} onDone={() => setTick((x) => x + 1)} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
