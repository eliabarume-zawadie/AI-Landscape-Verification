import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, imageUrl, type EvidenceResponse, type ImageItem, type KnowledgeNote, type LocationDetail, type PairView, type ServiceView } from "../api";
import { isLead, useAuth } from "../auth";
import { ImageViewer, RiskTag, StatusTag, Toast, WipeCompare, type ViewerItem } from "../components/bits";
import { DecisionBar, type Decision } from "../components/DecisionBar";
import { age, engineReason, KIND_LABEL, LOCATION_STATUS_LABEL, RECOMMENDATION_LABEL, ROLE_LABEL, rolesCaption, STATUS_LABEL } from "../labels";

const MAX_FLAGS = 10;

type Tab = "bundle" | "pairs" | "all";

export function ReviewPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const lane = (params.get("lane") as "HUMAN_REVIEW" | "FAST" | null) ?? null;
  const navigate = useNavigate();
  const { user } = useAuth();

  const [detail, setDetail] = useState<LocationDetail | null>(null);
  const [ev, setEv] = useState<EvidenceResponse | null>(null);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [openedAt, setOpenedAt] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>("bundle");
  const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(new Set());
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);

  const toggleFlag = useCallback((imageId: string) => {
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(imageId)) next.delete(imageId);
      else if (next.size < MAX_FLAGS) next.add(imageId);
      return next;
    });
  }, []);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setEv(null);
    setError(null);
    setTab("bundle");
    setFlagged(new Set());
    setNotes([]);
    // Guidance only; the review works without it.
    api<{ notes: KnowledgeNote[] }>(`/api/locations/${id}/knowledge`)
      .then((r) => live && setNotes(r.notes))
      .catch(() => undefined);
    Promise.all([
      api<LocationDetail>(`/api/locations/${id}`),
      api<EvidenceResponse>(`/api/locations/${id}/evidence`),
      api<{ items: ImageItem[] }>(`/api/locations/${id}/images?order=evidence`),
      api<{ openedAt: string }>(`/api/locations/${id}/review/open`, { method: "POST" }),
    ])
      .then(([d, e, i, o]) => {
        if (!live) return;
        setDetail(d);
        setEv(e);
        setImages(i.items);
        setOpenedAt(o.openedAt);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Couldn't load this location."));
    return () => {
      live = false;
    };
  }, [id]);

  const goNext = useCallback(async () => {
    const q = new URLSearchParams({ after: id, ...(lane ? { lane } : {}) });
    const r = await api<{ locationId: string | null }>(`/api/review/next?${q}`);
    if (r.locationId) navigate(`/review/${r.locationId}${lane ? `?lane=${lane}` : ""}`);
    else navigate(`/${lane ? `?lane=${lane}` : ""}`, { state: { message: "Nothing left in this lane." } });
  }, [id, lane, navigate]);

  const decide = useCallback(
    async (decision: Decision, reason?: { code: string; text: string }) => {
      setBusy(true);
      setError(null);
      try {
        await api(`/api/locations/${id}/review`, {
          method: "POST",
          body: {
            decision,
            openedAt,
            ...(reason ? { reasonCode: reason.code, ...(reason.text.trim() ? { reasonText: reason.text.trim() } : {}) } : {}),
            ...(reason && flagged.size ? { relevantImageIds: [...flagged] } : {}),
          },
        });
        setToast(decision === "APPROVE" ? "Approved" : decision === "REJECT" ? "Rejected" : "Escalated to a team lead");
        setTimeout(() => setToast(null), 1800);
        await goNext();
      } catch (err) {
        setError(err instanceof ApiError ? (err.status === 409 ? "Someone else already decided this location." : err.message) : "Couldn't save the decision. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [id, openedAt, goNext, flagged],
  );

  const openViewer = (items: ViewerItem[], imageId: string) => setViewer({ items, index: Math.max(0, items.findIndex((x) => x.imageId === imageId)) });

  if (error && !detail) {
    return (
      <div className="page">
        <p className="error">{error}</p>
        <Link to="/">Back to the queue</Link>
      </div>
    );
  }
  if (!detail || !ev) return <div className="page muted">Loading location…</div>;

  const loc = detail.location;
  const hidden = !!ev.aiHidden;
  const view: Tab = hidden ? "all" : tab;
  const decidable = loc.status === "HUMAN_REVIEW" || (loc.status === "ESCALATED" && isLead(user));
  const bundleItems: ViewerItem[] = (ev.bundle?.entries ?? []).map((e) => ({
    imageId: e.imageId,
    ref: e.ref,
    caption: rolesCaption(e.services),
  }));
  const allItems: ViewerItem[] = images.filter((i) => i.contentAvailable).map((i) => ({ imageId: i.id, ref: i.externalRef }));
  const confirmedPairs = (ev.pairs ?? []).filter((p) => p.status === "CONFIRMED");
  const ai = { recommendation: ev.recommendation?.value ?? null, services: ev.services.map((s) => ({ service: s.service, status: s.status, confidence: s.confidence })) };
  const flaggedList = [...flagged].map((imageId) => ({ imageId, ref: images.find((i) => i.id === imageId)?.externalRef ?? imageId }));

  return (
    <div className="review">
      <header className="review-head">
        <div>
          <div className="muted mono">{loc.externalId}</div>
          <h1>{loc.name ?? loc.externalId}</h1>
        </div>
        <div className="meta">
          <span>{loc.clientName}</span>
          <span>{detail.services.length} required service{detail.services.length === 1 ? "" : "s"}</span>
          <span>{images.length} photos</span>
          <span>in queue {age(loc.receivedAt)}</span>
          <span>{LOCATION_STATUS_LABEL[loc.status] ?? loc.status}</span>
        </div>
        <span style={{ flex: 1 }} />
        <RiskTag level={ev.risk?.level ?? null} />
        <Link to={`/locations/${loc.id}`} className="btn quiet">
          Details & history
        </Link>
      </header>

      <div className="review-body">
        <aside className="ledger" aria-label="AI assessment">
          {hidden ? (
            <>
              <div className="recommend">
                <strong>Decide from the photos</strong>
                <span>AI suggestions are switched off for this location while the AI is being trialled in the background. Check each required service in the photos.</span>
              </div>
              <section style={{ display: "grid", gap: 8 }}>
                <h2>Required services</h2>
                <ul className="factors">
                  {(ev.requiredServices ?? []).map((s) => (
                    <li key={s.service}>{s.displayName}</li>
                  ))}
                </ul>
              </section>
            </>
          ) : ev.recommendation ? (
            <div className={`recommend ${ev.recommendation.value === "RECOMMEND_APPROVE" ? "approve" : ev.recommendation.value === "RECOMMEND_REJECT" ? "reject" : ""}`}>
              <strong>{RECOMMENDATION_LABEL[ev.recommendation.value] ?? ev.recommendation.value}</strong>
              <span>{ev.recommendation.explanation}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                A suggestion only — you make the decision.
              </span>
            </div>
          ) : (
            <div className="recommend">
              <strong>No AI assessment</strong>
              <span>Review the photos directly.</span>
            </div>
          )}

          {!hidden && ev.risk && ev.risk.factors.length > 0 && (
            <section>
              <h2>Why it needs attention</h2>
              <ul className="factors">
                {ev.risk.factors.map((f) => (
                  <li key={f.factor}>{f.detail}</li>
                ))}
              </ul>
            </section>
          )}

          {!hidden && (
          <section style={{ display: "grid", gap: 14 }}>
            <h2>Required services</h2>
            {ev.services.map((s) => (
              <ServiceLedger key={s.service} s={s} onOpen={(imageId) => openViewer(bundleItems.length ? bundleItems : allItems, imageId)} />
            ))}
          </section>
          )}
          {notes.length > 0 && <TeamNotes notes={notes} />}
          {ev.thresholdsProvisional && <p className="muted" style={{ fontSize: 12, margin: 0 }}>Thresholds are provisional until validated on real data.</p>}
        </aside>

        <section className="evidence" aria-label="Evidence">
          <div className="tabs" role="tablist">
            {!hidden && (
              <>
            <button role="tab" aria-selected={tab === "bundle"} onClick={() => setTab("bundle")}>
              Strongest evidence ({ev.bundle?.entries.length ?? 0})
            </button>
            <button role="tab" aria-selected={tab === "pairs"} onClick={() => setTab("pairs")}>
              Before / after ({confirmedPairs.length})
            </button>
              </>
            )}
            <button role="tab" aria-selected={view === "all"} onClick={() => setTab("all")}>
              All photos ({images.length})
            </button>
          </div>

          {view === "bundle" &&
            (bundleItems.length ? (
              <div className="grid">
                {(ev.bundle?.entries ?? []).map((e) => {
                  const against = e.services.some((s) => s.role === "CONTRADICTING");
                  return (
                    <button key={e.imageId} className={`thumb ${against ? "against" : ""}`} onClick={() => openViewer(bundleItems, e.imageId)}>
                      <img src={imageUrl(loc.id, e.imageId)} alt={e.ref} loading="lazy" />
                      <span className="cap">
                        <span className="mono">{e.ref}</span>
                        <span>{rolesCaption(e.services)}</span>
                        {flagged.has(e.imageId) && <span className="pill flag">flagged</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="muted">No photo counts as evidence for the required services. Check “All photos”.</p>
            ))}

          {view === "pairs" &&
            (confirmedPairs.length ? (
              confirmedPairs.map((p) => <PairCard key={p.id} p={p} locationId={loc.id} />)
            ) : (
              <p className="muted">No before/after pair was confirmed for this location. {(ev.pairs ?? []).length > 0 && `${ev.pairs!.length} candidate pair(s) showed different areas.`}</p>
            ))}

          {view === "all" && (
            <div className="grid">
              {images.map((i) => (
                <button
                  key={i.id}
                  className="thumb"
                  onClick={() => i.contentAvailable && openViewer(allItems, i.id)}
                  disabled={!i.contentAvailable}
                  title={i.analysis?.issues.join(", ")}
                >
                  {i.contentAvailable ? <img src={imageUrl(loc.id, i.id)} alt={i.externalRef} loading="lazy" /> : <div style={{ aspectRatio: "4/3" }} />}
                  <span className="cap">
                    <span className="mono">{i.externalRef}</span>
                    <span>
                      {i.analysis?.stage && i.analysis.stage !== "UNKNOWN" && <span className="pill">{i.analysis.stage.toLowerCase()}</span>}{" "}
                      {i.inBundle && <span className="pill">evidence</span>}{" "}
                      {i.analysis?.duplicateKind && <span className="pill">duplicate</span>}{" "}
                      {flagged.has(i.id) && <span className="pill flag">flagged</span>}
                    </span>
                    {i.analysis && !i.analysis.usable && <span className="unusable">Not usable: {i.analysis.issues.join(", ").toLowerCase().replaceAll("_", " ")}</span>}
                    {i.downloadError && <span className="unusable">Missing from source</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {decidable ? (
        <DecisionBar
          ai={ai}
          busy={busy}
          canEscalate={loc.status === "HUMAN_REVIEW"}
          serverError={error}
          flagged={flaggedList}
          onClearFlags={() => setFlagged(new Set())}
          onDecide={decide}
          onSkip={goNext}
        />
      ) : (
        <div className="decision">
          <span>
            This location is <strong>{(LOCATION_STATUS_LABEL[loc.status] ?? loc.status).toLowerCase()}</strong>
            {loc.status === "ESCALATED" ? " — a team lead decides." : "."}
          </span>
          <span className="spacer" />
          <button className="btn quiet" onClick={goNext}>
            Next location <kbd>N</kbd>
          </button>
        </div>
      )}

      {viewer && (
        <ImageViewer
          locationId={loc.id}
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          {...(decidable ? { flagged, onToggleFlag: toggleFlag } : {})}
        />
      )}
      <Toast text={toast} />
    </div>
  );
}

/** PRD §31: reviewer guidance for this client and these services. Never a rule. */
function TeamNotes({ notes }: { notes: KnowledgeNote[] }) {
  return (
    <section className="team-notes" aria-label="Notes from the team">
      <h2>Notes from the team</h2>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        Guidance from past reviews. The client’s current rules decide; these notes don’t change them.
      </p>
      {notes.map((n) => (
        <details key={n.id}>
          <summary>
            <span className="pill">{KIND_LABEL[n.kind] ?? n.kind}</span> {n.title}
          </summary>
          <p>{n.body}</p>
          <p className="muted" style={{ fontSize: 12 }}>
            {[n.clientName ?? "All clients", n.serviceName ?? "all services", n.source].filter(Boolean).join(" · ")}
          </p>
        </details>
      ))}
      <Link to="/knowledge" className="muted" style={{ fontSize: 13 }}>
        Search all notes
      </Link>
    </section>
  );
}

function ServiceLedger({ s, onOpen }: { s: ServiceView; onOpen(imageId: string): void }) {
  return (
    <article className="svc">
      <div className="svc-head">
        <h3>{s.displayName}</h3>
        <StatusTag status={s.status} />
      </div>
      <p>{s.explanation}</p>
      {s.reasons.length > 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          {s.reasons.map(engineReason).join(" · ")}
        </p>
      )}
      {s.components && (
        <p className="muted" style={{ fontSize: 13 }}>
          {Object.entries(s.components)
            .map(([c, st]) => `${c.replaceAll("_", " ")}: ${(STATUS_LABEL[st] ?? st).toLowerCase()}`)
            .join(" · ")}
        </p>
      )}
      {s.bundle.length > 0 && (
        <div className="refs">
          {s.bundle.map((b) => (
            <button key={b.imageId} className={`ref ${b.roles.includes("CONTRADICTING") ? "against" : ""}`} onClick={() => onOpen(b.imageId)} title={b.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")}>
              {b.ref.replace(/^.*-(IMG\d+)$/, "$1")}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function PairCard({ p, locationId }: { p: PairView; locationId: string }) {
  return (
    <article className="pair pair-split">
      <WipeCompare locationId={locationId} beforeId={p.beforeImageId} afterId={p.afterImageId} beforeRef={p.beforeRef ?? "before"} afterRef={p.afterRef ?? "after"} />
      <div className="pair-notes">
        <div className="muted mono" style={{ fontSize: 12 }}>
          {p.beforeRef}
          <br />→ {p.afterRef}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          Same area ({p.sameAreaConfidence?.toLowerCase()} confidence){p.notes ? `: ${p.notes}` : ""}
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Drag the divider, or focus it and use ← →.
        </p>
      {p.changes.length > 0 && (
        <ul className="changes">
          {p.changes.map((c) => (
            <li key={c.service}>
              <strong>{c.service.replaceAll("_", " ")}</strong>: {c.direction === "IMPROVED" ? "improved" : c.direction === "WORSENED" ? "looks worse" : "no visible change"} — {c.description}
            </li>
          ))}
        </ul>
      )}
      </div>
    </article>
  );
}
