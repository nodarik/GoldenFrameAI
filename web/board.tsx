// Scenes board: one column per next step (set up, inspect, review, fix, done), plus the add/edit/delete dialogs.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { COLUMNS, type SceneSummary, ago, api, columnOf, plural } from "./api.js";

export function Board({ scenes, group, onChange }: { scenes: SceneSummary[] | null; group: string | null; onChange: () => void }) {
  const [editing, setEditing] = useState<SceneSummary | "new" | null>(null);
  const [deleting, setDeleting] = useState<SceneSummary | null>(null);
  const shown = (scenes ?? []).filter((s) => group === null || s.group === group);
  const byColumn = new Map(COLUMNS.map((c) => [c.id, shown.filter((s) => columnOf(s) === c.id)]));
  const reviewed = byColumn.get("reviewed")!.length;

  return (
    <>
      <header className="page-head">
        <div>
          <div className="row">
            <h1>{group ?? "All scenes"}</h1>
            <span className="live">Live</span>
          </div>
          <p className="muted">Every scene's golden photo, its latest inspection and what a person has to do next.</p>
        </div>
        <div className="head-stats">
          <div><b>{byColumn.get("review")!.length}</b><span>To review</span></div>
          <div><b>{reviewed}</b><span>Reviewed</span></div>
          <div><b>{shown.length}</b><span>Total</span></div>
          <button className="primary" onClick={() => setEditing("new")}>+ Add scene</button>
        </div>
      </header>

      {scenes && scenes.length === 0 && (
        <div className="empty">
          <h2>Add your first scene</h2>
          <p className="muted">A scene is one place photographed from one spot: a hotel bed, a restaurant table, a shop shelf.</p>
          <button className="primary" onClick={() => setEditing("new")}>+ Add scene</button>
        </div>
      )}

      {scenes && scenes.length > 0 && (
        <div className="board" role="list">
          {COLUMNS.map((col) => {
            const list = byColumn.get(col.id)!;
            return (
              <section key={col.id} className={`column col-${col.id}`} aria-label={col.title} role="listitem">
                <div className="column-head" title={col.hint}>
                  <span className="dot" /> {col.title} <span className="count">{list.length}</span>
                </div>
                <div className="column-sub">{col.hint}</div>
                {list.length === 0 && <div className="column-empty">Empty</div>}
                {list.map((s) => <SceneCard key={s.id} s={s} onEdit={() => setEditing(s)} onDelete={() => setDeleting(s)} />)}
              </section>
            );
          })}
        </div>
      )}

      {editing && (
        <SceneDialog scene={editing === "new" ? null : editing} groups={[...new Set((scenes ?? []).map((s) => s.group).filter(Boolean))]}
          defaultGroup={group ?? ""} onClose={() => setEditing(null)}
          onSaved={(id, created) => { setEditing(null); onChange(); if (created) location.hash = `#/scenes/${id}`; }} />
      )}
      {deleting && <DeleteSceneDialog scene={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); onChange(); }} />}
    </>
  );
}

function cardNote(s: SceneSummary): { text: string; tone?: "issue" | "review" } {
  if (!s.golden) return { text: "Add a golden photo" };
  if (s.itemCount === 0 && s.ruleCount === 0) return { text: "Mark what to watch" };
  const l = s.lastCheck;
  if (!l) return { text: "No inspections yet" };
  if (l.status === "running") return { text: "Checking…", tone: "review" };
  if (s.toReview > 0) return { text: `${plural(s.toReview, "inspection")} to review`, tone: "review" };
  if (l.status === "retake") return { text: "Retake photo", tone: "issue" };
  if (l.status === "failed") return { text: "Check failed", tone: "issue" };
  if (l.issues > 0) return { text: plural(l.issues, "issue"), tone: "issue" };
  return { text: "All good" };
}

