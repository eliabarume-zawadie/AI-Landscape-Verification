import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type NoteScopes } from "../api";
import { RECOMMENDATION_LABEL } from "../labels";

interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
  suppressed: boolean;
}
interface Dashboard {
  period: { from: string; to: string; timezone: string; isToday: boolean };
  minSample: number;
  diagnosis: { level: "ok" | "info" | "warn"; text: string }[];
  queue: {
    received: number;
    aiProcessed: number;
    decided: number;
    escalated: number;
    completed: number;
    remaining: number;
    awaitingReview: number;
    inProgress: number;
    waitingForNetSuite: number;
    problems: number;
    clearance: Rate;
    oldestAwaitingReviewAt: string | null;
    oldestUnprocessedAt: string | null;
  };
  timing: { reviewsTimed: number; reviewSecondsMedian: number | null; reviewSecondsMean: number | null; processingSecondsPerLocation: number | null; processingSecondsPerImage: number | null };
  ai: {
    agreement: Rate;
    override: Rate;
    deferredToHuman: Rate;
    approveSuggestionsRejected: Rate;
    rejectSuggestionsApproved: Rate;
    falseApproval: { measured: false; reason: string };
    byConfidence: Record<string, Rate>;
    recommendations: Record<string, number>;
    imagesAnalyzed: Rate;
    imageQualityFailures: Rate;
    latencyMs: { mean: number | null; p95: number | null };
  };
  efficiency: {
    imagesPerLocation: number | null;
    photosOpenedPerLocation: number | null;
    decidedWithoutOpeningEveryPhoto: Rate;
    baselineReviewSeconds: number | null;
    timeSavedSecondsPerLocation: number | null;
    hoursSaved: number | null;
  };
  cost: {
    totalUsd: number;
    visionUsd: number;
    beforeAfterUsd: number;
    runs: number;
    perLocationUsd: number | null;
    perImageUsd: number | null;
    perDecidedLocationUsd: number | null;
    cacheHits: Rate;
    byClient: { client: string; runs: number; locations: number; costUsd: number; perLocationUsd: number }[];
  };
  netsuite: { sent: number; retrying: number; stopped: number; meanLatencyMs: number | null };
  health: { jobs: Record<string, number>; lastJobFinishedAt: string | null; openProblems: Record<string, number>; problemsLastHour: Record<string, number> };
  reviewers: { id: string; name: string; decisions: number; escalations: number; medianSeconds: number | null; override: Rate }[];
}

// ---------- formatting
const nf = new Intl.NumberFormat();
const n = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits }));
const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function secs(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v < 1) return "under 1 s";
  if (v < 10) return `${v.toFixed(1)} s`;
  if (v < 90) return `${Math.round(v)} s`;
  if (v < 5400) return `${Math.round(v / 60)} min`;
  return `${(v / 3600).toFixed(1)} h`;
}
function since(iso: string | null): string {
  if (!iso) return "—";
  return secs((Date.now() - new Date(iso).getTime()) / 1000);
}
const ms = (v: number | null) => (v === null ? "—" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
const pct = (r: Rate) => (r.value === null ? null : `${Math.round(r.value * 100)}%`);

function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgo(k: number) {
  const d = new Date();
  d.setDate(d.getDate() - k);
  return localDate(d);
}

// ---------- pieces
function Tile({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && <span className="tile-note">{note}</span>}
    </div>
  );
}

/** A rate tile that refuses to show a percentage below the minimum sample. */
function RateTile({ label, r, min, of }: { label: string; r: Rate; min: number; of: string }) {
  const v = pct(r);
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      {v !== null ? (
        <>
          <span className="tile-value">{v}</span>
          <span className="tile-note">
            {nf.format(r.numerator)} of {nf.format(r.denominator)} {of}
          </span>
        </>
      ) : (
        <>
          <span className="tile-value muted-value">Not enough data</span>
          <span className="tile-note">
            {r.denominator === 0 ? `No ${of} yet` : `${nf.format(r.denominator)} ${of}; needs ${min}`}
          </span>
        </>
      )}
    </div>
  );
}

