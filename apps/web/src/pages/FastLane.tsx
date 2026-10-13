import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, imageUrl, type EvidenceResponse, type LocationRow } from "../api";
import { StatusTag, Toast } from "../components/bits";

interface Card {
  row: LocationRow;
  ev: EvidenceResponse;
}

/**
 * Fast Lane batch confirmation (automation level 3). Each card shows the strongest
 * evidence; confirming records one human approval per location.
 */
export function FastLanePage() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openedAt] = useState(() => new Date().toISOString());
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = () =>
    api<{ items: LocationRow[] }>("/api/locations?lane=FAST&limit=50").then(async (r) => {
      const loaded = await Promise.all(r.items.map(async (row) => ({ row, ev: await api<EvidenceResponse>(`/api/locations/${row.id}/evidence`) })));
      setCards(loaded);
      setSelected(new Set());
    });
  useEffect(() => {
    load();
  }, []);

  const confirm = async () => {
    setError(null);
    try {
      const r = await api<{ confirmed: number }>("/api/review/fast-lane/confirm", { method: "POST", body: { locationIds: [...selected], openedAt } });
      setToast(`Approved ${r.confirmed} location${r.confirmed === 1 ? "" : "s"}`);
      setTimeout(() => setToast(null), 2000);
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "FAST_LANE_DISABLED" ? "Quick approvals are switched off. An administrator can turn them on in AI settings." : err instanceof Error ? err.message : "Couldn't confirm.");
    }
  };

  if (!cards) return <div className="page muted">Loading…</div>;
  return (
    <div className="page" style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <div className="queue-head">
        <div>
          <h1>Quick approvals</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Every service has strong, independent evidence and low risk. Check each card, then approve the ones you agree with.
          </p>
        </div>
        {cards.length > 0 && (
          <button className="btn" onClick={() => setSelected(selected.size === cards.length ? new Set() : new Set(cards.map((c) => c.row.id)))}>
            {selected.size === cards.length ? "Clear selection" : `Select all (${cards.length})`}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {cards.length === 0 && <p className="muted">Nothing waiting for a quick approval right now.</p>}
      {cards.map(({ row, ev }) => (
        <article key={row.id} className="pair" style={{ gridTemplateColumns: "auto 1fr", alignItems: "start" }}>
          <input
            type="checkbox"
            aria-label={`Select ${row.externalId}`}
            checked={selected.has(row.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(row.id);
              else next.delete(row.id);
              setSelected(next);
            }}
            style={{ marginTop: 6 }}
          />
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
              <h3>{row.name ?? row.externalId}</h3>
              <span className="mono muted">{row.externalId}</span>
              <span className="muted">{row.clientName ?? row.client}</span>
              <Link to={`/review/${row.id}?lane=FAST`}>Open full review</Link>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {ev.services.map((s) => (
                <span key={s.service} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  {s.displayName} <StatusTag status={s.status} />
                </span>
              ))}
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
              {(ev.bundle?.entries ?? []).slice(0, 6).map((e) => (
                <img key={e.imageId} src={imageUrl(row.id, e.imageId)} alt={e.ref} style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: 10 }} loading="lazy" />
              ))}
            </div>
          </div>
        </article>
      ))}
      {selected.size > 0 && (
        <div className="action-bar" role="region" aria-label="Selected locations">
          <strong>{selected.size} selected</strong>
          <span className="muted">A share of quick approvals is checked again by a team lead.</span>
          <span style={{ flex: 1 }} />
          <button className="btn quiet" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button className="btn approve" onClick={confirm}>
            Approve {selected.size} selected
          </button>
        </div>
      )}
      <Toast text={toast} />
    </div>
  );
}
