// One scene, top to bottom: every inspection (list on the left, the selected
// inspection's checklist and review on the right), then the written checklist,
// then the golden photo with everything we watch. Each section collapses.
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { COLOURS, type CheckSummary, type Integration, type Item, type Rule, type Scene, api, ago, plural, post, uploadForm, useStream } from "./api.js";
import { DeleteSceneDialog, Dialog, Menu, PersonIcon, SceneDialog } from "./board.js";
import { InspectionDetail, ReviewPill, SourceIcon } from "./inspection.js";
import { AnnotatedPhoto } from "./photo.js";

export function ScenePage({ id, checkId, groups, assignees = [], onScenesChange }: { id: string; checkId: string | null; groups: string[]; assignees?: string[]; onScenesChange: () => void }) {
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"edit" | "delete" | "integration" | null>(null);
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
          <button onClick={() => setDialog("integration")}>API & webhook</button>
          <button onClick={() => setDialog("edit")}>Edit</button>
          <Menu label="More actions" items={[{ label: "Delete scene", run: () => setDialog("delete"), danger: true }]} />
        </div>
      </header>
      {error && <div className="banner error" role="alert">{error} <button className="ghost" onClick={() => setError("")}>Dismiss</button></div>}

      {scene.golden && <InspectionsPanel scene={scene} checkId={checkId} onError={setError} />}
      {scene.golden && <ChecklistPanel scene={scene} onSaved={(checklist) => { setScene({ ...scene, checklist }); onScenesChange(); }} onError={setError} />}
      <GoldenPanel scene={scene} reload={load} onError={setError} />

      {dialog === "edit" && (
        <SceneDialog scene={scene} groups={groups} assignees={assignees} onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); void load(); onScenesChange(); }} />
      )}
      {dialog === "delete" && (
        <DeleteSceneDialog scene={scene} onClose={() => setDialog(null)} onDeleted={() => { onScenesChange(); location.hash = "#/"; }} />
      )}
      {dialog === "integration" && <IntegrationDialog sceneId={id} onClose={() => setDialog(null)} />}
    </>
  );
}

