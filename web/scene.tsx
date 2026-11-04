// One scene, top to bottom: every inspection (list on the left, the selected
// inspection's checklist and review on the right), then the standard it is checked
// against: the initial photo with everything we watch on the left, the written
// checklist on the right. Each section collapses.
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { COLOURS, type CheckSummary, type Integration, type Item, type Rule, type Scene, type VideoNotice, api, ago, getReviewer, plural, post, uploadForm, uploadVideo, useStream } from "./api.js";
import { DeleteSceneDialog, Dialog, Menu, PersonIcon, SceneDialog } from "./board.js";
import { InspectionDetail, ReviewPill, SourceIcon } from "./inspection.js";
import { AnnotatedPhoto } from "./photo.js";
import { ReportPanel } from "./report.js";
import QRCode from "qrcode";

export function ScenePage({ id, checkId, tab = "inspections", groups, assignees = [], onScenesChange }: { id: string; checkId: string | null; tab?: "inspections" | "report"; groups: string[]; assignees?: string[]; onScenesChange: () => void }) {
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
          {scene.golden && <NewInspectionButton sceneId={id} primary onError={setError} />}
          <button onClick={() => setDialog("integration")}>Automation</button>
          <button onClick={() => setDialog("edit")}>Edit</button>
          <Menu label="More actions" items={[{ label: "Delete scene", run: () => setDialog("delete"), danger: true }]} />
        </div>
      </header>
      {error && <div className="banner error" role="alert">{error} <button className="ghost" onClick={() => setError("")}>Dismiss</button></div>}

      {scene.golden && (
        <nav className="scene-tabs" aria-label="Scene views">
          <a href={`#/scenes/${id}`} className={tab === "inspections" ? "on" : ""} aria-current={tab === "inspections" ? "page" : undefined}>Inspections</a>
          <a href={`#/scenes/${id}/report`} className={tab === "report" ? "on" : ""} aria-current={tab === "report" ? "page" : undefined}>Report</a>
        </nav>
      )}
      {tab === "report" && scene.golden ? <ReportPanel scene={scene} /> : (
        <>
          {scene.golden && <InspectionsPanel scene={scene} checkId={checkId} onError={setError} />}
          <GoldenPanel scene={scene} reload={load} onError={setError}
            checklist={<Checklist scene={scene} onSaved={(checklist) => { setScene({ ...scene, checklist }); onScenesChange(); }} onError={setError} />} />
        </>
      )}

      {dialog === "edit" && (
        <SceneDialog scene={scene} groups={groups} assignees={assignees} onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); void load(); onScenesChange(); }} />
      )}
      {dialog === "delete" && (
        <DeleteSceneDialog scene={scene} onClose={() => setDialog(null)} onDeleted={() => { onScenesChange(); location.hash = "#/"; }} />
      )}
      {dialog === "integration" && <IntegrationDialog sceneId={id} sceneName={scene.name} onClose={() => setDialog(null)} />}
    </>
  );
}

