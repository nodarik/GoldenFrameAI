import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Run, type SceneSummary, type Video, api, columnOf, useStream } from "./api.js";
import { Board } from "./board.js";
import { RunTable } from "./inspection.js";
import { ScenePage } from "./scene.js";
import { UploadPage } from "./upload.js";

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

type Page =
  | { name: "board"; group: string | null }
  | { name: "scene"; id: string; checkId: string | null }
  | { name: "legacy-video"; id: string | null }
  | { name: "activity" }
  | { name: "legacy-check"; id: string };

function pageOf(route: string): Page {
  let m: RegExpMatchArray | null;
  if ((m = route.match(/^\/scenes\/([\w-]+)(?:\/i\/([\w-]+))?$/))) return { name: "scene", id: m[1], checkId: m[2] ?? null };
  if ((m = route.match(/^\/group\/(.+)$/))) return { name: "board", group: decodeURIComponent(m[1]) };
  if ((m = route.match(/^\/(?:walkthroughs|videos)(?:\/([\w-]+))?$/))) return { name: "legacy-video", id: m[1] && m[1] !== "checklists" ? m[1] : null };
  if ((m = route.match(/^\/checks\/([\w-]+)$/))) return { name: "legacy-check", id: m[1] };
  if (route === "/activity") return { name: "activity" };
  return { name: "board", group: null };
}

type Session = { loginRequired: boolean; ok: boolean; guest: boolean; expiresAt?: string };

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [down, setDown] = useState("");
  const load = useCallback(() => api<Session>("/api/session").then(setSession).catch((e) => setDown(e.message)), []);
  useEffect(() => void load(), [load]);
  if (down) return <div className="center"><div className="banner error">Couldn't reach the TrueScene server: {down}</div></div>;
  if (!session) return null;
  if (!session.ok) return <Login onDone={() => { location.hash = "#/"; void load(); }} />;
  return <Shell guest={session.guest} />;
}

function Shell({ guest }: { guest: boolean }) {
  const page = pageOf(useHashRoute());
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const loadScenes = useCallback(() => api<SceneSummary[]>("/api/scenes").then(setScenes).catch(() => {}), []);
  useEffect(() => void loadScenes(), [loadScenes]);
  useStream("check", () => void loadScenes());
  useEffect(() => setMenuOpen(false), [page.name, page.name === "scene" ? page.id : null]);

  const groups = [...new Set((scenes ?? []).map((s) => s.group).filter(Boolean))].sort();
  const assignees = [...new Set((scenes ?? []).map((s) => s.assignee).filter(Boolean))].sort();
  const toReview = (scenes ?? []).filter((s) => columnOf(s) === "review").length;

  return (
    <div className={`app${menuOpen ? " menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <a href="#/" className="brand"><Logo /> TrueScene</a>
          <button className="icon only-mobile" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>☰</button>
        </div>
        <nav className="nav" aria-label="Main">
          <div className="nav-label">Operations</div>
          <NavLink href="#/" on={page.name === "board" && page.group === null} icon="board" badge={toReview || undefined}>Scenes</NavLink>
          <NavLink href="#/activity" on={page.name === "activity"} icon="pulse">Model activity</NavLink>
          {groups.length > 0 && <div className="nav-label">Groups</div>}
          {groups.map((g) => (
            <NavLink key={g} href={`#/group/${encodeURIComponent(g)}`} on={page.name === "board" && page.group === g} icon="folder"
              badge={(scenes ?? []).filter((s) => s.group === g).length}>{g}</NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          {guest && <GuestNote />}
          <Spend />
          <div className="models small muted">Meta SAM 3.1 · Muse Spark · Muse Wonder</div>
        </div>
      </aside>
      <main className="main">
        {page.name === "board" && <Board scenes={scenes} group={page.group} onChange={loadScenes} />}
        {page.name === "scene" && <ScenePage id={page.id} checkId={page.checkId} groups={groups} assignees={assignees} onScenesChange={loadScenes} />}
        {page.name === "legacy-video" && <LegacyVideo id={page.id} />}
        {page.name === "activity" && <Activity />}
        {page.name === "legacy-check" && <LegacyCheck id={page.id} />}
      </main>
    </div>
  );
}

const ICONS: Record<string, string> = {
  board: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v6h-4z",
  pulse: "M3 12h4l3-7 4 14 3-7h4",
  folder: "M3 6h6l2 2h10v11H3z",
};

function NavLink({ href, on, icon, badge, children }: { href: string; on: boolean; icon: string; badge?: number; children: React.ReactNode }) {
  return (
    <a href={href} className={`nav-link${on ? " on" : ""}`} aria-current={on ? "page" : undefined}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[icon]} /></svg>
      <span className="nav-text">{children}</span>
      {badge !== undefined && <span className="nav-badge">{badge}</span>}
    </a>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--accent)" />
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="none" stroke="var(--gold)" strokeWidth="2" />
    </svg>
  );
}