/** Single-series horizontal bars, 0–max scale, direct-labelled. */
function Bars({ rows, format, max, caption }: { rows: { label: string; value: number | null; note?: string }[]; format(v: number): string; max?: number; caption: string }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <table className="bars" aria-label={caption}>
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            <td>
              {r.value === null ? (
                <span className="muted">{r.note ?? "Not enough data"}</span>
              ) : (
                <span className="bar-row" title={`${r.label}: ${format(r.value)}${r.note ? ` (${r.note})` : ""}`}>
                  <span className="bar-track">
                    <span className="bar-fill" style={{ width: r.value > 0 ? `${Math.max(1.5, (r.value / top) * 100)}%` : 0 }} />
                  </span>
                  <span className="bar-value">{format(r.value)}</span>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const LEVEL = { warn: { icon: "!", word: "Attention" }, info: { icon: "i", word: "Note" }, ok: { icon: "✓", word: "OK" } } as const;

/** PRD §44 team lead dashboard. */
export function DashboardPage() {
  const [from, setFrom] = useState(localDate(new Date()));
  const [to, setTo] = useState(localDate(new Date()));
  const [client, setClient] = useState("");
  const [service, setService] = useState("");
  const [risk, setRisk] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [scopes, setScopes] = useState<{ clients: { id: string; name: string }[]; reviewers: { id: string; name: string }[] }>({ clients: [], reviewers: [] });
  const [services, setServices] = useState<NoteScopes["services"]>([]);
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api<typeof scopes>("/api/dashboard/scopes").then(setScopes).catch(() => undefined);
    api<NoteScopes>("/api/knowledge/scopes").then((s) => setServices(s.services)).catch(() => undefined);
  }, []);

  const query = useMemo(() => {
    const s = new URLSearchParams({ from, to });
    if (client) s.set("client", client);
    if (service) s.set("service", service);
    if (risk) s.set("risk", risk);
    if (reviewer) s.set("reviewer", reviewer);
    return s.toString();
  }, [from, to, client, service, risk, reviewer]);

  useEffect(() => {
    let live = true;
    setError(null);
    api<Dashboard>(`/api/dashboard?${query}`)
      .then((r) => live && setD(r))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Couldn't load the dashboard."));
    return () => {
      live = false;
    };
  }, [query, tick]);

  // Today's view refreshes every minute.
  useEffect(() => {
    if (!d?.period.isToday) return;
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [d?.period.isToday]);

  const preset = (k: number) => {
    setFrom(daysAgo(k));
    setTo(localDate(new Date()));
  };
  const label = d ? (d.period.isToday ? "Today" : d.period.from === d.period.to ? d.period.from : `${d.period.from} – ${d.period.to}`) : "";

  return (
    <div className="page dash">
      <div className="queue-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Is the queue clearing, and if not, why. Rates appear once there are at least {d?.minSample ?? 30} cases.
          </p>
        </div>
      </div>

      <div className="filters" role="group" aria-label="Filters">
        <div className="seg" role="group" aria-label="Period">
          <button aria-pressed={from === to && to === localDate(new Date())} onClick={() => preset(0)}>
            Today
          </button>
          <button aria-pressed={from === daysAgo(6) && to === localDate(new Date())} onClick={() => preset(6)}>
            7 days
          </button>
          <button aria-pressed={from === daysAgo(29) && to === localDate(new Date())} onClick={() => preset(29)}>
            30 days
          </button>
        </div>
        <input type="date" aria-label="From date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <input type="date" aria-label="To date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        <select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">All clients</option>
          {scopes.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Service" value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">All services</option>
          {services.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
        <select aria-label="Risk" value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="">Any risk</option>
          <option value="HIGH">High risk</option>
          <option value="MEDIUM">Medium risk</option>
          <option value="LOW">Low risk</option>
        </select>
        <select aria-label="Reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
          <option value="">All reviewers</option>
          {scopes.reviewers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error">{error}</p>}
      {!d ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
          <section className="dash-top">
            <div className="hero">
              <span className="tile-label">Still open now</span>
              <span className="hero-value">{nf.format(d.queue.remaining)}</span>
              <span className="tile-note">
                {d.queue.clearance.value !== null
                  ? `${Math.round(d.queue.clearance.value * 100)}% cleared · ${nf.format(d.queue.decided)} decided ${label.toLowerCase() === "today" ? "today" : "in this period"}`
                  : "Nothing received or decided in this period"}
              </span>
            </div>
            <ul className="diagnosis" aria-label="Why the queue is or isn't clearing">
              {d.diagnosis.map((x) => (
                <li key={x.text} className={`dx dx-${x.level}`}>
                  <span className="dx-icon" aria-hidden>
                    {LEVEL[x.level].icon}
                  </span>
                  <span className="sr-only">{LEVEL[x.level].word}: </span>
                  {x.text}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Queue · {label}</h2>
            <div className="tiles">
              <Tile label="Locations received" value={nf.format(d.queue.received)} />
              <Tile label="AI processed" value={nf.format(d.queue.aiProcessed)} />
              <Tile label="Decided" value={nf.format(d.queue.decided)} note={d.queue.escalated ? `${d.queue.escalated} escalated` : undefined} />
              <Tile label="Completed in NetSuite" value={nf.format(d.queue.completed)} />
              <Tile label="Waiting for a reviewer" value={nf.format(d.queue.awaitingReview)} note={d.queue.oldestAwaitingReviewAt ? `oldest waiting ${since(d.queue.oldestAwaitingReviewAt)}` : undefined} />
              <Tile label="Being analysed" value={nf.format(d.queue.inProgress)} note={d.queue.oldestUnprocessedAt ? `oldest received ${since(d.queue.oldestUnprocessedAt)} ago` : undefined} />
              <Tile label="Problems" value={nf.format(d.queue.problems)} />
              <Tile label="On the way to NetSuite" value={nf.format(d.queue.waitingForNetSuite)} />
            </div>
          </section>

          <section>
            <h2>Time</h2>
            <div className="tiles">
              <Tile label="Review time per location" value={secs(d.timing.reviewSecondsMedian)} note={d.timing.reviewsTimed ? `median of ${d.timing.reviewsTimed} timed reviews` : "no timed reviews"} />
              <Tile label="AI processing per location" value={secs(d.timing.processingSecondsPerLocation)} note="average" />
              <Tile label="AI processing per photo" value={secs(d.timing.processingSecondsPerImage)} note="average" />
              <Tile
                label="Reviewer time saved"
                value={d.efficiency.hoursSaved !== null ? `${n(d.efficiency.hoursSaved, 1)} h` : "Not set up"}
                note={
                  d.efficiency.baselineReviewSeconds !== null
                    ? `${secs(d.efficiency.timeSavedSecondsPerLocation)} saved per location (it took ${secs(d.efficiency.baselineReviewSeconds)} before ALVIP)`
                    : "Needs the review time before ALVIP (METRICS_BASELINE_REVIEW_SECONDS)"
                }
              />
            </div>
          </section>

          <section>
            <h2>AI and reviewers</h2>
            <div className="tiles">
              <RateTile label="Reviewers agreed with the AI" r={d.ai.agreement} min={d.minSample} of="AI suggestions" />
              <RateTile label="Decisions against the AI" r={d.ai.override} min={d.minSample} of="decisions" />
              <RateTile label="AI left the call to a person" r={d.ai.deferredToHuman} min={d.minSample} of="decisions" />
              <RateTile label="“Approve” suggestions rejected" r={d.ai.approveSuggestionsRejected} min={d.minSample} of="approve suggestions" />
              <div className="tile">
                <span className="tile-label">False approval rate</span>
                <span className="tile-value muted-value">Not measured yet</span>
                <span className="tile-note">{d.ai.falseApproval.reason}</span>
              </div>
              <RateTile label="Photos analysed by the AI" r={d.ai.imagesAnalyzed} min={d.minSample} of="photos sent" />
              <RateTile label="Photos failing quality checks" r={d.ai.imageQualityFailures} min={d.minSample} of="photos" />
              <Tile label="AI response time per photo" value={ms(d.ai.latencyMs.mean)} note={d.ai.latencyMs.p95 !== null ? `95% within ${ms(d.ai.latencyMs.p95)}` : undefined} />
            </div>
            <div className="dash-cols">
              <div>
                <h3>Agreement with reviewers, by AI confidence</h3>
                <p className="muted chart-note">Per service. Agreement with reviewers, not proven accuracy.</p>
                <Bars
                  caption="Agreement with reviewers by AI confidence"
                  max={1}
                  format={(v) => `${Math.round(v * 100)}%`}
                  rows={(["HIGH", "MEDIUM", "LOW"] as const).map((band) => {
                    const r = d.ai.byConfidence[band]!;
                    return {
                      label: `${band[0]}${band.slice(1).toLowerCase()} confidence`,
                      value: r.value,
                      note: r.value === null ? `Not enough data (${r.denominator} of ${d.minSample})` : `${r.numerator} of ${r.denominator}`,
                    };
                  })}
                />
              </div>
              <div>
                <h3>AI suggestions</h3>
                <p className="muted chart-note">Locations the AI finished in this period.</p>
                <Bars
                  caption="AI suggestions"
                  format={(v) => nf.format(v)}
                  rows={["RECOMMEND_APPROVE", "NEEDS_HUMAN_REVIEW", "RECOMMEND_REJECT"].map((k) => ({ label: RECOMMENDATION_LABEL[k] ?? k, value: d.ai.recommendations[k] ?? 0 }))}
                />
              </div>
            </div>
          </section>

          <section>
            <h2>Effort</h2>
            <div className="tiles">
              <Tile label="Photos per location" value={n(d.efficiency.imagesPerLocation, 1)} note="average, decided locations" />
              <Tile label="Photos opened full size" value={n(d.efficiency.photosOpenedPerLocation, 1)} note="average per decision" />
              <RateTile label="Decided without opening every photo" r={d.efficiency.decidedWithoutOpeningEveryPhoto} min={d.minSample} of="decisions" />
            </div>
          </section>

          <section>
            <h2>AI cost</h2>
            <div className="tiles">
              <Tile label="Total" value={usd(d.cost.totalUsd)} note={`${d.cost.runs} processing runs`} />
              <Tile label="Per location" value={usd(d.cost.perLocationUsd)} />
              <Tile label="Per photo" value={usd(d.cost.perImageUsd)} />
              <Tile label="Per decided location" value={usd(d.cost.perDecidedLocationUsd)} note="cost in period ÷ decisions in period" />
              <Tile label="Photo analysis / before-after" value={`${usd(d.cost.visionUsd)} / ${usd(d.cost.beforeAfterUsd)}`} />
              <RateTile label="Photo results reused (cache)" r={d.cost.cacheHits} min={d.minSample} of="analysed photos" />
            </div>
            {d.cost.byClient.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="list">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th className="num">Locations</th>
                    <th className="num">Runs</th>
                    <th className="num">AI cost</th>
                    <th className="num">Per location</th>
                  </tr>
                </thead>
                <tbody>
                  {d.cost.byClient.map((c) => (
                    <tr key={c.client}>
                      <td>{c.client}</td>
                      <td className="num">{nf.format(c.locations)}</td>
                      <td className="num">{nf.format(c.runs)}</td>
                      <td className="num">{usd(c.costUsd)}</td>
                      <td className="num">{usd(c.perLocationUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>

          <section>
            <h2>Reviewers</h2>
            {d.reviewers.length === 0 ? (
              <p className="muted">No decisions in this period.</p>
            ) : (
              <div className="table-wrap">
              <table className="list">
                <thead>
                  <tr>
                    <th>Reviewer</th>
                    <th className="num">Decisions</th>
                    <th className="num">Escalated</th>
                    <th className="num">Median time</th>
                    <th className="num">Against the AI</th>
                  </tr>
                </thead>
                <tbody>
                  {d.reviewers.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td className="num">{nf.format(r.decisions)}</td>
                      <td className="num">{nf.format(r.escalations)}</td>
                      <td className="num">{secs(r.medianSeconds)}</td>
                      <td className="num">{pct(r.override) ?? <span className="muted">{r.override.denominator} decisions</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>

          <section>
            <h2>System health</h2>
            <div className="tiles">
              <Tile label="NetSuite writes sent" value={nf.format(d.netsuite.sent)} note={d.netsuite.meanLatencyMs !== null ? `average ${n(d.netsuite.meanLatencyMs)} ms` : undefined} />
              <Tile label="NetSuite writes retrying" value={nf.format(d.netsuite.retrying)} />
              <Tile label="NetSuite writes stopped" value={nf.format(d.netsuite.stopped)} />
              <Tile label="Jobs waiting" value={nf.format((d.health.jobs.PENDING ?? 0) + (d.health.jobs.RUNNING ?? 0))} note={`last finished ${d.health.lastJobFinishedAt ? `${since(d.health.lastJobFinishedAt)} ago` : "never"}`} />
              <Tile label="Failed jobs (all time)" value={nf.format(d.health.jobs.DEAD ?? 0)} />
              <Tile
                label="Open problems"
                value={nf.format(Object.values(d.health.openProblems).reduce((a, b) => a + b, 0))}
                note={Object.entries(d.health.openProblems).map(([k, v]) => `${v} ${k.toLowerCase().replaceAll("_", " ")}`).join(" · ") || undefined}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
