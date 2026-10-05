# Team knowledge base (PRD §31)

Reviewer guidance: past review notes, service definitions, client instructions, edge cases, weekly feedback and historical examples.

## What notes do, and what they never do

- **Do:** notes appear in the review screen ("Notes from the team") when they match the location's client (or all clients) and one of its required services (or all services). They are also searchable on the **Team knowledge** page.
- **Never:** notes do not change how a location is assessed.
  - **Pipeline:** the evidence engine, the risk engine and the recommendation never read them.
  - **Client rules:** these come only from the versioned client profiles in `config/client-profiles/`. Changing a rule is a deliberate, audited config change.
  - **Labelling:** the UI marks notes as guidance that doesn't change the client's current rules.
- **Other clients:** a client's notes are never shown on another client's locations.
- **The AI:** notes are not sent to the AI. Adding them to prompts would change model behaviour, so it needs a measured evaluation first (Phase 13, `docs/AI_EVALUATION.md`), and the notes must stay subordinate to the active client configuration.

## Who can do what

| Action | Role |
|---|---|
| Read / search | Everyone signed in |
| Add, revise, archive | Team lead, admin |

Nothing is overwritten:
- **Revising** creates a new note that supersedes the old one, and archives the old one ("Revised").
- **Archiving** needs a reason.
- **The database** refuses any change to a note's content and any deletion (trigger `knowledge_notes_guard`). Archiving a note once is the only update allowed.
- **Audit:** every addition and archive is recorded (`KNOWLEDGE_NOTE_CREATED`, `KNOWLEDGE_NOTE_ARCHIVED`).

## Kinds

| Code | Shown as |
|---|---|
| `REVIEWER_NOTE` | Reviewer note |
| `SERVICE_DEFINITION` | Service definition |
| `CLIENT_INSTRUCTION` | Client instruction |
| `EDGE_CASE` | Edge case |
| `WEEKLY_FEEDBACK` | Weekly feedback |
| `HISTORICAL_EXAMPLE` | Past example |

## Importing historical notes

The format of the existing reviewer notes is not known yet (IMPLEMENTATION_PLAN U10). Until it is, convert them to this JSON format and import them:

```bash
npm run knowledge:import -- path/to/notes.json
```

Stop `npm run dev` first. Like every command that opens the local database, the import can't run while the server is using it.

```json
[
  {
    "kind": "CLIENT_INSTRUCTION",
    "title": "Short title",
    "body": "The note itself.",
    "client": "DEMO_CLIENT_A",
    "service": "edging",
    "source": "Where it came from (optional)"
  }
]
```

- `kind`, `title` and `body` are required.
- `client`: a client code from `config/client-profiles/`. Omit it for notes that apply to all clients.
- `service`: a service code from `config/services.json`. Omit it for notes that apply to all services.
- `source`: optional. It defaults to `Import: <file name>`.
- **All-or-nothing:** if any note is invalid (unknown kind, client or service, empty text), nothing is imported and every problem is listed.
- **Safe to re-run:** notes already present (same kind, scope, title and text) are skipped.

`docs/examples/knowledge-notes.example.json` is a working example.
