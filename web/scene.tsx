// One scene, top to bottom: golden photo with everything we watch, the written checklist, then every inspection
// (list on the left, the selected inspection's checklist and review on the right).
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { COLOURS, type CheckSummary, type Item, type Rule, type Scene, api, ago, plural, post, useStream } from "./api.js";
import { DeleteSceneDialog, Menu, PersonIcon, SceneDialog } from "./board.js";
import { InspectionDetail, ReviewPill, SourceIcon } from "./inspection.js";
import { AnnotatedPhoto } from "./photo.js";

export function ScenePage({ id, checkId, groups, onScenesChange }: { id: string; checkId: string | null; groups: string[]; onScenesChange: () => void }) {
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const load = useCallback(() => api<Scene>(`/api/scenes/${id}`).then(setScene).catch((e) => setError(e.message)), [id]);
  useEffect(() => { setScene(null); void load(); }, [load]);

  if (!scene) return error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>;
  return (
    <>
      <header className="page-head scene-head">
        <div className="row">
          <a href="#/" className="back" aria-label="Back to all scenes">←</a>
          <div>
            <h1>{scene.name}</h1>
            <div className="meta">
              {scene.group && <span className="chip">{scene.group}</span>}
              <span className="person"><PersonIcon /> {scene.assignee || "Unassigned"}</span>
            </div>
          </div>
        </div>
        <div className="row">
          {scene.golden && <NewPhotoButton sceneId={id} primary onError={setError} />}
          <button onClick={() => setDialog("edit")}>Edit</button>
          <Menu label="More actions" items={[{ label: "Delete scene", run: () => setDialog("delete"), danger: true }]} />
        </div>
      </header>
      {error && <div className="banner error" role="alert">{error} <button className="ghost" onClick={() => setError("")}>Dismiss</button></div>}

      <GoldenPanel scene={scene} reload={load} onError={setError} />
      {scene.golden && <ChecklistPanel scene={scene} onSaved={(checklist) => { setScene({ ...scene, checklist }); onScenesChange(); }} onError={setError} />}
      {scene.golden && <InspectionsPanel scene={scene} checkId={checkId} onError={setError} />}

      {dialog === "edit" && (
        <SceneDialog scene={scene} groups={groups} onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); void load(); onScenesChange(); }} />
      )}
      {dialog === "delete" && (
        <DeleteSceneDialog scene={scene} onClose={() => setDialog(null)} onDeleted={() => { onScenesChange(); location.hash = "#/"; }} />
      )}
    </>
  );
}

