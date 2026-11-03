import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Run, type SceneSummary, api, columnOf, useStream } from "./api.js";
import { Board } from "./board.js";
import { RunTable } from "./inspection.js";
import { ScenePage } from "./scene.js";
import { Walkthroughs } from "./video.js";

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
  | { name: "walkthroughs"; id: string | null }
  | { name: "activity" }
  | { name: "legacy-check"; id: string };

function pageOf(route: string): Page {
  let m: RegExpMatchArray | null;
  if ((m = route.match(/^\/scenes\/([\w-]+)(?:\/i\/([\w-]+))?$/))) return { name: "scene", id: m[1], checkId: m[2] ?? null };
  if ((m = route.match(/^\/group\/(.+)$/))) return { name: "board", group: decodeURIComponent(m[1]) };
  if ((m = route.match(/^\/(?:walkthroughs|videos)(?:\/([\w-]+))?$/))) return { name: "walkthroughs", id: m[1] && m[1] !== "checklists" ? m[1] : null };
  if ((m = route.match(/^\/checks\/([\w-]+)$/))) return { name: "legacy-check", id: m[1] };
  if (route === "/activity") return { name: "activity" };
  return { name: "board", group: null };
}

function App() {
  const [session, setSession] = useState<{ loginRequired: boolean; ok: boolean } | null>(null);
  const [down, setDown] = useState("");
  useEffect(() => {
    api<{ loginRequired: boolean; ok: boolean }>("/api/session").then(setSession).catch((e) => setDown(e.message));
  }, []);
  if (down) return <div className="center"><div className="banner error">Couldn't reach the GoldenFrame server: {down}</div></div>;
  if (!session) return null;
  if (!session.ok) return <Login onDone={() => setSession({ ...session, ok: true })} />;
  return <Shell />;
}

function Shell() {
  const page = pageOf(useHashRoute());
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const loadScenes = useCallback(() => api<SceneSummary[]>("/api/scenes").then(setScenes).catch(() => {}), []);
  useEffect(() => void loadScenes(), [loadScenes]);
  useStream("check", () => void loadScenes());
  useEffect(() => setMenuOpen(false), [page.name, page.name === "scene" ? page.id : null]);

  const groups = [...new Set((scenes ?? []).map((s) => s.group).filter(Boolean))].sort();
  const toReview = (scenes ?? []).filter((s) => columnOf(s) === "review").length;

  return (
    <div className={`app${menuOpen ? " menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <a href="#/" className="brand"><Logo /> GoldenFrame</a>
          <button className="icon only-mobile" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>☰</button>
        </div>
        <nav className="nav" aria-label="Main">
          <div className="nav-label">Operations</div>
          <NavLink href="#/" on={page.name === "board" && page.group === null} icon="board" badge={toReview || undefined}>Scenes</NavLink>
          <NavLink href="#/walkthroughs" on={page.name === "walkthroughs"} icon="video">Walkthroughs</NavLink>
          <NavLink href="#/activity" on={page.name === "activity"} icon="pulse">Model activity</NavLink>
          {groups.length > 0 && <div className="nav-label">Groups</div>}
          {groups.map((g) => (
            <NavLink key={g} href={`#/group/${encodeURIComponent(g)}`} on={page.name === "board" && page.group === g} icon="folder"
              badge={(scenes ?? []).filter((s) => s.group === g).length}>{g}</NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Spend />
          <div className="models small muted">Meta SAM 3.1 · Muse Spark · Muse Wonder</div>
        </div>
      </aside>
      <main className="main">
        {page.name === "board" && <Board scenes={scenes} group={page.group} onChange={loadScenes} />}
        {page.name === "scene" && <ScenePage id={page.id} checkId={page.checkId} groups={groups} onScenesChange={loadScenes} />}
        {page.name === "walkthroughs" && <Walkthroughs id={page.id} />}
        {page.name === "activity" && <Activity />}
        {page.name === "legacy-check" && <LegacyCheck id={page.id} />}
      </main>
    </div>
  );
}

const ICONS: Record<string, string> = {
  board: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v6h-4z",
  video: "M3 6h12v12H3zM15 10l6-3v10l-6-3",
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

function Spend() {
  const [s, setS] = useState<{ todayUsd: number; limitUsd: number } | null>(null);
  useEffect(() => {
    const load = () => api<{ todayUsd: number; limitUsd: number }>("/api/spend").then(setS).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  return (
    <div className="spend">
      <div className="row between small"><span className="muted">Model spend today</span><b>${s.todayUsd.toFixed(2)} / ${s.limitUsd}</b></div>
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

function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="center">
      <form
        className="panel login"
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
        <div className="brand"><Logo /> GoldenFrame</div>
        <label>Access code<input type="password" value={code} onChange={(e) => { setCode(e.target.value); setError(""); }} autoFocus /></label>
        {error && <p className="err small">{error}</p>}
        <button className="primary">Enter</button>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
