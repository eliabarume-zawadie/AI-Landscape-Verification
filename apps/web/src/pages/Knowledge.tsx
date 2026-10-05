import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type KnowledgeNote, type NoteScopes } from "../api";
import { isLead, useAuth } from "../auth";
import { KIND_LABEL } from "../labels";

interface Draft {
  kind: string;
  title: string;
  body: string;
  clientId: string;
  serviceCode: string;
  source: string;
}
const EMPTY: Draft = { kind: "REVIEWER_NOTE", title: "", body: "", clientId: "", serviceCode: "", source: "" };

/** PRD §31 knowledge base: search for everyone; team leads add, revise and archive. */
export function KnowledgePage() {
  const { user } = useAuth();
  const lead = isLead(user);
  const [scopes, setScopes] = useState<NoteScopes>({ clients: [], services: [] });
  const [notes, setNotes] = useState<KnowledgeNote[] | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [clientId, setClientId] = useState("");
  const [serviceCode, setServiceCode] = useState("");
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api<NoteScopes>("/api/knowledge/scopes").then(setScopes).catch(() => undefined);
  }, []);

  useEffect(() => {
    const s = new URLSearchParams();
    if (q.trim()) s.set("q", q.trim());
    if (kind) s.set("kind", kind);
    if (clientId) s.set("clientId", clientId);
    if (serviceCode) s.set("serviceCode", serviceCode);
    if (archived) s.set("includeArchived", "true");
    let live = true;
    const timer = setTimeout(() => {
      api<{ notes: KnowledgeNote[] }>(`/api/knowledge?${s}`).then((r) => live && setNotes(r.notes));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, kind, clientId, serviceCode, archived, reload]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const d = editing.draft;
    const body = { kind: d.kind, title: d.title, body: d.body, clientId: d.clientId || null, serviceCode: d.serviceCode || null, source: d.source || null };
    try {
      await api(editing.id ? `/api/knowledge/${editing.id}/revise` : "/api/knowledge", { method: "POST", body });
      setMsg(editing.id ? "Note revised. The earlier version is kept in the archive." : "Note added.");
      setEditing(null);
      setReload((x) => x + 1);
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Couldn't save the note.");
    }
  };

  const archive = async (n: KnowledgeNote) => {
    const reason = window.prompt(`Why archive “${n.title}”?`);
    if (!reason?.trim()) return;
    try {
      await api(`/api/knowledge/${n.id}/archive`, { method: "POST", body: { reason } });
      setMsg("Note archived.");
      setReload((x) => x + 1);
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Couldn't archive the note.");
    }
  };

  const edit = (n: KnowledgeNote) =>
    setEditing({
      id: n.id,
      draft: { kind: n.kind, title: n.title, body: n.body, clientId: n.clientId ?? "", serviceCode: n.serviceCode ?? "", source: n.source ?? "" },
    });

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="queue-head">
        <div>
          <h1>Team knowledge</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Past review notes, client instructions and edge cases. Guidance only: client rules are set in the client profile, and notes never change them.
          </p>
        </div>
        {lead && !editing && (
          <button className="btn primary" onClick={() => setEditing({ id: null, draft: EMPTY })}>
            Add note
          </button>
        )}
      </div>
      {msg && <p className="muted">{msg}</p>}

      {editing && (
        <form className="note-form" onSubmit={save}>
          <h2>{editing.id ? "Revise note" : "New note"}</h2>
          {editing.id && <p className="muted" style={{ margin: 0 }}>Saving creates a new version; the current one is archived, not overwritten.</p>}
          <div className="note-form-row">
            <div className="field">
              <label htmlFor="n-kind">Kind</label>
              <select id="n-kind" value={editing.draft.kind} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, kind: e.target.value } })}>
                {Object.entries(KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="n-client">Client</label>
              <select id="n-client" value={editing.draft.clientId} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, clientId: e.target.value } })}>
                <option value="">All clients</option>
                {scopes.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="n-service">Service</label>
              <select id="n-service" value={editing.draft.serviceCode} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, serviceCode: e.target.value } })}>
                <option value="">All services</option>
                {scopes.services.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="n-title">Title</label>
            <input id="n-title" required maxLength={200} value={editing.draft.title} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, title: e.target.value } })} />
          </div>
          <div className="field">
            <label htmlFor="n-body">Note</label>
            <textarea id="n-body" required rows={5} maxLength={10000} value={editing.draft.body} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, body: e.target.value } })} />
          </div>
          <div className="field">
            <label htmlFor="n-source">Source (optional)</label>
            <input
              id="n-source"
              maxLength={300}
              placeholder="e.g. Weekly feedback 2026-09-28"
              value={editing.draft.source}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, source: e.target.value } })}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn primary">
              {editing.id ? "Save new version" : "Add note"}
            </button>
            <button type="button" className="btn quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="filters">
        <input aria-label="Search notes" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Any kind</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select aria-label="Client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Any client</option>
          {scopes.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Service" value={serviceCode} onChange={(e) => setServiceCode(e.target.value)}>
          <option value="">Any service</option>
          {scopes.services.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived
        </label>
      </div>

      {notes === null ? (
        <p className="muted">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="muted">{q || kind || clientId || serviceCode ? "No notes match. Try fewer words or filters." : lead ? "No notes yet. Add the first one, or import past notes (docs/KNOWLEDGE_BASE.md)." : "No notes yet."}</p>
      ) : (
        <div className="notes">
          {notes.map((n) => (
            <article key={n.id} className={`note ${n.archivedAt ? "archived" : ""}`}>
              <div className="note-head">
                <span className="pill">{KIND_LABEL[n.kind] ?? n.kind}</span>
                <h3>{n.title}</h3>
                {n.archivedAt && <span className="pill">archived{n.archiveReason ? `: ${n.archiveReason.toLowerCase()}` : ""}</span>}
                <span className="spacer" />
                {lead && !n.archivedAt && (
                  <>
                    <button className="btn quiet" onClick={() => edit(n)}>
                      Revise
                    </button>
                    <button className="btn quiet" onClick={() => archive(n)}>
                      Archive
                    </button>
                  </>
                )}
              </div>
              <p className="note-body">{n.body}</p>
              <p className="muted note-meta">
                {[n.clientName ?? "All clients", n.serviceName ?? "All services", n.authorName ? `by ${n.authorName}` : "imported", new Date(n.createdAt).toLocaleDateString(), n.source]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