// ---------- golden photo + what we watch ----------
function GoldenPanel({ scene, reload, onError }: { scene: Scene; reload: () => Promise<unknown>; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<"upload" | "detect" | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const g = scene.golden;

  const detect = async () => {
    setBusy("detect");
    try {
      const found = await post<Item[]>(`/api/scenes/${scene.id}/items/detect`, {});
      await reload();
      if (!found.length) onError("No new objects found. Click an object on the photo to add it by hand.");
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return onError("Choose a photo (JPEG, PNG or WebP).");
    setBusy("upload");
    onError("");
    const body = new FormData();
    body.append("image", file);
    try {
      await api(`/api/scenes/${scene.id}/golden`, { method: "POST", body });
      await reload();
      await detect();
    } catch (err) {
      onError((err as Error).message);
      setBusy(null);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const replace = () => {
    if (scene.items.length && !confirm("A new golden photo clears what we watch (positions change) and finds objects again. Continue?")) return;
    fileRef.current?.click();
  };

  const tap = async (fx: number, fy: number) => {
    if (!g || pending || busy) return;
    setPending({ x: fx, y: fy });
    onError("");
    try {
      const item = await post<Item>(`/api/scenes/${scene.id}/items/tap`, { x: Math.round(fx * g.w), y: Math.round(fy * g.h) });
      await reload();
      setActive(item.id);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const update = async (item: Item, patch: Partial<Pick<Item, "name" | "phrase" | "expectedCount" | "positionMatters">>) => {
    try {
      await api(`/api/items/${item.id}`, { method: "PUT", body: JSON.stringify(patch) });
      await reload();
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const remove = async (item: Item) => {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    await reload();
  };

  const input = <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />;
  if (!g) {
    return (
      <section className="panel drop">
        {input}
        <h2>Add the golden photo</h2>
        <p className="muted">Photograph the scene when it looks exactly right, from the spot every inspection will use. GoldenFrame then finds the objects in it.</p>
        <button className="primary" onClick={() => fileRef.current?.click()} disabled={!!busy}>{busy ? "Uploading…" : "Choose photo"}</button>
      </section>
    );
  }

  const colour = (i: number) => COLOURS[i % COLOURS.length];
  const shapes = scene.items.map((item, i) => ({
    id: item.id, label: item.name, sub: `×${item.expectedCount} · looks like "${item.phrase}"`, colour: colour(i),
    boxes: item.boxes, masks: item.masks ?? (item.mask ? [item.mask] : []),
  }));
  const status = busy === "upload" ? "Uploading the golden photo…"
    : busy === "detect" ? "Finding objects: Spark lists them, SAM outlines and counts each…"
    : pending ? "Outlining that object, naming it and counting matches…" : null;

  return (
    <section className="panel golden">
      {input}
      <div className="panel-head">
        <div>
          <h2>Golden photo</h2>
          <p className="muted">How the scene must look. Hover an object to see what we watch; click empty space to add an object.</p>
        </div>
        <div className="row">
          <button onClick={detect} disabled={!!busy || !!pending}>Find objects</button>
          <button onClick={replace} disabled={!!busy}>Replace photo</button>
        </div>
      </div>
      {status && <div className="banner info"><span className="spinner" /> {status}</div>}
      <AnnotatedPhoto media={g} label="Golden photo" shapes={shapes} active={active} onActive={setActive} busyAt={pending}
        onPick={(itemId) => setOpen(itemId)} onEmptyClick={tap} />

      <div className="watch">
        <div className="watch-head">
          <h3>What we watch <span className="count">{scene.items.length}</span></h3>
          <span className="muted small">Counted by SAM in every inspection. Remove what doesn't matter.</span>
        </div>
        {scene.items.length === 0 && !busy && <p className="muted small">Nothing watched yet. Press "Find objects" or click an object on the photo.</p>}
        <div className="watch-grid">
          {scene.items.map((item, i) => (
            <ItemRow key={item.id} item={item} colour={colour(i)} lit={active === item.id} open={open === item.id}
              onToggle={() => setOpen(open === item.id ? null : item.id)} onHover={(on) => setActive(on ? item.id : null)}
              onSave={(p) => update(item, p)} onDelete={() => remove(item)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ItemRow({ item, colour, lit, open, onToggle, onHover, onSave, onDelete }: {
  item: Item; colour: string; lit: boolean; open: boolean; onToggle: () => void; onHover: (on: boolean) => void;
  onSave: (p: Partial<Pick<Item, "name" | "phrase" | "expectedCount" | "positionMatters">>) => void; onDelete: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [phrase, setPhrase] = useState(item.phrase);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setName(item.name); setPhrase(item.phrase); }, [item.name, item.phrase]);
  useEffect(() => { if (open) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [open]);
  return (
    <div ref={ref} className={`watch-item${lit ? " is-lit" : ""}`} style={{ "--c": colour } as React.CSSProperties}
      onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} onFocus={() => onHover(true)} onBlur={() => onHover(false)}>
      <button className="watch-line" onClick={onToggle} aria-expanded={open}>
        <span className="swatch" />
        <span className="watch-name">{item.name}</span>
        <span className="watch-count">×{item.expectedCount}</span>
        {!item.phraseMatches && <span className="warn small" title={`"${item.phrase}" didn't find this object again`}>!</span>}
      </button>
      {open && (
        <div className="watch-edit">
          <label>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== item.name && onSave({ name })} /></label>
          <div className="row">
            <label style={{ flex: 1 }} title="The words SAM looks for in new photos">Looks like
              <input type="text" value={phrase} onChange={(e) => setPhrase(e.target.value)} onBlur={() => phrase.trim() && phrase !== item.phrase && onSave({ phrase })} />
            </label>
            <label title="How many should be visible">Count
              <input type="number" className="count" min={0} max={50} value={item.expectedCount}
                onChange={(e) => onSave({ expectedCount: Math.max(0, Math.min(50, Math.round(Number(e.target.value) || 0))) })} />
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={item.positionMatters} onChange={(e) => onSave({ positionMatters: e.target.checked })} /> Must stay in the same spot</label>
          {!item.phraseMatches && <p className="warn small">"{item.phrase}" didn't find this object again. Try a simpler word, like "pillow" or "lamp".</p>}
          <button className="ghost danger" onClick={onDelete}>Stop watching</button>
        </div>
      )}
    </div>
  );
}

// ---------- checklist ----------
const NEW_SECTION = "__new";

function ChecklistPanel({ scene, onSaved, onError }: { scene: Scene; onSaved: (rules: Rule[]) => void; onError: (m: string) => void }) {
  const rules = scene.checklist;
  const sections = [...new Set(rules.map((r) => r.section))];
  const [draft, setDraft] = useState("");
  const [section, setSection] = useState(sections[0] ?? NEW_SECTION);
  const [newSection, setNewSection] = useState("");
  const [drafting, setDrafting] = useState(false);

  const save = async (next: { id?: string; text: string; section: string }[]) => {
    try {
      const r = await api<{ checklist: Rule[] }>(`/api/scenes/${scene.id}/checklist`, { method: "PUT", body: JSON.stringify({ rules: next }) });
      onSaved(r.checklist);
      return true;
    } catch (err) {
      onError((err as Error).message);
      return false;
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const target = section === NEW_SECTION ? newSection.trim() : section;
    if (!draft.trim()) return onError("Write the rule first, for example \"Duvet is smooth and centred\".");
    if (!target) return onError("Name the new section, for example \"THE BED\".");
    if (await save([...rules, { text: draft, section: target }])) {
      setDraft("");
      setNewSection("");
      setSection(target.toUpperCase());
    }
  };
  const wonder = async () => {
    setDrafting(true);
    try {
      const r = await post<{ checklist: Rule[] }>(`/api/scenes/${scene.id}/checklist/draft`, {});
      onSaved(r.checklist);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Checklist</h2>
          <p className="muted">What must be true, beyond the watched objects. Spark checks every rule on every inspection.</p>
        </div>
        <button onClick={wonder} disabled={drafting}>{drafting ? "Muse Wonder is writing…" : "✦ Draft with Muse Wonder"}</button>
      </div>
      {rules.length === 0 && <p className="muted small">No rules yet. Draft a starter checklist from the golden photo, or write your own below.</p>}
      <div className="sections">
        {sections.map((name) => (
          <div key={name} className="section-card">
            <div className="section-head"><span className="dot" /> {name} <span className="count">{rules.filter((r) => r.section === name).length}</span></div>
            {rules.filter((r) => r.section === name).map((r) => (
              <RuleEditor key={r.id} rule={r} onSave={(text) => save(rules.map((x) => (x.id === r.id ? { ...x, text } : x)))}
                onDelete={() => save(rules.filter((x) => x.id !== r.id))} />
            ))}
          </div>
        ))}
      </div>
      <form className="add-rule" onSubmit={add}>
        <input type="text" value={draft} maxLength={200} placeholder="Duvet is smooth and centred on the bed" aria-label="New rule" onChange={(e) => setDraft(e.target.value)} />
        <select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
          {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value={NEW_SECTION}>New section…</option>
        </select>
        {section === NEW_SECTION && (
          <input type="text" value={newSection} maxLength={60} placeholder="THE BED" aria-label="New section name" onChange={(e) => setNewSection(e.target.value)} />
        )}
        <button className="primary" disabled={rules.length >= 40}>Add rule</button>
      </form>
    </section>
  );
}

function RuleEditor({ rule, onSave, onDelete }: { rule: Rule; onSave: (text: string) => void; onDelete: () => void }) {
  const [text, setText] = useState(rule.text);
  useEffect(() => setText(rule.text), [rule.text]);
  return (
    <div className="rule-edit">
      <input type="text" value={text} maxLength={200} aria-label="Rule" onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() && text !== rule.text && onSave(text)} />
      <button type="button" className="icon" onClick={onDelete} aria-label={`Delete rule: ${rule.text}`}>✕</button>
    </div>
  );
}

// ---------- inspections ----------
type Filter = "all" | "needs_review" | "reviewed";

function InspectionsPanel({ scene, checkId, onError }: { scene: Scene; checkId: string | null; onError: (m: string) => void }) {
  const [checks, setChecks] = useState<CheckSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const load = useCallback(() => api<CheckSummary[]>(`/api/scenes/${scene.id}/checks?limit=100`).then(setChecks).catch(() => {}), [scene.id]);
  useEffect(() => void load(), [load]);
  useStream<{ sceneId: string }>("check", (e) => e.sceneId === scene.id && void load());

  const shown = (checks ?? []).filter((c) => filter === "all" || c.reviewStatus === filter);
  // Without a selection, open the oldest inspection still waiting for review, else the newest.
  const waiting = (checks ?? []).filter((c) => c.reviewStatus === "needs_review" && c.status !== "running");
  const selected = checkId ?? waiting.at(-1)?.id ?? checks?.[0]?.id ?? null;
  const count = (f: Filter) => (checks ?? []).filter((c) => f === "all" || c.reviewStatus === f).length;
  // Pin the default choice in the URL, so marking it reviewed doesn't jump to another inspection.
  useEffect(() => {
    if (!checkId && selected) location.replace(`#/scenes/${scene.id}/i/${selected}`);
  }, [checkId, selected, scene.id]);

  return (
    <section className="panel inspections" id="inspections">
      <div className="panel-head">
        <div>
          <h2>Inspections</h2>
          <p className="muted">Every photo and walkthrough frame checked against the golden photo. A person marks each one reviewed.</p>
        </div>
        <NewPhotoButton sceneId={scene.id} onError={onError} />
      </div>
      {checks && checks.length === 0 ? (
        <div className="empty small">
          <p className="muted">No inspections yet. Stand where the golden photo was taken, take a new photo and upload it.</p>
        </div>
      ) : (
        <div className="split">
          <div className="split-list">
            <div className="tabs" role="tablist">
              {(["all", "needs_review", "reviewed"] as Filter[]).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : undefined} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "needs_review" ? "Needs review" : "Reviewed"} <span className="count">{count(f)}</span>
                </button>
              ))}
            </div>
            {shown.length === 0 && <p className="muted small" style={{ padding: 12 }}>Nothing here.</p>}
            <ul className="ilist">
              {shown.map((c) => (
                <li key={c.id}>
                  <a href={`#/scenes/${scene.id}/i/${c.id}`} className={`irow${c.id === selected ? " on" : ""}`} aria-current={c.id === selected ? "true" : undefined}>
                    <img src={c.snapshot.url} alt="" loading="lazy" />
                    <span className="irow-main">
                      <span className="irow-title"><SourceIcon source={c.source} /> {c.source.type === "video" ? c.source.inspectionName : "Photo"}</span>
                      <span className="muted small">{ago(c.createdAt)}</span>
                      <span className="irow-tags">
                        <ReviewPill c={c} />
                        {c.issues > 0 && <span className="tag-issue">{plural(c.issues, "issue")}</span>}
                        {c.flags > 0 && <span className="tag-review">{c.flags} to decide</span>}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="split-detail">
            {selected ? <InspectionDetail key={selected} id={selected} onChanged={load} /> : <p className="muted">Choose an inspection.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

export function NewPhotoButton({ sceneId, primary, onError }: { sceneId: string; primary?: boolean; onError: (message: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const send = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return onError("Choose a photo (JPEG, PNG or WebP).");
    setBusy(true);
    onError("");
    const body = new FormData();
    body.append("image", file);
    try {
      const { checkId } = await api<{ checkId: string }>(`/api/scenes/${sceneId}/snapshots`, { method: "POST", body });
      location.hash = `#/scenes/${sceneId}/i/${checkId}`;
      document.getElementById("inspections")?.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };
  return (
    <>
      <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => send(e.target.files?.[0])} />
      <button className={primary ? "primary" : undefined} onClick={() => ref.current?.click()} disabled={busy}>
        {busy ? "Uploading…" : "+ New inspection"}
      </button>
    </>
  );
}
