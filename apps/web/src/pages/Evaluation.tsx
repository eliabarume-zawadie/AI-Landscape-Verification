import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, type EvalRun, type GoldenListItem, type Proportion } from "../api";
import { useAuth } from "../auth";
import { SOURCE_LABEL, TAG_LABEL } from "../labels";

export const pctOf = (p: Proportion | undefined | null) => (p && p.value !== null ? `${(p.value * 100).toFixed(p.value < 0.1 && p.value > 0 ? 1 : 0)}%` : "—");
export const range = (p: Proportion | undefined | null) => (p?.ci95 ? `${Math.round(p.ci95.low * 100)}–${Math.round(p.ci95.high * 100)}%` : null);

const STATUS_WORD: Record<string, string> = { PENDING: "Waiting", RUNNING: "Running", SUCCEEDED: "Finished", FAILED: "Failed", DRAFT: "Draft", APPROVED: "Approved", RETIRED: "Retired" };

/** PRD §55–56: the evaluation set and its runs. Team leads. */
export function EvaluationPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [examples, setExamples] = useState<GoldenListItem[] | null>(null);
  const [vision, setVision] = useState<{ provider: string; model: string; external: boolean } | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [label, setLabel] = useState("");
  const [includeDemo, setIncludeDemo] = useState(false);
  const [model, setModel] = useState("");
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api<{ runs: EvalRun[] }>("/api/evaluations").then((r) => setRuns(r.runs));
    api<{ examples: GoldenListItem[] }>("/api/golden").then((r) => setExamples(r.examples));
    api<{ provider: string; model: string; external: boolean }>("/api/evaluations/vision").then(setVision).catch(() => undefined);
  }, [tick]);

  // Follow a running evaluation.
  useEffect(() => {
    if (!runs?.some((r) => r.status === "PENDING" || r.status === "RUNNING")) return;
    const t = setTimeout(() => setTick((x) => x + 1), 3000);
    return () => clearTimeout(t);
  }, [runs]);

  const approved = (examples ?? []).filter((e) => e.status === "APPROVED");
  const inScope = approved.filter((e) => includeDemo || e.source !== "DEMO");
  const realApproved = approved.filter((e) => e.source !== "DEMO").length;
  const coverage = Object.keys(TAG_LABEL)
    .filter((k) => k !== "UNTAGGED")
    .map((tag) => ({ tag, n: approved.filter((e) => e.source !== "DEMO" && e.tags.includes(tag)).length }));
  const external = model ? true : (vision?.external ?? false);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ id: string }>("/api/evaluations", {
        method: "POST",
        body: { ...(label.trim() ? { label: label.trim() } : {}), includeDemo, ...(model.trim() ? { visionModel: model.trim() } : {}), acknowledgeCost: ack },
      });
      setLabel("");
      setMsg("Evaluation started. It runs in the background; results appear here.");
      setTick((x) => x + 1);
      void r;
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Couldn't start the evaluation.");
    }
  };

  const seedDemo = async () => {
    try {
      const r = await api<{ created: number }>("/api/golden/demo", { method: "POST" });
      setMsg(r.created ? `Added ${r.created} demo examples (mock data).` : "Demo examples already exist.");
      setTick((x) => x + 1);
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Couldn't add demo examples.");
    }
  };

  const shown = (examples ?? []).filter((e) => !statusFilter || e.status === statusFilter);

  return (
    <div className="page dash">
      <div className="queue-head">
        <div>
          <h1>Evaluation</h1>
          <p className="muted" style={{ margin: "4px 0 0", maxWidth: 820 }}>
            Measure the AI against examples whose correct answer a person has checked. Runs use the current rules and AI model in a separate sandbox; the live queue is never touched. Nothing here changes how locations are assessed.
          </p>
        </div>
      </div>
      {msg && <p className="muted">{msg}</p>}

      <section>
        <h2>Run an evaluation</h2>
        <form className="note-form" onSubmit={start}>
          <div className="note-form-row">
            <div className="field">
              <label htmlFor="ev-label">Name (optional)</label>
              <input id="ev-label" placeholder="e.g. Baseline before prompt change" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
            </div>
            {user?.role === "ADMIN" && (
              <div className="field">
                <label htmlFor="ev-model">Try another AI model (optional)</label>
                <input id="ev-model" placeholder={vision ? `Current: ${vision.model}` : ""} value={model} onChange={(e) => setModel(e.target.value)} />
              </div>
            )}
          </div>
          <label className="check">
            <input type="checkbox" checked={includeDemo} onChange={(e) => setIncludeDemo(e.target.checked)} /> Include demo examples (mock data)
          </label>
          {external && (
            <label className="check">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand this sends {inScope.reduce((a, e) => a + e.imageCount, 0)} photos to {vision?.provider ?? "the AI provider"} and is billed
            </label>
          )}
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn primary" type="submit" disabled={inScope.length === 0 || (external && !ack)}>
              Evaluate {inScope.length} example{inScope.length === 1 ? "" : "s"}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              AI: {vision ? `${vision.provider} · ${model || vision.model}` : "…"}
            </span>
          </div>
        </form>

        {runs && runs.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="list">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>AI model</th>
                  <th className="num">Examples</th>
                  <th className="num">False approvals</th>
                  <th className="num">False rejections</th>
                  <th className="num">Left to a person</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="row" onClick={() => r.status === "SUCCEEDED" && navigate(`/evaluation/runs/${r.id}`)}>
                    <td>
                      {r.status === "SUCCEEDED" ? <Link to={`/evaluation/runs/${r.id}`}>{r.label ?? new Date(r.requestedAt).toLocaleString()}</Link> : (r.label ?? new Date(r.requestedAt).toLocaleString())}
                      {(r.demoExamples ?? 0) > 0 && <span className="pill" style={{ marginLeft: 6 }}>demo data</span>}
                    </td>
                    <td>{r.status === "FAILED" ? <span title={r.error ?? ""}>Failed</span> : STATUS_WORD[r.status]}</td>
                    <td className="mono">{String(r.versions?.visionModel ?? r.options.visionModel ?? "—")}</td>
                    <td className="num">{r.exampleCount ?? "—"}</td>
                    <td className="num">{r.overall ? `${r.overall.falseApprovals} · ${pctOf(r.overall.falseApprovalRate)}` : "—"}</td>
                    <td className="num">{r.overall ? `${r.overall.falseRejections} · ${pctOf(r.overall.falseRejectionRate)}` : "—"}</td>
                    <td className="num">{r.overall ? r.overall.deferred : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>Examples</h2>
        <p className="muted" style={{ marginTop: 0, maxWidth: 820 }}>
          {realApproved} approved real example{realApproved === 1 ? "" : "s"}. Add examples from decided locations (“Add to evaluation set” on a location) or import past cases (
          <span className="mono">npm run golden:import</span>). Each one needs a second team lead to check the correct answer before it counts.
        </p>
        <div className="coverage" aria-label="Coverage of case types (approved real examples)">
          {coverage.map((c) => (
            <span key={c.tag} className={`pill ${c.n === 0 ? "gap" : ""}`} title={c.n === 0 ? "No approved real example of this kind yet" : undefined}>
              {TAG_LABEL[c.tag]} · {c.n}
            </span>
          ))}
        </div>
        <div className="filters" style={{ marginTop: 12 }}>
          <select aria-label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="DRAFT">Drafts (to check)</option>
            <option value="APPROVED">Approved</option>
            <option value="RETIRED">Retired</option>
          </select>
          {user?.role === "ADMIN" && (
            <button className="btn quiet" onClick={seedDemo}>
              Add demo examples
            </button>
          )}
        </div>
        {examples === null ? (
          <p className="muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="muted">No examples yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th>Example</th>
                  <th>Status</th>
                  <th>Correct answer</th>
                  <th>Case types</th>
                  <th className="num">Photos</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} className="row" onClick={() => navigate(`/evaluation/examples/${e.id}`)}>
                    <td>
                      <Link to={`/evaluation/examples/${e.id}`}>{e.title}</Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {e.clientName} · {SOURCE_LABEL[e.source] ?? e.source}
                      </div>
                    </td>
                    <td>{STATUS_WORD[e.status]}</td>
                    <td style={{ fontSize: 13 }}>
                      {Object.entries(e.expected)
                        .map(([s, v]) => `${s.replaceAll("_", " ")}: ${v === "APPROVE" ? "approve" : "reject"}`)
                        .join(" · ")}
                    </td>
                    <td style={{ fontSize: 13 }}>{e.tags.map((t) => TAG_LABEL[t] ?? t).join(", ")}</td>
                    <td className="num">{e.imageCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
