import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SectionTabs, VideoSection } from "./video.js";

// ---------- API ----------
type UnitBox = { left: number; top: number; right: number; bottom: number };
type Item = {
  id: string; name: string; phrase: string; expectedCount: number; boxes: UnitBox[]; tapBox: UnitBox;
  mask: { path: string; dx: number; dy: number } | null; phraseMatches: boolean; positionMatters: boolean;
};
type Golden = { url: string; w: number; h: number };
type CheckStatus = "running" | "ok" | "issues" | "needs_review" | "retake" | "failed";
type SceneSummary = {
  id: string; name: string; type: string; golden: Golden | null; itemCount: number;
  lastCheck?: { status: CheckStatus; createdAt: string } | null;
};
type Scene = SceneSummary & { items: Item[] };
type Run = { id: number; step: string; model: string; input_summary: string; ms: number; cost_usd: number; error: string | null; at: string; output_json: string | null };

type Finding = {
  id: string; kind: string; text: string; itemId: string | null; boxes: UnitBox[]; goldenBoxes: UnitBox[];
  mask: { path: string; dx: number; dy: number } | null; source: "sam" | "spark" | "both";
  status: "confirmed" | "needs_review" | "rejected"; why: string;
};
type ItemResult = { itemId: string; name: string; expected: number; found: number; boxes: UnitBox[]; goldenBoxes: UnitBox[]; ok: boolean };
type CheckSummary = {
  id: string; sceneId: string; status: CheckStatus; createdAt: string; costUsd: number; findingCount: number;
  score: { ok: number; total: number } | null; snapshot: Golden;
  // The golden photo this check was compared with (the scene's may have been replaced since).
  golden: Golden;
};
type Check = CheckSummary & { result: { sameView?: boolean; viewNote?: string; items?: ItemResult[]; findings?: Finding[]; error?: string } };

class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof data.error === "string" ? data.error : `Request failed (${res.status})`, res.status);
  return data as T;
}

// One shared connection to the server's live updates (run, check, event).
let stream: EventSource | null = null;
function useStream<T>(type: string, on: (data: T) => void) {
  const ref = useRef(on);
  useEffect(() => { ref.current = on; });
  useEffect(() => {
    stream ??= new EventSource("/api/stream");
    const handler = (e: Event) => ref.current(JSON.parse((e as MessageEvent).data));
    stream.addEventListener(type, handler);
    return () => stream?.removeEventListener(type, handler);
  }, [type]);
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const COLOURS = ["#378add", "#1d9e75", "#d85a30", "#7f77dd", "#d4537e", "#ba7517", "#639922", "#e24b4a"];

// ---------- routing ----------
function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

function App() {
  const [session, setSession] = useState<{ loginRequired: boolean; ok: boolean } | null>(null);
  const [down, setDown] = useState("");
  const route = useHashRoute();
  useEffect(() => {
    api<{ loginRequired: boolean; ok: boolean }>("/api/session").then(setSession).catch((e) => setDown(e.message));
  }, []);
  if (down) return <div className="shell"><div className="banner error">Couldn't reach the GoldenFrame server: {down}</div></div>;
  if (!session) return null;
  if (!session.ok) return <Login onDone={() => setSession({ ...session, ok: true })} />;
  const sceneMatch = route.match(/^\/scenes\/([\w-]+)$/);
  const checkMatch = route.match(/^\/checks\/([\w-]+)$/);
  return (
    <div className="shell">
      <div className="topbar">
        <a href="#/" className="brand">GoldenFrame</a>
        <SectionTabs route={route} />
        <Spend />
      </div>
      {route.startsWith("/videos") ? <VideoSection route={route} /> : checkMatch ? <CheckResult id={checkMatch[1]} /> : sceneMatch ? <SceneSetup id={sceneMatch[1]} /> : <Scenes />}
    </div>
  );
}

function Spend() {
  const [s, setS] = useState<{ todayUsd: number; limitUsd: number } | null>(null);
  useEffect(() => {
    const load = () => api<{ todayUsd: number; limitUsd: number }>("/api/spend").then(setS).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  return s ? <span className="muted small">Model spend today ${s.todayUsd.toFixed(3)} of ${s.limitUsd}</span> : null;
}

function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="shell" style={{ maxWidth: 380 }}>
      <h1 style={{ marginBottom: 12 }}>GoldenFrame</h1>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!code.trim()) return setError("Enter the access code.");
          try {
            await api("/api/login", { method: "POST", body: JSON.stringify({ code }) });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label className="small muted" htmlFor="code">Access code</label>
        <input id="code" type="password" value={code} onChange={(e) => { setCode(e.target.value); setError(""); }} autoFocus />
        {error && <p className="err small">{error}</p>}
        <button className="primary" style={{ marginTop: 12 }}>Enter</button>
      </form>
    </div>
  );
}

// ---------- scenes list ----------
function Scenes() {
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => api<SceneSummary[]>("/api/scenes").then(setScenes).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the scene a name, for example \"Room 101 – bed area\".");
    try {
      const scene = await api<SceneSummary>("/api/scenes", { method: "POST", body: JSON.stringify({ name, type: "golden" }) });
      location.hash = `#/scenes/${scene.id}`;
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1>Scenes</h1>
      </div>
      <form className="card row" onSubmit={create} style={{ marginBottom: 16 }}>
        <input type="text" placeholder="Room 101 – bed area" value={name} onChange={(e) => { setName(e.target.value); setError(""); }} aria-label="Scene name" />
        <button className="primary" style={{ whiteSpace: "nowrap" }}>Create scene</button>
      </form>
      {error && <div className="banner error">{error}</div>}
      {scenes && scenes.length === 0 && <p className="muted">Create your first scene: one place, photographed from one spot.</p>}
      <div className="grid">
        {scenes?.map((s) => (
          <a key={s.id} href={`#/scenes/${s.id}`} className="card scene-card" style={{ color: "inherit" }}>
            {s.golden ? <img src={s.golden.url} alt="" /> : <div className="placeholder muted small">No golden photo yet</div>}
            <div style={{ marginTop: 10, fontWeight: 600 }}>{s.name}</div>
            <div className="row small" style={{ justifyContent: "space-between" }}>
              <span className="muted">{s.itemCount} item{s.itemCount === 1 ? "" : "s"}</span>
              {s.lastCheck && <StatusBadge status={s.lastCheck.status} />}
            </div>
          </a>
        ))}
      </div>
    </>
  );
}