// ---------- API & webhook: let another system send photos and receive results ----------
function IntegrationDialog({ sceneId, onClose }: { sceneId: string; onClose: () => void }) {
  const [info, setInfo] = useState<Integration | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const show = (i: Integration) => { setInfo(i); setWebhookUrl(i.webhookUrl); };
  useEffect(() => { api<Integration>(`/api/scenes/${sceneId}/integration`).then(show).catch((e) => setError(e.message)); }, [sceneId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      show(await api<Integration>(`/api/scenes/${sceneId}/integration`, { method: "PUT", body: JSON.stringify({ webhookUrl }) }));
      setError("");
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const rotate = async () => {
    if (!confirm("Make a new token and secret? Systems using the old ones stop working.")) return;
    try {
      show(await post<Integration>(`/api/scenes/${sceneId}/integration/rotate`, {}));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const endpoint = info ? `${location.origin}${info.ingestPath}` : "";
  return (
    <Dialog title="API & webhook" onClose={onClose}>
      <p className="muted">Another system can send inspection photos for this scene. Each one is checked like an upload, and the result is posted to your webhook as JSON.</p>
      {!info ? <p className="muted">{error || "Loading…"}</p> : (
        <div className="form">
          <label>Send a photo
            <code className="copyable">{`curl -H "Authorization: Bearer ${info.token}" -F image=@photo.jpg ${endpoint}`}</code>
          </label>
          <form onSubmit={save} className="form" style={{ gap: 4 }}>
            <label htmlFor="webhook-url">Webhook URL</label>
            <div className="row">
              <input id="webhook-url" type="url" value={webhookUrl} maxLength={500} placeholder="https://example.com/goldenframe"
                onChange={(e) => { setWebhookUrl(e.target.value); setSaved(false); }} style={{ flex: 1 }} />
              <button className="primary">{saved ? "Saved" : "Save"}</button>
            </div>
          </form>
          <label>Signing secret
            <code className="copyable">{info.webhookSecret}</code>
            <span className="muted small">Each delivery carries X-GoldenFrame-Signature: sha256=HMAC-SHA256 of the body with this secret.</span>
          </label>
          {error && <p className="err" role="alert">{error}</p>}
          <div className="row end">
            <button className="ghost" onClick={rotate}>New token and secret</button>
            <button onClick={onClose} autoFocus>Done</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------- collapsible section ----------
function CollapseButton({ collapsed, onToggle, label }: { collapsed: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className="icon collapse-btn" onClick={onToggle} aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`} title={collapsed ? `Expand ${label}` : `Collapse ${label}`}>
      <span className="toggle" aria-hidden="true">{collapsed ? "+" : "−"}</span>
    </button>
  );
}

// ---------- golden photo + what we watch ----------
function GoldenPanel({ scene, reload, onError }: { scene: Scene; reload: () => Promise<unknown>; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<"upload" | "detect" | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
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
    setProgress(0);
    onError("");
    const body = new FormData();
    body.append("image", file);
    try {
      await uploadForm(`/api/scenes/${scene.id}/golden`, body, setProgress);
      setProgress(null);
      await reload();
      await detect();
    } catch (err) {
      onError((err as Error).message);
      setBusy(null);
      setProgress(null);
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
    const label = busy === "upload" ? `Uploading… ${progress ?? 0}%` : busy === "detect" ? "Finding objects…" : "Choose photo";
    return (
      <section className="panel drop">
        {input}
        <h2>Add the golden photo</h2>
        <p className="muted">Photograph the scene when it looks exactly right, from the spot every inspection will use. GoldenFrame then finds the objects in it.</p>
        <button className="primary" onClick={() => fileRef.current?.click()} disabled={!!busy}>{label}</button>
        {busy === "upload" && progress !== null && (
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Uploading golden photo"
            style={{ maxWidth: 320, margin: "12px auto 0" }}>
            <div style={{ width: `${progress}%` }} />
          </div>
        )}
        {busy === "detect" && <p className="muted small" style={{ marginTop: 12 }}><span className="spinner" style={{ display: "inline-block", verticalAlign: -2 }} /> Finding objects: Spark lists them, SAM outlines and counts each…</p>}
      </section>
    );
  }

  const colour = (i: number) => COLOURS[i % COLOURS.length];
  const shapes = scene.items.map((item, i) => ({
    id: item.id, label: item.name, sub: `×${item.expectedCount} · looks like "${item.phrase}"`, colour: colour(i),
    boxes: item.boxes, masks: item.masks ?? (item.mask ? [item.mask] : []),
  }));
  const status = busy === "upload" ? `Uploading the golden photo… ${progress ?? 0}%`
    : busy === "detect" ? "Finding objects: Spark lists them, SAM outlines and counts each…"
    : pending ? "Outlining that object, naming it and counting matches…" : null;

  return (
    <section className={`panel golden${collapsed ? " collapsed" : ""}`}>
      {input}
      <div className="panel-head">
        <CollapseButton collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} label="Golden photo" />
        <div style={{ flex: 1 }}>
          <h2>Golden photo</h2>
          <p className="muted">How the scene must look. Hover an object to see what we watch; click empty space to add an object.</p>
        </div>
        <div className="row">
          <button onClick={detect} disabled={!!busy || !!pending}>Find objects</button>
          <button onClick={replace} disabled={!!busy}>Replace photo</button>
        </div>
      </div>
      {!collapsed && (
      <>
      {status && (
        <div className="banner info" role={busy === "upload" ? "progressbar" : undefined}
          aria-valuemin={busy === "upload" ? 0 : undefined} aria-valuemax={busy === "upload" ? 100 : undefined}
          aria-valuenow={busy === "upload" ? (progress ?? 0) : undefined} aria-label={busy === "upload" ? "Uploading golden photo" : undefined}>
          <span className="spinner" /> <span>{status}</span>
          {busy === "upload" && progress !== null && (
            <span className="bar" style={{ flex: 1, minWidth: 120, marginTop: 0 }}><div style={{ width: `${progress}%` }} /></span>
          )}
        </div>
      )}
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
      </>
      )}
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
  const [collapsed, setCollapsed] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggle = (name: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

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
      // New rule's section should be visible.
      setClosed((prev) => {
        if (!prev.has(target.toUpperCase())) return prev;
        const next = new Set(prev);
        next.delete(target.toUpperCase());
        return next;
      });
    }
  };
  const wonder = async () => {
    setDrafting(true);
    try {
      const r = await post<{ checklist: Rule[] }>(`/api/scenes/${scene.id}/checklist/draft`, {});
      onSaved(r.checklist);
      setClosed(new Set());
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  return (
    <section className={`panel${collapsed ? " collapsed" : ""}`}>
      <div className="panel-head">
        <CollapseButton collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} label="Checklist" />
        <div style={{ flex: 1 }}>
          <h2>Checklist</h2>
          <p className="muted">What must be true, beyond the watched objects. Spark checks every rule on every inspection.</p>
        </div>
        <button onClick={wonder} disabled={drafting}>{drafting ? "Muse Wonder is writing…" : "✦ Draft with Muse Wonder"}</button>
      </div>
      {!collapsed && (
      <>
      {rules.length === 0 && <p className="muted small">No rules yet. Draft a starter checklist from the golden photo, or write your own below.</p>}
      {sections.length > 1 && (
        <div className="row end" style={{ margin: "0 0 8px" }}>
          <button type="button" className="link small" onClick={() => setClosed(new Set())}>Expand all</button>
          <button type="button" className="link small" onClick={() => setClosed(new Set(sections))}>Collapse all</button>
        </div>
      )}
      <div className="sections">
        {sections.map((name) => {
          const open = !closed.has(name);
          const list = rules.filter((r) => r.section === name);
          return (
            <div key={name} className="section-card">
              <button type="button" className="section-head" onClick={() => toggle(name)} aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} section ${name}`}>
                <span className="toggle" aria-hidden="true">{open ? "−" : "+"}</span>
                <span className="dot" /> {name} <span className="count">{list.length}</span>
              </button>
              {open && list.map((r) => (
                <RuleEditor key={r.id} rule={r} onSave={(text) => save(rules.map((x) => (x.id === r.id ? { ...x, text } : x)))}
                  onDelete={() => save(rules.filter((x) => x.id !== r.id))} />
              ))}
            </div>
          );
        })}
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
      </>
      )}
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
  const [collapsed, setCollapsed] = useState(false);
  const load = useCallback(() => api<CheckSummary[]>(`/api/scenes/${scene.id}/checks?limit=100`).then(setChecks).catch(() => {}), [scene.id]);
  useEffect(() => void load(), [load]);
  useStream<{ sceneId: string }>("check", (e) => e.sceneId === scene.id && void load());

  const shown = (checks ?? []).filter((c) => filter === "all" || c.reviewStatus === filter);
  // Without a selection, open the oldest inspection still waiting for review, else the newest.
  // If the URL points to an inspection that is gone (just deleted), fall through to the next one.
  const known = checks ? new Set(checks.map((c) => c.id)) : null;
  const activeId = checkId && (!known || known.has(checkId)) ? checkId : null;
  const waiting = (checks ?? []).filter((c) => c.reviewStatus === "needs_review" && c.status !== "running");
  const selected = activeId ?? waiting.at(-1)?.id ?? checks?.[0]?.id ?? null;
  const count = (f: Filter) => (checks ?? []).filter((c) => f === "all" || c.reviewStatus === f).length;
  // Pin the default choice in the URL, so marking it reviewed doesn't jump to another inspection.
  // Also repairs the URL when it points to a deleted inspection.
  useEffect(() => {
    if (selected && (!checkId || (known && !known.has(checkId)))) location.replace(`#/scenes/${scene.id}/i/${selected}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkId, selected, scene.id, checks]);

  const nextAfter = (excludeId: string, list: CheckSummary[] | null) => {
    const rest = (list ?? []).filter((c) => c.id !== excludeId);
    return rest.filter((c) => c.reviewStatus === "needs_review" && c.status !== "running").at(-1)?.id ?? rest[0]?.id ?? null;
  };

  const remove = async (targetId: string, running: boolean) => {
    if (running) return onError("Wait until the check finishes.");
    if (!confirm("Delete this inspection? Its photo and results will be gone.")) return;
    const next = nextAfter(targetId, checks);
    // Drop it from the list immediately so the detail pane doesn't keep showing it.
    setChecks((prev) => prev?.filter((c) => c.id !== targetId) ?? prev);
    if (targetId === selected || targetId === checkId) {
      location.hash = next ? `#/scenes/${scene.id}/i/${next}` : `#/scenes/${scene.id}`;
    }
    try {
      await api(`/api/checks/${targetId}`, { method: "DELETE" });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      void load();
    }
  };

  const handleDetailDeleted = (deletedId: string) => {
    const next = nextAfter(deletedId, checks);
    setChecks((prev) => prev?.filter((c) => c.id !== deletedId) ?? prev);
    location.hash = next ? `#/scenes/${scene.id}/i/${next}` : `#/scenes/${scene.id}`;
    void load();
  };

  return (
    <section className={`panel inspections${collapsed ? " collapsed" : ""}`} id="inspections">
      <div className="panel-head">
        <CollapseButton collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} label="Inspections" />
        <div style={{ flex: 1 }}>
          <h2>Inspections</h2>
          <p className="muted">Every photo and walkthrough frame checked against the golden photo. A person marks each one reviewed.</p>
        </div>
        <NewPhotoButton sceneId={scene.id} onError={onError} />
      </div>
      {!collapsed && (
      <>
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
                <li key={c.id} className="irow-wrap">
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
                  <button type="button" className="icon irow-delete" aria-label={`Delete inspection from ${ago(c.createdAt)}`}
                    title="Delete this inspection" onClick={() => remove(c.id, c.status === "running")}>✕</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="split-detail">
            {selected ? <InspectionDetail key={selected} id={selected} onChanged={load}
              onDeleted={handleDetailDeleted} /> : <p className="muted">Choose an inspection.</p>}
          </div>
        </div>
      )}
      </>
      )}
    </section>
  );
}

export function NewPhotoButton({ sceneId, primary, onError }: { sceneId: string; primary?: boolean; onError: (message: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const busy = progress !== null;
  const send = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return onError("Choose a photo (JPEG, PNG or WebP).");
    setProgress(0);
    onError("");
    const body = new FormData();
    body.append("image", file);
    try {
      const { checkId } = await uploadForm<{ checkId: string }>(`/api/scenes/${sceneId}/snapshots`, body, setProgress);
      setProgress(100);
      location.hash = `#/scenes/${sceneId}/i/${checkId}`;
      document.getElementById("inspections")?.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setProgress(null);
      if (ref.current) ref.current.value = "";
    }
  };
  return (
    <span className="upload-wrap">
      <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => send(e.target.files?.[0])} />
      <button className={primary ? "primary" : undefined} onClick={() => ref.current?.click()} disabled={busy}>
        {busy ? (progress !== null && progress >= 100 ? "Starting check…" : `Uploading… ${progress ?? 0}%`) : "+ New inspection"}
      </button>
      {busy && (
        <span className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? 0} aria-label="Uploading photo">
          <span className="bar"><div style={{ width: `${progress ?? 0}%` }} /></span>
        </span>
      )}
    </span>
  );
}