// A guest works in a private copy of the demo scenes; leaving deletes it.
function GuestNote() {
  const leave = async () => {
    if (!confirm("Leave the demo? Your demo workspace and anything you added to it will be deleted.")) return;
    await api("/api/guest/leave", { method: "POST" }).catch(() => {});
    location.hash = "#/";
    location.reload();
  };
  return (
    <div className="guest-note small">
      <b>Demo workspace</b>
      <span className="muted">Your own copy of the demo scenes. Try anything: it's private to you and deleted after a week unused.</span>
      <button type="button" className="link" onClick={leave}>Leave demo</button>
    </div>
  );
}

function Spend() {
  const [s, setS] = useState<{ todayUsd: number; limitUsd: number; guest?: boolean } | null>(null);
  useEffect(() => {
    const load = () => api<{ todayUsd: number; limitUsd: number; guest?: boolean }>("/api/spend").then(setS).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  return (
    <div className="spend">
      <div className="row between small"><span className="muted">{s.guest ? "Demo model budget" : "Model spend today"}</span><b>${s.todayUsd.toFixed(2)} / ${s.limitUsd}</b></div>
      <div className="bar"><div style={{ width: `${Math.min(100, (s.todayUsd / s.limitUsd) * 100)}%` }} /></div>
    </div>
  );
}

function Activity() {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => { api<Run[]>("/api/runs?limit=150").then(setRuns).catch(() => {}); }, []);
  useStream<Run>("run", (run) => setRuns((rs) => [run, ...rs].slice(0, 150)));
  const total = runs.reduce((n, r) => n + r.cost_usd, 0);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Model activity</h1>
          <p className="muted">Every call to Meta's models, live: SAM 3.1 finds and counts objects, Muse Spark compares photos and checks rules, Muse Wonder gives second opinions, drafts checklists and writes summaries.</p>
        </div>
        <div className="head-stats"><div><b>${total.toFixed(2)}</b><span>Shown</span></div></div>
      </header>
      <section className="panel"><RunTable runs={runs} withScene /></section>
    </>
  );
}

// Old links (#/checks/:id) open the inspection on its scene page.
function LegacyCheck({ id }: { id: string }) {
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ sceneId: string }>(`/api/checks/${id}`)
      .then((c) => location.replace(`#/scenes/${c.sceneId}/i/${id}`))
      .catch((e) => setError(e.message));
  }, [id]);
  return error ? <div className="banner error">{error}</div> : <p className="muted">Opening…</p>;
}

// Videos used to have their own Walkthroughs page; old links open the first inspection made from the video.
function LegacyVideo({ id }: { id: string | null }) {
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return void location.replace("#/");
    api<Video>(`/api/video/inspections/${id}`)
      .then((v) => {
        const s = v.scenes.find((x) => x.checkIds.length) ?? v.scenes[0];
        location.replace(s ? `#/scenes/${s.sceneId}${s.checkIds.length ? `/i/${s.checkIds[0]}` : ""}` : "#/");
      })
      .catch((e) => setError(e.message));
  }, [id]);
  return error ? <div className="banner error">{error}</div> : <p className="muted">Opening…</p>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const tryIt = async () => {
    setStarting(true);
    setError("");
    try {
      await api("/api/guest", { method: "POST" });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };
  return (
    <div className="center">
      <div className="panel login">
        <div className="brand"><Logo /> TrueScene</div>
        <p className="muted" style={{ margin: 0 }}>
          Photograph a place once when it's right. Every later photo or video is checked against it, and a person reviews what changed.
        </p>
        <button className="primary" onClick={tryIt} disabled={starting}>{starting ? "Setting up your demo…" : "Try TrueScene"}</button>
        <p className="muted small" style={{ margin: 0 }}>No sign-up. You get your own copy of ready-made hotel, restaurant, bar and outdoor scenes.</p>
        <details className="login-code">
          <summary className="small">I have an access code</summary>
          <form
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
            <label>Access code<input type="password" value={code} onChange={(e) => { setCode(e.target.value); setError(""); }} /></label>
            <button>Enter</button>
          </form>
        </details>
        {error && <p className="err small" role="alert">{error}</p>}
      </div>
    </div>
  );
}

// A scene's upload link opens the public upload page, outside the app and its sign-in.
const uploadToken = location.pathname.match(/^\/u\/([\w-]+)\/?$/)?.[1];
createRoot(document.getElementById("root")!).render(<StrictMode>{uploadToken ? <UploadPage token={uploadToken} /> : <App />}</StrictMode>);
