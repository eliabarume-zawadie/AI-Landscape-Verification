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
      setError(err instanceof ApiError && err.code === "FAST_LANE_DISABLED" ? "The Fast Lane is turned off (automation level below 3)." : err instanceof Error ? err.message : "Couldn't confirm.");
    }
  };

  if (!cards) return <div className="page muted">Loading the Fast Lane…</div>;
  return (
    <div className="page" style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <div className="queue-head">
        <div>
          <h1>Fast lane</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Every service has strong, independent evidence and low risk. Check each card, then approve the ones you agree with.
          </p>
        </div>
        <button className="btn approve" disabled={selected.size === 0} onClick={confirm}>
          Approve {selected.size || ""} selected
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {cards.length === 0 && <p className="muted">Nothing in the Fast Lane right now.</p>}
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
              <span className="muted">{row.client}</span>
              <Link to={`/review/${row.id}?lane=FAST`}>Open full review</Link>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {ev.services.map((s) => (
                <span key={s.service} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  {s.displayName} <StatusTag status={s.status} />
                </span>
              ))}
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
              {(ev.bundle?.entries ?? []).slice(0, 6).map((e) => (
                <img key={e.imageId} src={imageUrl(row.id, e.imageId)} alt={e.ref} style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: 4 }} loading="lazy" />
              ))}
            </div>
          </div>
        </article>
      ))}
      <Toast text={toast} />
    </div>
  );
}