function SceneCard({ s, onEdit, onDelete }: { s: SceneSummary; onEdit: () => void; onDelete: () => void }) {
  const note = cardNote(s);
  return (
    <article className="scene-card">
      <a href={`#/scenes/${s.id}`} className="scene-card-link" aria-label={`Open ${s.name}`} />
      {s.golden && <img src={s.golden.url} alt="" loading="lazy" />}
      <div className="scene-card-body">
        <div className="row between">
          <h3>{s.name}</h3>
          {note.tone === "issue" && <span className="alert-dot" aria-label="Has issues" />}
          <Menu label={`Actions for ${s.name}`} items={[{ label: "Edit", run: onEdit }, { label: "Delete", run: onDelete, danger: true }]} />
        </div>
        <div className="person">
          <PersonIcon /> {s.assignee || <span className="muted">Unassigned</span>}
        </div>
        <div className={`card-foot ${note.tone ?? ""}`}>
          <span>{note.text}</span>
          {s.lastCheck && <span className="muted">{ago(s.lastCheck.createdAt)}</span>}
        </div>
        {s.group && <span className="chip">{s.group}</span>}
      </div>
    </article>
  );
}

export function PersonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </svg>
  );
}

// A small "⋯" menu. Closes on outside click and Escape.
export function Menu({ label, items }: { label: string; items: { label: string; run: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => { removeEventListener("mousedown", close); removeEventListener("keydown", close); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="icon" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((i) => (
            <button key={i.label} role="menuitem" className={i.danger ? "danger" : undefined} onClick={() => { setOpen(false); i.run(); }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// A native modal dialog, open while mounted.
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

export function SceneDialog({ scene, groups, defaultGroup = "", onClose, onSaved }: {
  scene: { id: string; name: string; group: string; assignee: string } | null; groups: string[]; defaultGroup?: string;
  onClose: () => void; onSaved: (id: string, created: boolean) => void;
}) {
  const [name, setName] = useState(scene?.name ?? "");
  const [group, setGroup] = useState(scene?.group ?? defaultGroup);
  const [assignee, setAssignee] = useState(scene?.assignee ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the scene a name, for example \"Room 1201 – bed\".");
    setBusy(true);
    try {
      const body = JSON.stringify({ name, group, assignee });
      const saved = scene
        ? await api<{ id: string }>(`/api/scenes/${scene.id}`, { method: "PUT", body })
        : await api<{ id: string }>("/api/scenes", { method: "POST", body });
      onSaved(saved.id, !scene);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={scene ? "Edit scene" : "Add scene"} onClose={onClose}>
      <form onSubmit={save} className="form">
        <label>Name<input type="text" value={name} maxLength={80} autoFocus placeholder="Room 1201 – bed" onChange={(e) => { setName(e.target.value); setError(""); }} /></label>
        <label>Group <span className="muted">· location, floor or client</span>
          <input type="text" value={group} maxLength={60} list="scene-groups" placeholder="The Continental – Floor 12" onChange={(e) => setGroup(e.target.value)} />
          <datalist id="scene-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </label>
        <label>Assignee <span className="muted">· who keeps it right</span>
          <input type="text" value={assignee} maxLength={60} placeholder="Maria Santos" onChange={(e) => setAssignee(e.target.value)} />
        </label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}>{scene ? "Save" : "Add scene"}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function DeleteSceneDialog({ scene, onClose, onDeleted }: { scene: { id: string; name: string }; onClose: () => void; onDeleted: () => void }) {
  const [error, setError] = useState("");
  const remove = async () => {
    try {
      await api(`/api/scenes/${scene.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog title={`Delete "${scene.name}"?`} onClose={onClose}>
      <p className="muted">This deletes the golden photo, watched items, checklist and every inspection photo of this scene. It can't be undone.</p>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="row end">
        <button className="ghost" onClick={onClose} autoFocus>Cancel</button>
        <button className="danger-btn" onClick={remove}>Delete scene</button>
      </div>
    </Dialog>
  );
}
