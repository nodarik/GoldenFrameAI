// Scenes board: one column per next step (set up, inspect, review, fix, done), or the same scenes as a compact list in
// that order, plus the add/edit/delete dialogs.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { COLUMNS, type SceneSummary, type Video, ago, api, columnOf, plural, uploadVideo, useStream } from "./api.js";

type View = "board" | "list";
const VIEW_KEY = "truescene.scenesView";
const UNASSIGNED = "\u0000unassigned"; // can't clash with a typed name
const savedView = (): View => {
  try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"; } catch { return "board"; }
};

export function Board({ scenes, group, onChange }: { scenes: SceneSummary[] | null; group: string | null; onChange: () => void }) {
  const [view, setViewState] = useState<View>(savedView);
  const setView = (v: View) => {
    setViewState(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* the choice just isn't remembered */ }
  };
  const [editing, setEditing] = useState<SceneSummary | "new" | null>(null);
  const [deleting, setDeleting] = useState<SceneSummary | null>(null);
  const [error, setError] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  useEffect(() => { setVideoId(null); setError(""); }, [group]);
  // "" = everyone, UNASSIGNED = scenes without a person, otherwise one person's scenes. Kept across groups.
  const [assignee, setAssignee] = useState("");
  const inGroup = (scenes ?? []).filter((s) => group === null || s.group === group);
  const people = [...new Set(inGroup.map((s) => s.assignee).filter(Boolean))].sort();
  const unassigned = inGroup.filter((s) => !s.assignee).length;
  const shown = inGroup.filter((s) => assignee === "" || (assignee === UNASSIGNED ? !s.assignee : s.assignee === assignee));
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
          <p className="muted">Every scene's initial photo, its latest inspection and what a person has to do next.</p>
        </div>
        <div className="head-stats">
          <div><b>{byColumn.get("review")!.length}</b><span>To review</span></div>
          <div><b>{reviewed}</b><span>Reviewed</span></div>
          <div><b>{shown.length}</b><span>Total</span></div>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee">
            <option value="">Everyone</option>
            {/* A person picked in another group stays listed (with 0) so the select never shows a value it lacks. */}
            {[...new Set([...people, ...(assignee && assignee !== UNASSIGNED ? [assignee] : [])])].sort().map((p) => (
              <option key={p} value={p}>{p} ({inGroup.filter((s) => s.assignee === p).length})</option>
            ))}
            {(unassigned > 0 || assignee === UNASSIGNED) && <option value={UNASSIGNED}>Unassigned ({unassigned})</option>}
          </select>
          <div className="seg" role="radiogroup" aria-label="View">
            {(["board", "list"] as View[]).map((v) => (
              <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : undefined} onClick={() => setView(v)}>
                {v === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
          {group !== null && <GroupVideoButton sceneIds={inGroup.filter((s) => s.golden).map((s) => s.id)} onError={setError} onStarted={setVideoId} />}
          <button className="primary" onClick={() => setEditing("new")}>+ Add scene</button>
        </div>
      </header>
      {error && <div className="banner error" role="alert">{error} <button className="ghost" onClick={() => setError("")}>Dismiss</button></div>}
      {videoId && <GroupVideoStatus key={videoId} id={videoId} onClose={() => setVideoId(null)} />}

      {scenes && scenes.length === 0 && (
        <div className="empty">
          <h2>Add your first scene</h2>
          <p className="muted">A scene is one place photographed from one spot: a hotel bed, a restaurant table, a shop shelf.</p>
          <button className="primary" onClick={() => setEditing("new")}>+ Add scene</button>
        </div>
      )}

      {scenes && scenes.length > 0 && shown.length === 0 && assignee !== "" && (
        <p className="muted">
          No scenes {assignee === UNASSIGNED ? "without an assignee" : `assigned to ${assignee}`} here.{" "}
          <button className="ghost" onClick={() => setAssignee("")}>Show everyone</button>
        </p>
      )}

      {scenes && scenes.length > 0 && view === "list" && (
        <ul className="scene-list">
          {COLUMNS.flatMap((col) => byColumn.get(col.id)!.map((s) => (
            <SceneRow key={s.id} s={s} col={col} onEdit={() => setEditing(s)} onDelete={() => setDeleting(s)} />
          )))}
        </ul>
      )}

      {scenes && scenes.length > 0 && view === "board" && (
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
        <SceneDialog scene={editing === "new" ? null : editing} groups={[...new Set((scenes ?? []).map((s) => s.group).filter(Boolean))].sort()}
          assignees={[...new Set((scenes ?? []).map((s) => s.assignee).filter(Boolean))].sort()}
          defaultGroup={group ?? ""} onClose={() => setEditing(null)}
          onSaved={(id, created) => { setEditing(null); onChange(); if (created) location.hash = `#/scenes/${id}`; }} />
      )}
      {deleting && <DeleteSceneDialog scene={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); onChange(); }} />}
    </>
  );
}

type CardLine = { text: string; tone?: "issue" | "review" };

// One line per inspection kind with its own review status, e.g. "5 photo inspections · 4 to review".
function typeLine(n: number, kind: "photo" | "video", toReview: number): CardLine {
  const label = plural(n, `${kind} inspection`);
  return toReview > 0 ? { text: `${label} · ${toReview} to review`, tone: "review" } : { text: `${label} · reviewed` };
}

function cardNote(s: SceneSummary): CardLine {
  if (!s.golden) return { text: "Add an initial photo" };
  if (s.itemCount === 0 && s.ruleCount === 0) return { text: "Mark what to watch" };
  const total = s.checkCount ?? 0;
  const l = s.lastCheck;
  if (!l || total === 0) return { text: "No inspections yet" };
  if (l.status === "running") return { text: total === 1 ? "1 inspection · Checking…" : `${total} inspections · Checking…`, tone: "review" };
  if (s.toReview > 0) {
    if (s.toReview === total) return { text: plural(s.toReview, "inspection") + " to review", tone: "review" };
    return { text: `${plural(total, "inspection")} · ${s.toReview} to review`, tone: "review" };
  }
  // Everything is reviewed here: a retake or failed check the reviewer accepted counts as done (see columnOf).
  if (s.openIssues > 0) return { text: `${plural(total, "inspection")} · ${plural(s.openIssues, "open issue")}`, tone: "issue" };
  return { text: `${plural(total, "inspection")} · All good` };
}

// Scenes with both kinds show one line per kind with its own status; otherwise a single overall line.
function cardLines(s: SceneSummary): { lines: CardLine[]; tone?: "issue" | "review" } {
  const photos = s.photoCount ?? 0, videos = s.videoCount ?? 0;
  if (photos > 0 && videos > 0 && s.lastCheck && (s.checkCount ?? 0) > 0) {
    const lines = [typeLine(photos, "photo", s.photoToReview ?? 0), typeLine(videos, "video", s.videoToReview ?? 0)];
    const tone = s.toReview > 0 ? "review" as const
      : s.openIssues > 0 ? "issue" as const : undefined;
    return { lines, tone };
  }
  const single = cardNote(s);
  return { lines: [single], tone: single.tone };
}

function SceneCard({ s, onEdit, onDelete }: { s: SceneSummary; onEdit: () => void; onDelete: () => void }) {
  const note = cardLines(s);
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
          <span className="card-counts">
            {note.lines.map((l) => <span key={l.text} className={l.tone ?? ""}>{l.text}</span>)}
          </span>
          {s.lastCheck && <span className="muted">{ago(s.lastCheck.createdAt)}</span>}
        </div>
        {s.group && <span className="chip">{s.group}</span>}
      </div>
    </article>
  );
}

