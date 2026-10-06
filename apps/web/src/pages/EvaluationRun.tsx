import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type EvalMetrics, type EvalRun, type Proportion } from "../api";
import { OUTCOME_LABEL, STATUS_LABEL, TAG_LABEL } from "../labels";
import { pctOf, range } from "./Evaluation";

interface ResultRow {
  exampleId: string;
  title: string;
  serviceCode: string | null;
  expected: string;
  aiStatus: string | null;
  aiConfidence: string | null;
  predicted: string;
  outcome: string;
  explanation: string | null;
}

function RateTile({ label, p, note, compare }: { label: string; p: Proportion; note: string; compare?: Proportion | undefined }) {
  const delta = compare && compare.value !== null && p.value !== null ? (p.value - compare.value) * 100 : null;
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{pctOf(p)}</span>
      <span className="tile-note">
        {p.n ? `${p.k} of ${p.n} ${note}` : `no ${note}`}
        {range(p) && ` · 95% range ${range(p)}`}
      </span>
      {delta !== null && <span className="tile-note">vs compared run: {delta === 0 ? "no change" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} points`}</span>}
    </div>
  );
}

function MetricsTable({ title, rows, nameOf }: { title: string; rows: Record<string, EvalMetrics>; nameOf?: (k: string) => string }) {
  // jsonb reorders keys (by length), so sort for display.
  const entries = Object.entries(rows).sort(([a], [b]) => (nameOf ? nameOf(a) : a).localeCompare(nameOf ? nameOf(b) : b));
  if (entries.length === 0) return null;
  return (
    <div>
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="list">
          <thead>
            <tr>
              <th />
              <th className="num">Samples</th>
              <th className="num">Correct</th>
              <th className="num">Incorrect</th>
              <th className="num">False approval</th>
              <th className="num">False rejection</th>
              <th className="num">Left to a person</th>
              <th className="num">Human override</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, m]) => (
              <tr key={k}>
                <td>
                  {nameOf ? nameOf(k) : k}
                  {m.smallSample && <span className="muted" title="Fewer samples than the minimum; indicative only"> *</span>}
                </td>
                <td className="num">{m.samples}</td>
                <td className="num">{m.correct}</td>
                <td className="num">{m.incorrect}</td>
                <td className={`num ${m.falseApprovals > 0 ? "bad" : ""}`}>{m.falseApprovals}</td>
                <td className="num">{m.falseRejections}</td>
                <td className="num">{m.deferred}</td>
                <td className="num">{m.humanOverride}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** PRD §56 evaluation report. */
export function EvaluationRunPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<{ run: EvalRun; results: ResultRow[] } | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [compareId, setCompareId] = useState("");
  const [compare, setCompare] = useState<EvalRun | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(true);

  useEffect(() => {
    api<{ run: EvalRun; results: ResultRow[] }>(`/api/evaluations/${id}`).then(setData);
    api<{ runs: EvalRun[] }>("/api/evaluations").then((r) => setRuns(r.runs.filter((x) => x.status === "SUCCEEDED" && x.id !== id)));
  }, [id]);
  useEffect(() => {
    if (!compareId) return setCompare(null);
    api<{ run: EvalRun }>(`/api/evaluations/${compareId}`).then((r) => setCompare(r.run));
  }, [compareId]);

  const results = useMemo(() => (data?.results ?? []).filter((r) => r.serviceCode !== null && (!onlyProblems || r.outcome !== "CORRECT")), [data, onlyProblems]);
  if (!data) return <div className="page muted">Loading…</div>;
  const { run } = data;
  const s = run.summary!;
  const c = compare?.summary ?? undefined;
  const v = run.versions ?? {};

  return (
    <div className="page dash">
      <div>
        <Link to="/evaluation">← Evaluation</Link>
        <h1 style={{ marginTop: 8 }}>{run.label ?? "Evaluation"}</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {new Date(run.requestedAt).toLocaleString()} · {s.examples} examples · {Math.round(s.durationMs / 1000)} s · AI cost ${Number(run.costUsd ?? 0).toFixed(2)}
        </p>
      </div>

      {s.demoExamples > 0 && (
        <div className="dx dx-warn">
          <span className="dx-icon" aria-hidden>
            !
          </span>
          Includes {s.demoExamples} demo example{s.demoExamples === 1 ? "" : "s"} built from mock data. These numbers show the method works; they are not a measure of real AI performance.
        </div>
      )}
      {s.overall.smallSample && (
        <div className="dx dx-info">
          <span className="dx-icon" aria-hidden>
            i
          </span>
          {s.overall.samples} service samples, below the minimum of {s.minSample}. Treat the rates as indicative; the 95% ranges show how uncertain they are. Automating any decision needs a larger, representative set and explicit business approval.
        </div>
      )}

      <section>
        <h2>Headline (per service)</h2>
        <div className="tiles">
          <RateTile label="False approval rate" p={s.overall.falseApprovalRate} note="that should be rejected" compare={c?.overall.falseApprovalRate} />
          <RateTile label="False rejection rate" p={s.overall.falseRejectionRate} note="that should be approved" compare={c?.overall.falseRejectionRate} />
          <RateTile label="Precision (approvals right)" p={s.overall.precision} note="AI approvals" compare={c?.overall.precision} />
          <RateTile label="Recall (approvals found)" p={s.overall.recall} note="true approvals" compare={c?.overall.recall} />
          <RateTile label="Left to a person" p={s.overall.deferralRate} note="samples" compare={c?.overall.deferralRate} />
          <RateTile label="Right when it decided" p={s.overall.accuracyWhenDecided} note="decisions" compare={c?.overall.accuracyWhenDecided} />
        </div>
        {runs.length > 0 && (
          <div className="filters" style={{ marginTop: 12 }}>
            <select aria-label="Compare with" value={compareId} onChange={(e) => setCompareId(e.target.value)}>
              <option value="">Compare with another run…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label ?? new Date(r.requestedAt).toLocaleString()} · {String(r.versions?.visionModel ?? "")}
                </option>
              ))}
            </select>
            {compare && compare.summary && (
              <span className="muted" style={{ fontSize: 13 }}>
                Compared run: {compare.summary.examples} examples, model {String(compare.versions?.visionModel ?? "—")}
                {compare.summary.examples !== s.examples && " — different example sets, so differences may come from the data, not the model"}
              </span>
            )}
          </div>
        )}
      </section>

      <section style={{ display: "grid", gap: 20 }}>
        <MetricsTable title="By service" rows={s.byService} nameOf={(k) => k.replaceAll("_", " ")} />
        <MetricsTable title="Whole location (AI suggestion vs correct decision)" rows={{ "All locations": s.location }} />
        <MetricsTable title="By client" rows={s.byClient} />
        <MetricsTable title="By case type" rows={s.byTag} nameOf={(k) => TAG_LABEL[k] ?? k} />
        <MetricsTable title="By photo quality" rows={s.byImageQuality} nameOf={(k) => (k === "POOR" ? "Some photos unusable" : "All photos usable")} />
        <MetricsTable title="By AI confidence (calibration)" rows={s.byConfidence} nameOf={(k) => `${k[0]}${k.slice(1).toLowerCase()} confidence`} />
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>* fewer than {s.minSample} samples. Human override = the original reviewer decided differently from the AI.</p>
      </section>

      <section>
        <h2>Coverage</h2>
        <div className="coverage">
          {s.coverage.map((cv) => (
            <span key={cv.tag} className={`pill ${cv.examples === 0 ? "gap" : ""}`}>
              {TAG_LABEL[cv.tag] ?? cv.tag} · {cv.examples}
            </span>
          ))}
        </div>
        {s.missingCoverage.length > 0 && (
          <p className="muted" style={{ fontSize: 13 }}>
            Not covered: {s.missingCoverage.map((t) => TAG_LABEL[t] ?? t).join(", ")}. Results say nothing about these cases.
          </p>
        )}
      </section>

      <section>
        <h2>Versions evaluated</h2>
        <table className="list" style={{ maxWidth: 720 }}>
          <tbody>
            {[
              ["AI provider / model", `${v.visionProvider ?? "—"} · ${v.visionModel ?? "—"}`],
              ["Prompt", v.promptVersion ?? "—"],
              ["Service rules", v.serviceRuleVersion ?? "—"],
              ["Thresholds", v.thresholdsVersion ?? "—"],
              ["Application", v.applicationVersion ?? "—"],
            ].map(([k, val]) => (
              <tr key={k}>
                <td style={{ width: 200 }}>{k}</td>
                <td className="mono">{String(val)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Per example</h2>
        <label className="check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only mistakes and cases left to a person
        </label>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="list">
            <thead>
              <tr>
                <th>Example</th>
                <th>Service</th>
                <th>Correct</th>
                <th>AI said</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={`${r.exampleId}:${r.serviceCode}`}>
                  <td>
                    <Link to={`/evaluation/examples/${r.exampleId}`}>{r.title}</Link>
                  </td>
                  <td>{r.serviceCode?.replaceAll("_", " ")}</td>
                  <td>{r.expected === "APPROVE" ? "Approve" : "Reject"}</td>
                  <td>
                    {r.aiStatus ? (STATUS_LABEL[r.aiStatus] ?? r.aiStatus) : "—"}
                    {r.aiConfidence && <span className="muted"> · {r.aiConfidence.toLowerCase()}</span>}
                    {r.explanation && <div className="muted" style={{ fontSize: 12, maxWidth: 520 }}>{r.explanation}</div>}
                  </td>
                  <td>
                    <span className={`outcome o-${r.outcome.toLowerCase()}`}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span>
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No mistakes in this run.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