// ---------- auto-upload: let another system send photos and videos, and receive results ----------
// A sheet to print and put up at the scene: its name, the QR code and the link, in a window of its own.
function printQr(sceneName: string, link: string, qr: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const w = window.open("", "_blank");
  if (!w) return alert("Allow pop-ups for this site to print the QR code.");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(sceneName)} · upload QR</title><style>
    body { font-family: system-ui, sans-serif; text-align: center; margin: 48px 24px; color: #111; }
    h1 { font-size: 34px; margin: 0 0 8px; } p { font-size: 18px; margin: 0 0 24px; }
    img { width: 340px; height: 340px; } .url { font-size: 12px; color: #555; word-break: break-all; margin-top: 16px; }
  </style></head><body><h1>${esc(sceneName)}</h1><p>Scan to send a photo or video of this spot</p>
  <img src="${qr}" alt="QR code"><div class="url">${esc(link)}</div></body></html>`);
  w.document.close();
  w.onload = () => w.print();
}

// The scene's upload link for people: a page where anyone with the link sends photos and videos from their phone.
function UploadLinkSection({ sceneId, sceneName, info, onChange, onError }: {
  sceneId: string; sceneName: string; info: Integration; onChange: (i: Integration) => void; onError: (m: string) => void;
}) {
  const link = info.uploadLinkPath ? `${location.origin}${info.uploadLinkPath}` : null;
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setQr("");
    if (link) void QRCode.toDataURL(link, { width: 680, margin: 2, errorCorrectionLevel: "M" }).then(setQr);
  }, [link]);

  const change = async (method: "POST" | "DELETE", ask?: string) => {
    if (ask && !confirm(ask)) return;
    try {
      onChange(await api<Integration>(`/api/scenes/${sceneId}/integration/link`, { method }));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link!);
      setCopied(true);
    } catch {
      onError("Couldn't copy. Select the link and copy it yourself.");
    }
  };

  if (!link) return (
    <div className="link-off">
      <p className="muted small">Give your team a link or a printed QR code. They open it on their phone and send photos or videos of this scene, without an account.</p>
      <button type="button" className="primary" onClick={() => void change("POST")}>Create upload link</button>
    </div>
  );
  return (
    <div className="upload-link">
      {qr ? <img className="qr" src={qr} alt={`QR code for the ${sceneName} upload link`} /> : <div className="qr" aria-hidden="true" />}
      <div className="upload-link-side">
        <code className="copyable">{link}</code>
        <div className="row wrap">
          <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
          <button type="button" disabled={!qr} onClick={() => printQr(sceneName, link, qr)}>Print QR</button>
          <a className="button" href={link} target="_blank" rel="noreferrer">Open</a>
        </div>
        <span className="muted small">Anyone with the link can send files here. They see that a file arrived, not the results.</span>
        <div className="row wrap">
          <button type="button" className="ghost" onClick={() => void change("POST", "Make a new link? The current link and printed QR codes stop working.")}>New link</button>
          <button type="button" className="ghost danger" onClick={() => void change("DELETE", "Turn the upload link off? It and printed QR codes stop working.")}>Turn off</button>
        </div>
      </div>
    </div>
  );
}

function IntegrationDialog({ sceneId, sceneName, onClose }: { sceneId: string; sceneName: string; onClose: () => void }) {
  const [info, setInfo] = useState<Integration | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<"receive" | "send">("receive");
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
    <Dialog title="Automation" onClose={onClose} wide>
      {!info ? <p className="muted">{error || "Loading…"}</p> : (
        <div className="form">
          <div className="tabs dialog-tabs" role="tablist" aria-label="Automation">
            <button role="tab" id="auto-tab-receive" aria-controls="auto-panel" aria-selected={tab === "receive"} className={tab === "receive" ? "on" : undefined} onClick={() => setTab("receive")}>↓ Receive photos</button>
            <button role="tab" id="auto-tab-send" aria-controls="auto-panel" aria-selected={tab === "send"} className={tab === "send" ? "on" : undefined} onClick={() => setTab("send")}>↑ Send results</button>
          </div>
          <div id="auto-panel" role="tabpanel" aria-labelledby={`auto-tab-${tab}`} className="form">
            {tab === "receive" ? (
              <>
                <p className="muted small" style={{ margin: 0 }}>Ways to get photos and videos into this scene. Each one is checked like an upload.</p>
                <h3 className="dialog-section">Upload link for your team</h3>
                <UploadLinkSection sceneId={sceneId} sceneName={sceneName} info={info} onChange={show} onError={setError} />
                <h3 className="dialog-section">From other systems</h3>
                <p className="muted small" style={{ margin: 0 }}>Send to this scene's address from Zapier, Make, a script or a phone shortcut.</p>
                <label>Send a photo
                  <code className="copyable">{`curl -H "Authorization: Bearer ${info.token}" -F image=@photo.jpg ${endpoint}`}</code>
                </label>
                <label>Send a video
                  <code className="copyable">{`curl -H "Authorization: Bearer ${info.token}" -H "Content-Type: video/mp4" --data-binary @video.mp4 "${endpoint}?name=Morning%20round"`}</code>
                  <span className="muted small">Any photo or video can also go as the raw body with its own Content-Type. Up to 15 MB per photo, 200 MB per video.</span>
                </label>
              </>
            ) : (
              <>
                <p className="muted small" style={{ margin: 0 }}>Where this scene's results go. Every finished check and video is posted to your webhook as JSON.</p>
                <form onSubmit={save} className="form" style={{ gap: 4 }}>
                  <label htmlFor="webhook-url">Webhook URL</label>
                  <div className="row">
                    <input id="webhook-url" type="url" value={webhookUrl} maxLength={500} placeholder="https://example.com/truescene"
                      onChange={(e) => { setWebhookUrl(e.target.value); setSaved(false); }} style={{ flex: 1 }} />
                    <button className="primary">{saved ? "Saved" : "Save"}</button>
                  </div>
                </form>
                <label>Signing secret
                  <code className="copyable">{info.webhookSecret}</code>
                  <span className="muted small">Each delivery carries X-TrueScene-Signature: sha256=HMAC-SHA256 of the body with this secret.</span>
                </label>
                <DigestSection sceneId={sceneId} info={info} onChange={show} onError={setError} />
              </>
            )}
          </div>
          {error && <p className="err" role="alert">{error}</p>}
          <div className="row end">
            <button className="ghost" onClick={rotate} title="Makes a new upload token and a new signing secret">New token and secret</button>
            <button onClick={onClose}>Done</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// The Muse Wonder report overview, posted daily, weekly or monthly as report.summary to the saved webhook.
// The server keeps the schedule in UTC (weekly = Mondays, monthly = the 1st); labels show it in the viewer's local time,
// which can fall on the day before or after.
type Every = Integration["digestEvery"];
const EVERY_LABEL: Record<Every, string> = { day: "Daily", week: "Weekly", month: "Monthly" };
const slot = (utcHour: number, utcDay = 1) => new Date(Date.UTC(2024, 0, utcDay, utcHour)); // Jan 1 2024 was a Monday
const localTime = (utcHour: number) => slot(utcHour).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function scheduleText(every: Every, utcHour: number) {
  const at = localTime(utcHour), d = slot(utcHour);
  if (every === "day") return `every day at ${at}`;
  if (every === "week") return `every ${d.toLocaleDateString(undefined, { weekday: "long" })} at ${at}`;
  const date = d.getDate(); // local date of the UTC 1st: 1, 2, or 31 (the last day of the month before)
  return `${date === 1 ? "on the 1st of every month" : date === 2 ? "on the 2nd of every month" : "on the last day of every month"} at ${at}`;
}

function DigestSection({ sceneId, info, onChange, onError }: { sceneId: string; info: Integration; onChange: (i: Integration) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [sent, setSent] = useState(false);
  const run = async (kind: "save" | "send", call: () => Promise<Integration>) => {
    setBusy(kind);
    try {
      onChange(await call());
      onError("");
      if (kind === "send") { setSent(true); setTimeout(() => setSent(false), 2000); }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = (hour: number | null, every: Every) => void run("save", () =>
    api<Integration>(`/api/scenes/${sceneId}/integration/digest`, { method: "PUT", body: JSON.stringify({ hour, every }) }));
  // Turning it on starts at 08:00 local time.
  const morning = () => { const d = new Date(); d.setHours(8, 0, 0, 0); return d.getUTCHours(); };
  const setEvery = (value: string) => value === "" ? save(null, info.digestEvery) : save(info.digestHour ?? morning(), value as Every);
  const sendNow = () => void run("send", () => post<Integration>(`/api/scenes/${sceneId}/integration/digest/send`, {}));
  const noWebhook = !info.webhookUrl, on = info.digestHour !== null, locked = noWebhook || busy !== null;

  return (
    <>
      <h3 className="dialog-section">Report summary</h3>
      <p className="muted small" style={{ margin: 0 }}>
        Muse Wonder summarises this scene's report and posts it to your webhook as <code>report.summary</code>, with a ready-to-send <code>text</code> field.
        Forward it to email or Slack with Zapier or Make.
      </p>
      <div className="row">
        <label htmlFor="digest-every" className="muted small" style={{ whiteSpace: "nowrap" }}>Send</label>
        <select id="digest-every" value={on ? info.digestEvery : ""} disabled={locked} onChange={(e) => setEvery(e.target.value)}>
          <option value="">Off</option>
          {(Object.keys(EVERY_LABEL) as Every[]).map((k) => <option key={k} value={k}>{EVERY_LABEL[k]}</option>)}
        </select>
        {on && (
          <>
            <label htmlFor="digest-hour" className="muted small">at</label>
            <select id="digest-hour" value={info.digestHour!} disabled={locked} onChange={(e) => save(Number(e.target.value), info.digestEvery)}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{localTime(h)}</option>)}
            </select>
          </>
        )}
        <button type="button" onClick={sendNow} disabled={locked}>{busy === "send" ? "Sending…" : sent ? "Sent ✓" : "✦ Send now"}</button>
      </div>
      <span className="muted small">
        {noWebhook ? "Save a webhook URL above to turn this on."
          : `${on ? `Goes out ${scheduleText(info.digestEvery, info.digestHour!)}, skipped when there are no new inspections. ` : ""}${info.digestSentAt ? `Last sent ${ago(info.digestSentAt)}.` : "Not sent yet."}`}
      </span>
    </>
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

// ---------- initial photo + what we watch, with the checklist beside it ----------
function GoldenPanel({ scene, reload, onError, checklist }: { scene: Scene; reload: () => Promise<unknown>; onError: (m: string) => void; checklist: ReactNode }) {
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
    if (scene.items.length && !confirm("A new initial photo clears what we watch (positions change) and finds objects again. Continue?")) return;
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

  const update = async (item: Item, patch: Partial<Pick<Item, "name" | "phrase" | "expectedCount" | "positionMatters" | "boxes">>) => {
    try {
      await api(`/api/items/${item.id}`, { method: "PUT", body: JSON.stringify(patch) });
      await reload();
    } catch (err) {
      onError((err as Error).message);
    }
  };
  // Stop watching one of an item's objects; the server also stops counting matches in that spot.
  const removeBox = async (item: Item, index: number) => {
    if (!confirm(`Stop watching this ${item.name}? We'll expect ${item.expectedCount - 1} from now on, and ignore whatever is in that spot.`)) return;
    try {
      await api(`/api/items/${item.id}`, { method: "PUT", body: JSON.stringify({ removeBox: index }) });
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
        <h2>Add the initial photo</h2>
        <p className="muted">Photograph the scene when it looks exactly right, from the spot every inspection will use. TrueScene then finds the objects in it.</p>
        <button className="primary" onClick={() => fileRef.current?.click()} disabled={!!busy}>{label}</button>
        {busy === "upload" && progress !== null && (
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Uploading initial photo"
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
  const status = busy === "upload" ? `Uploading the initial photo… ${progress ?? 0}%`
    : busy === "detect" ? "Finding objects: Spark lists them, SAM outlines and counts each…"
    : pending ? "Outlining that object, naming it and counting matches…" : null;

  return (
    <section className={`panel golden${collapsed ? " collapsed" : ""}`}>
      {input}
      <div className="panel-head">
        <CollapseButton collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} label="Initial photo and checklist" />
        <div style={{ flex: 1 }}>
          <h2>Initial photo &amp; checklist</h2>
          <p className="muted">The standard every inspection is checked against: the objects SAM counts on the photo, and the rules Spark checks.</p>
        </div>
      </div>
      {!collapsed && (
      <div className="setup-body">
      <div className="setup-photo">
      <div className="setup-head">
        <h3>Initial photo</h3>
        <div className="row">
          <button onClick={detect} disabled={!!busy || !!pending}>Find objects</button>
          <button onClick={replace} disabled={!!busy}>Replace photo</button>
        </div>
      </div>
      <p className="muted small">Hover an object to see what we watch, click one to edit it and drag its box; click empty space to add an object.</p>
      {status && (
        <div className="banner info" role={busy === "upload" ? "progressbar" : undefined}
          aria-valuemin={busy === "upload" ? 0 : undefined} aria-valuemax={busy === "upload" ? 100 : undefined}
          aria-valuenow={busy === "upload" ? (progress ?? 0) : undefined} aria-label={busy === "upload" ? "Uploading initial photo" : undefined}>
          <span className="spinner" /> <span>{status}</span>
          {busy === "upload" && progress !== null && (
            <span className="bar" style={{ flex: 1, minWidth: 120, marginTop: 0 }}><div style={{ width: `${progress}%` }} /></span>
          )}
        </div>
      )}
      <AnnotatedPhoto media={g} label="Initial photo" shapes={shapes} active={active} onActive={setActive} busyAt={pending}
        onPick={(itemId) => setOpen(itemId)} onEmptyClick={tap} editable={open}
        onBoxChange={async (itemId, boxes) => { const item = scene.items.find((i) => i.id === itemId); if (item) await update(item, { boxes }); }}
        onBoxDelete={(itemId, index) => { const item = scene.items.find((i) => i.id === itemId); if (item) void removeBox(item, index); }} />

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
      </div>
      <div className="setup-side">{checklist}</div>
      </div>
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
          <p className="muted small">Drag the box on the photo to move it, or a corner to resize it.
            {item.boxes.length > 1 && " Press ✕ on a box to stop watching just that one."}</p>
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

// Shown beside the initial photo, inside its panel.
function Checklist({ scene, onSaved, onError }: { scene: Scene; onSaved: (rules: Rule[]) => void; onError: (m: string) => void }) {
  const rules = scene.checklist;
  const sections = [...new Set(rules.map((r) => r.section))];
  const [draft, setDraft] = useState("");
  const [section, setSection] = useState(sections[0] ?? NEW_SECTION);
  const [newSection, setNewSection] = useState("");
  const [drafting, setDrafting] = useState(false);
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
    <>
      <div className="setup-head">
        <h3>Checklist <span className="count">{rules.length}</span></h3>
        <button onClick={wonder} disabled={drafting}>{drafting ? "Muse Wonder is writing…" : "✦ Draft with Muse Wonder"}</button>
      </div>
      <p className="muted small">What must be true, beyond the watched objects. Spark checks every rule on every inspection.</p>
      {rules.length === 0 && <p className="muted small">No rules yet. Draft a starter checklist from the initial photo, or write your own below.</p>}
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
  );
}

function RuleEditor({ rule, onSave, onDelete }: { rule: Rule; onSave: (text: string) => void; onDelete: () => void }) {
  const [text, setText] = useState(rule.text);
  useEffect(() => setText(rule.text), [rule.text]);
  return (
    <div className="rule-edit">
      {/* Wraps and grows with the text, so long rules stay readable in the narrow column. Enter saves. */}
      <textarea rows={1} value={text} maxLength={200} aria-label="Rule" onChange={(e) => setText(e.target.value.replace(/\n/g, " "))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
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
  const [gone, setGone] = useState<string | null>(null);
  const activeId = checkId && checkId !== gone ? checkId : null;
  const waiting = (checks ?? []).filter((c) => c.reviewStatus === "needs_review" && c.status !== "running");
  const selected = activeId ?? waiting.at(-1)?.id ?? checks?.[0]?.id ?? null;
  const count = (f: Filter) => (checks ?? []).filter((c) => f === "all" || c.reviewStatus === f).length;
  // An inspection in the URL but not in the list was either just uploaded (the list hasn't caught up) or deleted:
  // reload once, and only call it gone if it's still missing.
  useEffect(() => {
    if (!checkId || !known || known.has(checkId) || checkId === gone) return;
    let live = true;
    api<CheckSummary[]>(`/api/scenes/${scene.id}/checks?limit=100`).then((fresh) => {
      if (!live) return;
      setChecks(fresh);
      if (!fresh.some((c) => c.id === checkId)) setGone(checkId);
    }).catch(() => {});
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkId, checks, scene.id]);
  // Pin the default choice in the URL, so marking it reviewed doesn't jump to another inspection.
  // Also repairs the URL when it points to a deleted inspection.
  useEffect(() => {
    if (selected && (!checkId || checkId === gone)) location.replace(`#/scenes/${scene.id}/i/${selected}`);
  }, [checkId, selected, scene.id, gone]);

  // Inspections checked against an older setup; re-checking them all queues them like a batch of uploads.
  const outdated = (checks ?? []).filter((c) => c.outdated);
  const [rechecking, setRechecking] = useState(false);
  const recheckOutdated = async () => {
    const done = (checks ?? []).filter((c) => c.status !== "running" && c.costUsd > 0);
    const each = done.length ? done.reduce((n, c) => n + c.costUsd, 0) / done.length : 0;
    const reviewed = outdated.filter((c) => c.reviewStatus === "reviewed").length;
    if (!confirm(`Check ${plural(outdated.length, "inspection")} again with the current initial photo, items and checklist?` +
      (each ? ` About $${(each * outdated.length).toFixed(2)}.` : "") +
      (reviewed ? ` ${reviewed} reviewed will need review again; their current results stay in the history.` : ""))) return;
    setRechecking(true);
    onError("");
    try {
      await post(`/api/scenes/${scene.id}/recheck`, { by: getReviewer() || undefined });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setRechecking(false);
      void load();
    }
  };

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
          <p className="muted">Every photo and video frame checked against the initial photo. A person marks each one reviewed.</p>
        </div>
        <div className="row">
          {outdated.length > 0 && <button onClick={recheckOutdated} disabled={rechecking}>{rechecking ? "Starting…" : `Re-check ${outdated.length} outdated`}</button>}
        </div>
      </div>
      {!collapsed && (
      <>
      <VideoNotices sceneId={scene.id} onError={onError} />
      {checks && checks.length === 0 ? (
        <div className="empty small">
          <p className="muted">No inspections yet. Stand where the initial photo was taken and take a photo or a short video.</p>
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
              {shown.map((c) => {
                const isVideo = c.source.type === "video";
                return (
                <li key={c.id} className="irow-wrap">
                  <a href={`#/scenes/${scene.id}/i/${c.id}`} className={`irow${c.id === selected ? " on" : ""}${isVideo ? " is-video" : " is-photo"}`} aria-current={c.id === selected ? "true" : undefined}>
                    <span className="ithumb">
                      <img src={c.snapshot.url} alt="" loading="lazy" />
                      {isVideo && <span className="play-badge" aria-hidden="true">▶</span>}
                    </span>
                    <span className="irow-main">
                      <span className="irow-title"><SourceIcon source={c.source} /> {c.source.type === "video" ? c.source.inspectionName : "Photo"} <span className={`src-badge${isVideo ? " is-video" : " is-photo"}`}>{isVideo ? "Video" : "Photo"}</span></span>
                      <span className="muted small">{ago(c.takenAt)}{c.uploadedBy && ` · ${c.uploadedBy}`}</span>
                      <span className="irow-tags">
                        <ReviewPill c={c} />
                        {c.issues > 0 && <span className="tag-issue">{plural(c.issues, "issue")}</span>}
                        {c.flags > 0 && <span className="tag-review">{c.flags} to decide</span>}
                        {c.outdated && <span className="tag-outdated" title="The setup changed after this inspection was checked">Outdated</span>}
                      </span>
                    </span>
                  </a>
                  <button type="button" className="icon irow-delete" aria-label={`Delete inspection from ${ago(c.takenAt)}`}
                    title="Delete this inspection" onClick={() => remove(c.id, c.status === "running")}>✕</button>
                </li>
                );
              })}
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

const MAX_BATCH = 20;

// "+ New inspection" → photos or a video. Each photo becomes its own inspection; they upload one at a time and the
// server dates each one from the camera (EXIF), so the order picked doesn't matter. A video becomes one inspection
// per time it shows the scene; until then the scene page shows a notice for it (VideoNotices).
export function NewInspectionButton({ sceneId, primary, onError }: { sceneId: string; primary?: boolean; onError: (message: string) => void }) {
  const photoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ kind: "photo" | "video"; n: number; of: number; pct: number; name?: string; sizeMB?: number } | null>(null);
  const showInspections = () => document.getElementById("inspections")?.scrollIntoView({ behavior: "smooth" });

  const sendPhotos = async (picked: File[]) => {
    if (!picked.length) return;
    if (picked.length > MAX_BATCH) return onError(`Choose up to ${MAX_BATCH} photos at a time.`);
    onError("");
    const failed: string[] = [];
    const started: { checkId: string; takenAt: string }[] = [];
    for (const [i, file] of picked.entries()) {
      setUpload({ kind: "photo", n: i + 1, of: picked.length, pct: 0 });
      if (!file.type.startsWith("image/")) {
        failed.push(`${file.name}: not a photo (use JPEG, PNG or WebP)`);
        continue;
      }
      const body = new FormData();
      body.append("image", file);
      try {
        started.push(await uploadForm<{ checkId: string; takenAt: string }>(`/api/scenes/${sceneId}/snapshots`, body,
          (pct) => setUpload({ kind: "photo", n: i + 1, of: picked.length, pct })));
      } catch (err) {
        failed.push(picked.length > 1 ? `${file.name}: ${(err as Error).message}` : (err as Error).message);
      }
    }
    setUpload(null);
    if (photoRef.current) photoRef.current.value = "";
    if (failed.length) {
      onError(picked.length > 1 ? `${failed.length} of ${picked.length} photos weren't added. ${failed.join(" · ")}` : failed[0]);
    }
    // Open the earliest photo of the batch, so review goes in the order they were taken.
    const first = started.sort((a, b) => a.takenAt.localeCompare(b.takenAt))[0];
    if (first) {
      location.hash = `#/scenes/${sceneId}/i/${first.checkId}`;
      showInspections();
    }
  };

  const sendVideo = async (file: File | undefined) => {
    if (!file) return;
    onError("");
    setUpload({ kind: "video", n: 1, of: 1, pct: 0, name: file.name, sizeMB: file.size / 1024 / 1024 });
    try {
      await uploadVideo(file, [sceneId], (pct) => setUpload((u) => (u?.kind === "video" ? { ...u, pct } : u)));
      showInspections();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setUpload(null);
      if (videoRef.current) videoRef.current.value = "";
    }
  };

  const total = upload ? Math.round(((upload.n - 1) * 100 + upload.pct) / upload.of) : 0;
  if (upload?.kind === "video") {
    return (
      <span className="upload-wrap">
        <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={(e) => sendPhotos([...(e.target.files ?? [])])} />
        <input ref={videoRef} type="file" accept="video/*" hidden onChange={(e) => sendVideo(e.target.files?.[0])} />
        <div className="upload-card upload-video" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.pct}
          aria-label={`Uploading video${upload.name ? ` ${upload.name}` : ""}`}>
          <span className="upload-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3z" /></svg>
          </span>
          <span className="upload-body">
            <span className="upload-top"><b>Uploading video…</b><span className="upload-pct">{upload.pct}%</span></span>
            {(upload.name || upload.sizeMB !== undefined) && (
              <span className="muted small upload-name">
                {[upload.name, upload.sizeMB !== undefined ? `${upload.sizeMB.toFixed(1)} MB` : ""].filter(Boolean).join(" · ")}
              </span>
            )}
            <span className="upload-bar"><div style={{ width: `${upload.pct}%` }} /></span>
            <span className="muted small">Keep this page open — finding the scene starts automatically.</span>
          </span>
        </div>
      </span>
    );
  }
  return (
    <span className="upload-wrap">
      <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={(e) => sendPhotos([...(e.target.files ?? [])])} />
      <input ref={videoRef} type="file" accept="video/*" hidden onChange={(e) => sendVideo(e.target.files?.[0])} />
      {upload ? (
        <button className={primary ? "primary" : undefined} disabled>
          {upload.of > 1 ? `Uploading ${upload.n} of ${upload.of}…` : `Uploading… ${upload.pct}%`}
        </button>
      ) : (
        <>
          <button className="btn-photo" onClick={() => photoRef.current?.click()}
            title={`Up to ${MAX_BATCH} photos at a time`}>+ Add photos <span className="btn-sub">up to {MAX_BATCH}</span></button>
          <button className="btn-video" onClick={() => videoRef.current?.click()} title="One video, up to 3 min">+ Add video <span className="btn-sub">up to 3 min</span></button>
        </>
      )}
      {upload && (
        <span className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={total}
          aria-label="Uploading photos">
          <span className="bar"><div style={{ width: `${total}%` }} /></span>
        </span>
      )}
    </span>
  );
}

// Videos uploaded for this scene that haven't become inspections: still being processed, or the scene wasn't seen
// in them / processing failed (dismissable). Found frames show up as ordinary inspections instead.
function VideoNotices({ sceneId, onError }: { sceneId: string; onError: (m: string) => void }) {
  const [notices, setNotices] = useState<VideoNotice[]>([]);
  const load = useCallback(() => api<VideoNotice[]>(`/api/video/scenes/${sceneId}`).then(setNotices).catch(() => {}), [sceneId]);
  useEffect(() => void load(), [load]);
  useStream<{ id: string; sceneId?: string }>("inspection", (e) => (!e.sceneId || e.sceneId === sceneId) && void load());

  const dismiss = async (n: VideoNotice) => {
    setNotices((prev) => prev.filter((x) => x.inspectionId !== n.inspectionId));
    try {
      await api(`/api/video/inspections/${n.inspectionId}/scenes/${sceneId}`, { method: "DELETE" });
    } catch (err) {
      onError((err as Error).message);
      void load();
    }
  };

  if (!notices.length) return null;
  return (
    <ul className="video-notices">
      {notices.map((n) => {
        const busy = n.status === "pending" || n.status === "checking";
        return (
          <li key={n.inspectionId} className={`video-notice${busy ? "" : n.status === "failed" ? " failed" : " not-seen"}`} role={busy ? "status" : undefined}>
            {busy ? <span className="spinner" /> : <SourceIcon source={{ type: "video", inspectionId: n.inspectionId, inspectionName: n.name, frameMs: null }} />}
            <span className="irow-main">
              <strong>{n.name}</strong>
              <span className="muted small">
                {busy ? `${n.stage ?? "Finding the scene"}…` : n.status === "failed" ? "The video couldn't be checked." : "This scene wasn't seen in the video."}
                {!busy && n.note && ` ${n.note}`} · {ago(n.createdAt)}
              </span>
            </span>
            {!busy && <button type="button" className="sm ghost" onClick={() => dismiss(n)}>Dismiss</button>}
          </li>
        );
      })}
    </ul>
  );
}