// ---------- scene setup: golden photo + tap to make a rule ----------
function SceneSetup({ id }: { id: string }) {
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api<Scene>(`/api/scenes/${id}`).then(setScene).catch((e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Choose a photo (JPEG, PNG or WebP).");
    setUploading(true);
    setError("");
    const body = new FormData();
    body.append("image", file);
    try {
      await api(`/api/scenes/${id}/golden`, { method: "POST", body });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const tap = async (e: React.MouseEvent) => {
    if (!scene?.golden || !imgRef.current || pending) return;
    const rect = imgRef.current.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
    setPending({ x: fx, y: fy });
    setError("");
    try {
      await api(`/api/scenes/${id}/items/tap`, {
        method: "POST",
        body: JSON.stringify({ x: Math.round(fx * scene.golden.w), y: Math.round(fy * scene.golden.h) }),
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const update = async (item: Item, patch: Partial<Pick<Item, "name" | "phrase" | "expectedCount" | "positionMatters">>) => {
    try {
      await api(`/api/items/${item.id}`, { method: "PUT", body: JSON.stringify(patch) });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (item: Item) => {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    await load();
  };

  if (!scene) return error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>;
  const g = scene.golden;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <a href="#/" className="small">← Scenes</a>
          <h1>{scene.name}</h1>
        </div>
        {g && (
          <div className="row">
            <button onClick={() => fileRef.current?.click()} disabled={uploading}>Replace golden photo</button>
            <CheckPhotoButton sceneId={id} primary onError={setError} />
          </div>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
      {error && <div className="banner error" role="alert">{error}</div>}

      {!g ? (
        <div className="drop card">
          <h2>Upload the golden photo</h2>
          <p className="muted">Photograph the place in its correct state, from the spot staff will use later.</p>
          <button className="primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Uploading…" : "Choose photo"}
          </button>
        </div>
      ) : (
        <div className="setup">
          <div>
            <div className="stage" onClick={tap} role="button" aria-label="Golden photo. Click an object to add it as an item.">
              <img ref={imgRef} src={g.url} alt="Golden photo" draggable={false} />
              <svg viewBox={`0 0 ${g.w} ${g.h}`} preserveAspectRatio="none" aria-hidden="true">
                {scene.items.map((item, i) => {
                  const c = COLOURS[i % COLOURS.length];
                  return (
                    <g key={item.id}>
                      {item.mask && (
                        <g transform={`translate(${item.mask.dx} ${item.mask.dy})`}>
                          <path d={item.mask.path} fill={c} fillOpacity={0.35} />
                        </g>
                      )}
                      {item.boxes.map((b, j) => (
                        <rect key={j} x={b.left * g.w} y={b.top * g.h} width={(b.right - b.left) * g.w} height={(b.bottom - b.top) * g.h}
                          fill="none" stroke={c} strokeWidth={Math.max(3, g.w / 400)} rx={6} />
                      ))}
                    </g>
                  );
                })}
              </svg>
              {pending && <div className="pending-dot" style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }} />}
            </div>
            <p className="muted small">
              {pending ? "Finding the object, naming it and counting matches…" : "Click any object that matters (a pillow, a lamp, a towel). It becomes a rule."}
            </p>
          </div>

          <div className="card">
            <h2>Items</h2>
            {scene.items.length === 0 && <p className="muted small">No items yet. Click objects in the photo.</p>}
            {scene.items.map((item, i) => (
              <ItemEditor key={item.id} item={item} colour={COLOURS[i % COLOURS.length]} onSave={(p) => update(item, p)} onDelete={() => remove(item)} />
            ))}
          </div>
        </div>
      )}
      {g && <Checks sceneId={id} />}
      <RunLog sceneId={id} />
    </>
  );
}

function ItemEditor({ item, colour, onSave, onDelete }: {
  item: Item; colour: string;
  onSave: (p: Partial<Pick<Item, "name" | "phrase" | "expectedCount" | "positionMatters">>) => void; onDelete: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [phrase, setPhrase] = useState(item.phrase);
  useEffect(() => { setName(item.name); setPhrase(item.phrase); }, [item.name, item.phrase]);
  return (
    <div className="item">
      <div className="row">
        <span className="swatch" style={{ background: colour }} />
        <input type="text" value={name} aria-label="Item name" onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== item.name && onSave({ name })} />
        <button className="ghost" onClick={onDelete} aria-label={`Delete ${item.name}`}>✕</button>
      </div>
      <div className="row small">
        <label className="muted" style={{ whiteSpace: "nowrap" }}>Match</label>
        <input type="text" value={phrase} aria-label="Phrase used to find it" onChange={(e) => setPhrase(e.target.value)}
          onBlur={() => phrase.trim() && phrase !== item.phrase && onSave({ phrase })} />
        <label className="muted">×</label>
        <input type="number" className="count" min={0} max={50} value={item.expectedCount} aria-label="Expected count"
          onChange={(e) => onSave({ expectedCount: Math.max(0, Math.min(50, Math.round(Number(e.target.value) || 0))) })} />
      </div>
      <label className="row small muted">
        <input type="checkbox" checked={item.positionMatters} onChange={(e) => onSave({ positionMatters: e.target.checked })} />
        Position matters
      </label>
      {!item.phraseMatches && <span className="small warn">The phrase didn't find this exact object again. Try a simpler word.</span>}
    </div>
  );
}

// ---------- run log (every model call, live) ----------
function RunLog({ sceneId, checkId }: { sceneId: string; checkId?: string }) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    api<Run[]>(`/api/scenes/${sceneId}/runs?limit=20${checkId ? `&checkId=${checkId}` : ""}`).then(setRuns).catch(() => {});
  }, [sceneId, checkId]);
  useStream<Run & { scene_id: string; check_id: string | null }>("run", (run) => {
    if (run.scene_id === sceneId && (!checkId || run.check_id === checkId)) setRuns((rs) => [run, ...rs].slice(0, 20));
  });
  if (!runs.length) return null;
  return (
    <div className="card runs">
      <h2>Run log</h2>
      <table>
        <thead><tr><th>Step</th><th>Model</th><th>Input</th><th>Result</th><th>Time</th><th>Cost</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{r.step}</td>
              <td className="muted">{r.model}</td>
              <td className="muted">{r.input_summary}</td>
              <td>{r.error ? <span className="err">{r.error}</span> : summarise(r.output_json)}</td>
              <td className="muted">{(r.ms / 1000).toFixed(1)} s</td>
              <td className="muted">${r.cost_usd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarise(json: string | null): string {
  if (!json) return "";
  const v = JSON.parse(json);
  if (typeof v?.count === "number") return `${v.count} match${v.count === 1 ? "" : "es"}`;
  if (v?.name) return `${v.name} · "${v.phrase}"`;
  if (v?.same_view === false) return "Different view";
  if (Array.isArray(v?.issues)) return `${v.issues.length} issue${v.issues.length === 1 ? "" : "s"} reported`;
  return JSON.stringify(v).slice(0, 120);
}

// ---------- checks: compare a new photo with the golden one ----------
const STATUS_LABEL: Record<CheckStatus, string> = {
  running: "Checking…", ok: "All good", issues: "Issues found", needs_review: "Needs review", retake: "Retake photo", failed: "Failed",
};

function StatusBadge({ status }: { status: CheckStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

function CheckPhotoButton({ sceneId, primary, onError }: { sceneId: string; primary?: boolean; onError: (message: string) => void }) {
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
      location.hash = `#/checks/${checkId}`;
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
        {busy ? "Uploading…" : "Check a new photo"}
      </button>
    </>
  );
}

function Checks({ sceneId }: { sceneId: string }) {
  const [checks, setChecks] = useState<CheckSummary[]>([]);
  const load = useCallback(() => api<CheckSummary[]>(`/api/scenes/${sceneId}/checks?limit=24`).then(setChecks).catch(() => {}), [sceneId]);
  useEffect(() => void load(), [load]);
  useStream<{ sceneId: string }>("check", (e) => e.sceneId === sceneId && void load());
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Checks</h2>
      {checks.length === 0 ? (
        <p className="muted small">No checks yet. Take a new photo from the same spot as the golden one and press "Check a new photo".</p>
      ) : (
        <div className="grid">
          {checks.map((c) => (
            <a key={c.id} href={`#/checks/${c.id}`} className="scene-card" style={{ color: "inherit" }}>
              <img src={c.snapshot.url} alt="" />
              <div className="row small" style={{ justifyContent: "space-between", marginTop: 6 }}>
                <StatusBadge status={c.status} />
                <span className="muted">{when(c.createdAt)}</span>
              </div>
              {c.score && c.score.total > 0 && <div className="muted small">{c.score.ok} of {c.score.total} items OK</div>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const SOURCE_LABEL = { sam: "SAM count", spark: "Spark", both: "SAM + Spark" } as const;

// A photo with an SVG layer in the photo's own pixel space.
function Photo({ src, w, h, label, children }: { src: string; w: number; h: number; label: string; children?: React.ReactNode }) {
  return (
    <figure className="photo">
      <figcaption className="small muted">{label}</figcaption>
      <div className="stage" style={{ cursor: "default" }}>
        <img src={src} alt={label} draggable={false} />
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">{children}</svg>
      </div>
    </figure>
  );
}

function Rect({ b, w, h, className }: { b: UnitBox; w: number; h: number; className: string }) {
  return <rect className={className} x={b.left * w} y={b.top * h} width={(b.right - b.left) * w} height={(b.bottom - b.top) * h}
    rx={6} strokeWidth={Math.max(3, w / 350)} />;
}

function CheckResult({ id }: { id: string }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null);

  const load = useCallback(() => api<Check>(`/api/checks/${id}`).then(setCheck).catch((e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (check && scene?.id !== check.sceneId) api<Scene>(`/api/scenes/${check.sceneId}`).then(setScene).catch((e) => setError(e.message));
  }, [check, scene?.id]);
  useStream<{ id: string }>("check", (e) => e.id === id && void load());

  const decide = async (findingId: string, decision: "confirm" | "reject") => {
    try {
      setCheck(await api<Check>(`/api/checks/${id}/review`, { method: "POST", body: JSON.stringify({ findingId, decision }) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!check || !scene) return error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>;
  const g = check.golden, n = check.snapshot;
  const findings = (check.result.findings ?? []).filter((f) => f.status !== "rejected");
  const rejected = (check.result.findings ?? []).filter((f) => f.status === "rejected");
  const items = check.result.items ?? [];
  const cls = (f: Finding) => `ov ov-${f.status}${active && active !== f.id ? " ov-dim" : ""}`;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <a href={`#/scenes/${scene.id}`} className="small">← {scene.name}</a>
          <div className="row">
            <h1>Check</h1>
            <StatusBadge status={check.status} />
          </div>
          <div className="muted small">
            {when(check.createdAt)}
            {check.status !== "running" && ` · model cost $${check.costUsd.toFixed(3)}`}
          </div>
        </div>
        <CheckPhotoButton sceneId={scene.id} onError={setError} />
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {check.status === "running" && (
        <div className="banner info"><span className="spinner" /> Spark is comparing the two photos while SAM counts {scene.items.length} item{scene.items.length === 1 ? "" : "s"}. Usually 10–30 seconds.</div>
      )}
      {check.status === "retake" && (
        <div className="banner warn-bg">This photo shows a different view, so nothing was compared. Retake it from the spot the golden photo was taken. {check.result.viewNote}</div>
      )}
      {check.status === "failed" && <div className="banner error">{check.result.error ?? "The check failed."}</div>}

      <div className="compare">
        <Photo src={g.url} w={g.w} h={g.h} label="Golden (how it should look)">
          {findings.flatMap((f) => f.goldenBoxes.map((b, j) => <Rect key={`${f.id}-${j}`} b={b} w={g.w} h={g.h} className={`${cls(f)} ov-dashed`} />))}
        </Photo>
        <Photo src={n.url} w={n.w} h={n.h} label="New photo">
          {items.filter((i) => i.ok).flatMap((i) => i.boxes.map((b, j) => <Rect key={`${i.itemId}-${j}`} b={b} w={n.w} h={n.h} className={`ov ov-ok${active ? " ov-dim" : ""}`} />))}
          {findings.map((f) => (
            <g key={f.id}>
              {f.mask && <g transform={`translate(${f.mask.dx} ${f.mask.dy})`}><path d={f.mask.path} className={`${cls(f)} ov-fill`} /></g>}
              {f.boxes.map((b, j) => <Rect key={j} b={b} w={n.w} h={n.h} className={`${cls(f)}${f.kind === "item_missing" ? " ov-dashed" : ""}`} />)}
            </g>
          ))}
        </Photo>
      </div>

      {check.status !== "running" && check.status !== "failed" && check.status !== "retake" && (
        <div className="setup" style={{ marginTop: 16 }}>
          <div className="card">
            <h2>Findings</h2>
            {findings.length === 0 && <p className="muted small">Nothing differs from the golden photo.</p>}
            {findings.map((f) => (
              <div key={f.id} className={`finding finding-${f.status}`} onMouseEnter={() => setActive(f.id)} onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(f.id)} onBlur={() => setActive(null)} tabIndex={0}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "start" }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{f.text}</div>
                    <div className="muted small">{f.why}</div>
                  </div>
                  <span className="chip small">{SOURCE_LABEL[f.source]}</span>
                </div>
                {f.status === "needs_review" && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="small warn" style={{ marginRight: "auto" }}>Needs your decision</span>
                    <button onClick={() => decide(f.id, "confirm")}>Confirm</button>
                    <button className="ghost" onClick={() => decide(f.id, "reject")}>Reject</button>
                  </div>
                )}
              </div>
            ))}
            {rejected.length > 0 && <p className="muted small">{rejected.length} finding{rejected.length === 1 ? "" : "s"} rejected by a person.</p>}
          </div>
          <div className="card">
            <h2>Items {check.score && check.score.total > 0 && <span className="muted small">· {check.score.ok} of {check.score.total} OK</span>}</h2>
            {items.length === 0 && <p className="muted small">No tagged items. Only Spark's comparison ran.</p>}
            {items.map((i) => (
              <div key={i.itemId} className="row small item-line">
                <span className={i.ok ? "ok" : "err"} aria-hidden="true">{i.ok ? "✓" : "✕"}</span>
                <span style={{ flex: 1 }}>{i.name}</span>
                <span className="muted">{i.found} of {i.expected}{i.ok || i.found !== i.expected ? "" : " · moved"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <RunLog sceneId={scene.id} checkId={check.id} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