// The list view's row: the same facts as a card, on one line.
function SceneRow({ s, col, onEdit, onDelete }: { s: SceneSummary; col: (typeof COLUMNS)[number]; onEdit: () => void; onDelete: () => void }) {
  const note = cardLines(s);
  return (
    <li className="scene-row">
      <a href={`#/scenes/${s.id}`} className="scene-card-link" aria-label={`Open ${s.name}`} />
      {s.golden ? <img src={s.golden.url} alt="" loading="lazy" /> : <span className="row-thumb-empty" />}
      <span className="row-name">
        <b>{s.name}</b>
        {s.group && <span className="chip">{s.group}</span>}
      </span>
      <span className={`row-status col-${col.id}`} title={col.hint}><span className="dot" /> {col.title}</span>
      <span className="person row-person"><PersonIcon /> {s.assignee || <span className="muted">Unassigned</span>}</span>
      <span className={`card-counts row-counts ${note.tone ?? ""}`}>
        {note.lines.map((l) => <span key={l.text} className={l.tone ?? ""}>{l.text}</span>)}
      </span>
      <span className="muted small row-when">{s.lastCheck ? ago(s.lastCheck.createdAt) : ""}</span>
      <Menu label={`Actions for ${s.name}`} items={[{ label: "Edit", run: onEdit }, { label: "Delete", run: onDelete, danger: true }]} />
    </li>
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
// One video of a whole group (a floor, a site): every scene it shows gets inspections, each on its own scene page.
function GroupVideoButton({ sceneIds, onError, onStarted }: { sceneIds: string[]; onError: (m: string) => void; onStarted: (id: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ pct: number; name?: string } | null>(null);
  const send = async (file: File | undefined) => {
    if (!file) return;
    onError("");
    setUpload({ pct: 0, name: file.name });
    try {
      onStarted((await uploadVideo(file, sceneIds, (pct) => setUpload((u) => (u ? { ...u, pct } : u)))).id);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setUpload(null);
      if (ref.current) ref.current.value = "";
    }
  };
  if (upload) {
    return (
      <span className="upload-card upload-video upload-mini" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.pct}
        aria-label={`Uploading video${upload.name ? ` ${upload.name}` : ""}`}>
        <span className="upload-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3z" /></svg>
        </span>
        <span className="upload-body">
          <span className="upload-top"><b>Uploading video…</b><span className="upload-pct">{upload.pct}%</span></span>
          <span className="upload-bar"><div style={{ width: `${upload.pct}%` }} /></span>
        </span>
      </span>
    );
  }
  return (
    <>
      <input ref={ref} type="file" accept="video/*" hidden onChange={(e) => send(e.target.files?.[0])} />
      <button onClick={() => ref.current?.click()} disabled={!sceneIds.length}
        title={sceneIds.length ? `Film the ${plural(sceneIds.length, "scene")} of this group in one video (up to 3 min)` : "Add an initial photo to a scene first"}>
        + Video inspection
      </button>
    </>
  );
}

// Follows a group video until every scene is found or not; each scene's results are on its own page.
function GroupVideoStatus({ id, onClose }: { id: string; onClose: () => void }) {
  const [v, setV] = useState<Video | null>(null);
  const load = () => api<Video>(`/api/video/inspections/${id}`).then(setV).catch(() => {});
  useEffect(() => void load(), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useStream<{ id: string }>("inspection", (e) => e.id === id && void load());
  if (!v) return null;
  const found = v.scenes.filter((s) => s.status === "found");
  const missed = v.scenes.filter((s) => s.status === "not_seen" || s.status === "failed");
  return (
    <div className={`banner ${v.status === "failed" ? "error" : "info"}`} role="status">
      {v.status === "processing" && <span className="spinner" />}
      <div>
        <strong>{v.name}</strong>{" "}
        {v.status === "processing" ? `${v.stage ?? "Processing"}…` : v.status === "failed" ? (v.error ?? "The video couldn't be checked.")
          : `Found ${found.length} of ${v.scenes.length} scenes.`}
        {(found.length > 0 || missed.length > 0) && (
          <div className="small">
            {found.map((s) => <a key={s.sceneId} href={`#/scenes/${s.sceneId}/i/${s.checkIds[0]}`}>{s.name} ({plural(s.checkIds.length, "inspection")})</a>)
              .concat(missed.map((s) => <span key={s.sceneId} className="muted">{s.name}: {s.status === "failed" ? "failed" : "not seen"}</span>))
              .flatMap((el, i) => (i ? [<span key={`sep${i}`}> · </span>, el] : [el]))}
          </div>
        )}
      </div>
      {v.status !== "processing" && <button className="ghost" onClick={onClose}>Dismiss</button>}
    </div>
  );
}

// A dropdown of actions. Without `text` the trigger is a "⋯" icon button labelled `label`.
export function Menu({ label, items, text, className }: {
  label: string; items: { label: string; run: () => void; danger?: boolean }[]; text?: string; className?: string;
}) {
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
      {text
        ? <button className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{text} ▾</button>
        : <button className="icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>}
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
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className={wide ? "dialog wide" : "dialog"} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

export function SceneDialog({ scene, groups, assignees = [], defaultGroup = "", onClose, onSaved }: {
  scene: { id: string; name: string; group: string; assignee: string } | null; groups: string[]; assignees?: string[]; defaultGroup?: string;
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
        <PickOrAdd id="scene-group" label="Group" hint="location, floor or client" value={group} options={groups} onChange={setGroup}
          none="No group" addLabel="+ New group…" placeholder="The Continental – Floor 12" />
        <PickOrAdd id="scene-assignee" label="Assignee" hint="who keeps it right" value={assignee} options={assignees} onChange={setAssignee}
          none="Unassigned" addLabel="+ New person…" placeholder="Maria Santos" />
        {error && <p className="err" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}>{scene ? "Save" : "Add scene"}</button>
        </div>
      </form>
    </Dialog>
  );
}

// A dropdown of the values already in use, plus "none" and "new": choosing new swaps it for a text field.
function PickOrAdd({ id, label, hint, value, options, onChange, none, addLabel, placeholder }: {
  id: string; label: string; hint: string; value: string; options: string[]; onChange: (v: string) => void;
  none: string; addLabel: string; placeholder: string;
}) {
  const NEW = "\u0000new"; // can't clash with a real name
  const [adding, setAdding] = useState(false);
  const list = [...new Set([...options, value].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return (
    <div className="form" style={{ gap: 4 }}>
      <label htmlFor={id}><span>{label} <span className="muted">· {hint}</span></span></label>
      {adding ? (
        <div className="row">
          <input id={id} type="text" value={value} maxLength={60} placeholder={placeholder} autoFocus autoComplete="off"
            onChange={(e) => onChange(e.target.value)} style={{ flex: 1 }} />
          {list.length > 0 && <button type="button" className="ghost" onClick={() => { setAdding(false); onChange(""); }}>Choose from list</button>}
        </div>
      ) : (
        <select id={id} value={value} onChange={(e) => {
          if (e.target.value !== NEW) return onChange(e.target.value);
          setAdding(true);
          onChange("");
        }}>
          <option value="">{none}</option>
          {list.map((o) => <option key={o} value={o}>{o}</option>)}
          <option value={NEW}>{addLabel}</option>
        </select>
      )}
    </div>
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
      <p className="muted">This deletes the initial photo, watched items, checklist and every inspection photo of this scene. It can't be undone.</p>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="row end">
        <button className="ghost" onClick={onClose} autoFocus>Cancel</button>
        <button className="danger-btn" onClick={remove}>Delete scene</button>
      </div>
    </Dialog>
  );
}
