import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { DECISION_LABEL, SOURCE_LABEL, TAG_LABEL } from "../labels";

interface Example {
  id: string;
  title: string;
  clientName: string | null;
  source: string;
  sourceLocationId: string | null;
  services: string[];
  serviceNames: Record<string, string>;
  expected: Record<string, "APPROVE" | "REJECT">;
  tags: string[];
  reviewerDecision: string | null;
  reason: string | null;
  notes: string | null;
  status: "DRAFT" | "APPROVED" | "RETIRED";
  createdAt: string;
  createdByName: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  retireReason: string | null;
  images: { id: string; ordinal: number; externalRef: string; filename: string | null; capturedAt: string | null }[];
}

/** One golden example: check the correct answer, then approve (PRD §55). */
export function GoldenExamplePage() {
  const { id = "" } = useParams();
  const [ex, setEx] = useState<Example | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api<Example>(`/api/golden/${id}`).then(setEx).catch((err) => setMsg(err instanceof ApiError ? err.message : "Couldn't load the example."));
  }, [id, reload]);

  const call = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      setReload((x) => x + 1);
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Couldn't save.");
    }
  };
  const patch = (body: object, done = "Saved.") => call(() => api(`/api/golden/${id}`, { method: "PATCH", body }), done);

  if (!ex) return <div className="page muted">{msg ?? "Loading…"}</div>;
  const draft = ex.status === "DRAFT";

  return (
    <div className="page dash" style={{ maxWidth: 1100 }}>
      <div>
        <Link to="/evaluation">← Evaluation</Link>
        <h1 style={{ marginTop: 8 }}>{ex.title}</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {ex.clientName} · {SOURCE_LABEL[ex.source] ?? ex.source} · added by {ex.createdByName ?? "import"} {new Date(ex.createdAt).toLocaleDateString()}
          {ex.sourceLocationId && (
            <>
              {" · "}
              <Link to={`/locations/${ex.sourceLocationId}`}>original location</Link>
            </>
          )}
        </p>
      </div>

      <div className={`dx ${ex.status === "APPROVED" ? "dx-ok" : ex.status === "RETIRED" ? "dx-warn" : "dx-info"}`}>
        <span className="dx-icon" aria-hidden>
          {ex.status === "APPROVED" ? "✓" : ex.status === "RETIRED" ? "×" : "i"}
        </span>
        {ex.status === "DRAFT" && "Draft: check the correct answer for every service against the photos, then a second team lead approves it. Until then evaluations don’t use it."}
        {ex.status === "APPROVED" && `Approved by ${ex.approvedByName ?? "?"}${ex.approvedAt ? ` on ${new Date(ex.approvedAt).toLocaleDateString()}` : ""}. Locked: to correct it, retire it and add a new one.`}
        {ex.status === "RETIRED" && `Retired: ${ex.retireReason ?? ""}. Not used in evaluations.`}
      </div>
      {msg && <p className="muted">{msg}</p>}

      <section>
        <h2>Correct answer</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          What should have been decided, from these photos.{ex.reviewerDecision && ` The reviewer decided: ${(DECISION_LABEL[ex.reviewerDecision] ?? ex.reviewerDecision).toLowerCase()}${ex.reason ? ` (“${ex.reason}”)` : ""}.`}
        </p>
        <table className="list" style={{ maxWidth: 560 }}>
          <tbody>
            {ex.services.map((s) => (
              <tr key={s}>
                <td>{ex.serviceNames[s] ?? s}</td>
                <td style={{ width: 220 }}>
                  {draft ? (
                    <div className="seg" role="group" aria-label={`Correct answer for ${ex.serviceNames[s] ?? s}`}>
                      {(["APPROVE", "REJECT"] as const).map((v) => (
                        <button key={v} aria-pressed={ex.expected[s] === v} onClick={() => patch({ expected: { [s]: v } })}>
                          {v === "APPROVE" ? "Approve" : "Reject"}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <strong>{ex.expected[s] === "APPROVE" ? "Approve" : "Reject"}</strong>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Case types</h2>
        <div className="coverage">
          {Object.keys(TAG_LABEL)
            .filter((t) => t !== "UNTAGGED" && (draft || ex.tags.includes(t)))
            .map((t) =>
              draft ? (
                <label key={t} className="check pill-check">
                  <input type="checkbox" checked={ex.tags.includes(t)} onChange={(e) => patch({ tags: e.target.checked ? [...ex.tags, t] : ex.tags.filter((x) => x !== t) })} />
                  {TAG_LABEL[t]}
                </label>
              ) : (
                <span key={t} className="pill">
                  {TAG_LABEL[t]}
                </span>
              ),
            )}
        </div>
      </section>

      <section>
        <h2>Photos ({ex.images.length})</h2>
        <div className="grid">
          {ex.images.map((i) => (
            <a key={i.id} className="thumb" href={`/api/golden/images/${i.id}/content?variant=full`} target="_blank" rel="noreferrer">
              <img src={`/api/golden/images/${i.id}/content`} alt={i.externalRef} loading="lazy" />
              <span className="cap">
                <span className="mono">{i.externalRef}</span>
                {i.capturedAt && <span>{new Date(i.capturedAt).toLocaleString()}</span>}
              </span>
            </a>
          ))}
        </div>
      </section>

      {ex.notes && !draft && (
        <section>
          <h2>Notes</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{ex.notes}</p>
        </section>
      )}
      {draft && (
        <section>
          <h2>Notes</h2>
          <textarea
            aria-label="Notes"
            rows={3}
            style={{ width: "100%", maxWidth: 720 }}
            defaultValue={ex.notes ?? ""}
            onBlur={(e) => e.target.value !== (ex.notes ?? "") && patch({ notes: e.target.value })}
          />
        </section>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {draft && (
          <button className="btn primary" onClick={() => call(() => api(`/api/golden/${id}/approve`, { method: "POST" }), "Approved. Evaluations now use this example.")}>
            Approve the correct answer
          </button>
        )}
        {ex.status !== "RETIRED" && (
          <button
            className="btn quiet"
            onClick={() => {
              const reason = window.prompt("Why retire this example?");
              if (reason?.trim()) void call(() => api(`/api/golden/${id}/retire`, { method: "POST", body: { reason } }), "Retired.");
            }}
          >
            Retire
          </button>
        )}
      </div>
    </div>
  );
}
