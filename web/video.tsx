// Video inspections section. Kept apart from the photo section (main.tsx): its own API helper, live
// stream and styles, so the two can change independently. Shared look comes from styles.css classes.
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import "./video.css";

// ---------- API ----------
type UnitBox = { left: number; top: number; right: number; bottom: number };
type Mask = { path: string; dx: number; dy: number };
type Media = { url: string; w: number; h: number };
type Rule = { id: string; text: string };
type Area = { id: string; name: string; golden: Media; checklist: Rule[] };
type RuleResult = {
  ruleId: string; text: string; verdict: "pass" | "fail" | "unclear"; note: string;
  box: UnitBox | null; mask: Mask | null; status: "pass" | "fail" | "needs_review"; why: string;
};
type Finding = {
  id: string; kind: string; text: string; boxes: UnitBox[]; goldenBoxes: UnitBox[]; mask: Mask | null;
  source: "sam" | "spark" | "both"; status: "confirmed" | "needs_review" | "rejected"; why: string;
};
type ItemResult = { itemId: string; name: string; expected: number; found: number; boxes: UnitBox[]; ok: boolean };
type AreaCheck = {
  id: string; status: string; costUsd: number; score: { ok: number; total: number } | null; snapshot: Media; golden: Media;
  result: { viewNote?: string; items?: ItemResult[]; findings?: Finding[]; error?: string };
};
type InspectionArea = {
  sceneId: string; name: string; status: "pending" | "checking" | "done" | "not_seen" | "failed";
  frameMs: number | null; note: string | null; checklist: RuleResult[]; check: AreaCheck | null;
};
type Inspection = {
  id: string; name: string; status: "processing" | "done" | "failed"; stage: string | null; error: string | null;
  createdAt: string; durationMs: number | null; areaCount: number; notSeen: number;
  score: { ok: number; total: number } | null; needsReview: number;
  video?: { url: string; type: string }; areas?: InspectionArea[];
};

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  return data as T;
}

// XHR rather than fetch: fetch can't report upload progress, and videos are large.
function uploadVideo(url: string, file: File, onProgress: (fraction: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", file.type.startsWith("video/") ? file.type : "video/mp4");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { id?: string; error?: unknown } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status < 300 && data.id) resolve({ id: data.id });
      else reject(new Error(typeof data.error === "string" ? data.error : `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("The upload failed. Check your connection and try again."));
    xhr.send(file);
  });
}

// One shared connection to the video section's live updates (inspection, check).
let stream: EventSource | null = null;
function useVideoStream<T>(type: string, on: (data: T) => void) {
  const ref = useRef(on);
  useEffect(() => { ref.current = on; });
  useEffect(() => {
    stream ??= new EventSource("/api/video/stream");
    const handler = (e: Event) => ref.current(JSON.parse((e as MessageEvent).data));
    stream.addEventListener(type, handler);
    return () => stream?.removeEventListener(type, handler);
  }, [type]);
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- section shell ----------
export function SectionTabs({ route }: { route: string }) {
  const video = route.startsWith("/videos");
  return (
    <nav className="vtabs" aria-label="Sections">
      <a href="#/" className={video ? undefined : "active"} aria-current={video ? undefined : "page"}>Photo checks</a>
      <a href="#/videos" className={video ? "active" : undefined} aria-current={video ? "page" : undefined}>Video inspections</a>
    </nav>
  );
}

export function VideoSection({ route }: { route: string }) {
  if (route === "/videos/checklists") return <Checklists />;
  const report = route.match(/^\/videos\/([\w-]+)$/);
  return report ? <Report id={report[1]} /> : <Inspections />;
}

type Verdict = { cls: string; label: string };

function inspectionVerdict(i: Inspection): Verdict {
  if (i.status === "processing") return { cls: "running", label: "Processing…" };
  if (i.status === "failed") return { cls: "failed", label: "Failed" };
  if (i.needsReview) return { cls: "needs_review", label: "Needs review" };
  if (i.score && i.score.ok < i.score.total) return { cls: "issues", label: "Issues found" };
  if (i.notSeen) return { cls: "retake", label: "Areas not seen" };
  return { cls: "ok", label: "All good" };
}

function areaVerdict(a: InspectionArea): Verdict {
  if (a.status === "pending") return { cls: "running", label: "Waiting" };
  if (a.status === "checking") return { cls: "running", label: "Checking…" };
  if (a.status === "not_seen") return { cls: "retake", label: "Not seen" };
  if (a.status === "failed" || a.check?.status === "failed") return { cls: "failed", label: "Failed" };
  if (a.check?.status === "retake") return { cls: "retake", label: "Retake" };
  if (a.checklist.some((r) => r.status === "needs_review") || a.check?.status === "needs_review") return { cls: "needs_review", label: "Needs review" };
  if (a.checklist.some((r) => r.status === "fail") || a.check?.status === "issues") return { cls: "issues", label: "Issues found" };
  return { cls: "ok", label: "All good" };
}

const Badge = ({ v }: { v: Verdict }) => <span className={`badge badge-${v.cls}`}>{v.label}</span>;

// ---------- inspections list + new inspection ----------
function Inspections() {
  const [list, setList] = useState<Inspection[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<Inspection[]>("/api/video/inspections").then(setList).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  useVideoStream<{ id: string }>("inspection", () => void load());

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1>Video inspections</h1>
        <a href="#/videos/checklists">Checklists</a>
      </div>
      <NewInspection onError={setError} />
      {error && <div className="banner error" role="alert">{error}</div>}
      {list && list.length === 0 && <p className="muted">No inspections yet. Film a walkthrough and start one above.</p>}
      <div className="grid">
        {list?.map((i) => (
          <a key={i.id} href={`#/videos/${i.id}`} className="card" style={{ color: "inherit" }}>
            <div style={{ fontWeight: 600 }}>{i.name}</div>
            <div className="row small" style={{ justifyContent: "space-between", marginTop: 4 }}>
              <Badge v={inspectionVerdict(i)} />
              <span className="muted">{when(i.createdAt)}</span>
            </div>
            <div className="muted small">
              {plural(i.areaCount, "area")}
              {i.score && ` · ${i.score.ok} of ${i.score.total} OK`}
              {i.notSeen > 0 && ` · ${i.notSeen} not seen`}
            </div>
          </a>
        ))}
      </div>
    </>
  );
}

function NewInspection({ onError }: { onError: (message: string) => void }) {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => { api<Area[]>("/api/video/areas").then(setAreas).catch((e) => onError(e.message)); }, [onError]);

  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return onError("Give the inspection a name, for example \"Room 101 – Monday\".");
    if (!chosen.size) return onError("Choose the areas this video covers.");
    if (!file) return onError("Choose a video.");
    if (file.size > MAX_VIDEO_BYTES) return onError("Videos must be 200 MB or smaller.");
    onError("");
    setProgress(0);
    try {
      const query = new URLSearchParams({ name: name.trim(), sceneIds: [...chosen].join(",") });
      const { id } = await uploadVideo(`/api/video/inspections?${query}`, file, setProgress);
      location.hash = `#/videos/${id}`;
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setProgress(null);
    }
  };

  if (!areas) return null;
  if (!areas.length) {
    return <div className="card" style={{ marginBottom: 16 }}><p className="muted" style={{ margin: 0 }}>No areas with a golden photo yet. Set one up in <a href="#/">Photo checks</a> first.</p></div>;
  }
  const uploading = progress !== null;
  return (
    <form className="card" onSubmit={start} style={{ marginBottom: 16 }}>
      <h2>New inspection</h2>
      <input type="text" placeholder="Room 101 – Monday" value={name} maxLength={80} aria-label="Inspection name"
        onChange={(e) => { setName(e.target.value); onError(""); }} />
      <fieldset className="area-pick">
        <legend className="small muted">Areas this video covers</legend>
        {areas.map((a) => (
          <label key={a.id}>
            <input type="checkbox" checked={chosen.has(a.id)} onChange={() => toggle(a.id)} />
            <img src={a.golden.url} alt="" />
            <span>{a.name}<br /><span className="muted small">{plural(a.checklist.length, "rule")}</span></span>
          </label>
        ))}
      </fieldset>
      <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <input type="file" accept="video/*" aria-label="Video file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); onError(""); }} />
        <button className="primary" disabled={uploading}>{uploading ? `Uploading ${Math.round(progress * 100)}%` : "Start inspection"}</button>
      </div>
      {uploading && (
        <div className="progress" role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>
        Film each area from roughly where its golden photo was taken. Up to 3 minutes and 200 MB; a frame is taken every second.
      </p>
    </form>
  );
}

// ---------- checklists ----------
function Checklists() {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Area[]>("/api/video/areas").then(setAreas).catch((e) => setError(e.message)); }, []);
  return (
    <>
      <a href="#/videos" className="small">← Video inspections</a>
      <h1>Checklists</h1>
      <p className="muted">Write what must be true in each area. Every video inspection checks these rules on the frame it picks for the area.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      {areas?.length === 0 && <p className="muted">No areas with a golden photo yet. Set one up in <a href="#/">Photo checks</a> first.</p>}
      <div className="checklists">{areas?.map((a) => <ChecklistEditor key={a.id} area={a} />)}</div>
    </>
  );
}

function ChecklistEditor({ area }: { area: Area }) {
  const [rules, setRules] = useState(area.checklist);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const save = async (next: { id?: string; text: string }[]) => {
    try {
      const r = await api<{ checklist: Rule[] }>(`/api/video/areas/${area.id}/checklist`, { method: "PUT", body: JSON.stringify({ rules: next }) });
      setRules(r.checklist);
      setError("");
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return setError("Write the rule first, for example \"TV is on and shows the welcome screen\".");
    if (await save([...rules, { text: draft }])) setDraft("");
  };

  return (
    <div className="card checklist-area">
      <img src={area.golden.url} alt={`Golden photo of ${area.name}`} />
      <div>
        <h2>{area.name}</h2>
        {rules.length === 0 && <p className="muted small">No rules yet.</p>}
        {rules.map((r) => (
          <RuleEditor key={r.id} rule={r} onSave={(text) => save(rules.map((x) => (x.id === r.id ? { ...x, text } : x)))}
            onDelete={() => save(rules.filter((x) => x.id !== r.id))} />
        ))}
        <form className="row" onSubmit={add} style={{ marginTop: 8 }}>
          <input type="text" value={draft} maxLength={200} placeholder="Left-wall artwork is straight" aria-label={`New rule for ${area.name}`}
            onChange={(e) => { setDraft(e.target.value); setError(""); }} />
          <button className="primary" disabled={rules.length >= 20}>Add</button>
        </form>
        {error && <p className="err small" role="alert">{error}</p>}
      </div>
    </div>
  );
}

function RuleEditor({ rule, onSave, onDelete }: { rule: Rule; onSave: (text: string) => void; onDelete: () => void }) {
  const [text, setText] = useState(rule.text);
  useEffect(() => setText(rule.text), [rule.text]);
  return (
    <div className="row rule-edit">
      <input type="text" value={text} maxLength={200} aria-label="Rule" onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() && text !== rule.text && onSave(text)} />
      <button type="button" className="ghost" onClick={onDelete} aria-label={`Delete rule: ${rule.text}`}>✕</button>
    </div>
  );
}

// ---------- report ----------
function Report({ id }: { id: string }) {
  const [ins, setIns] = useState<Inspection | null>(null);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const load = useCallback(() => api<Inspection>(`/api/video/inspections/${id}`).then(setIns).catch((e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);
  useVideoStream<{ id: string }>("inspection", (e) => e.id === id && void load());
  useVideoStream<{ id: string }>("check", (e) => ins?.areas?.some((a) => a.check?.id === e.id) && void load());

  const seek = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    v.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const remove = async () => {
    if (!ins || !confirm(`Delete "${ins.name}" and its video?`)) return;
    try {
      await api(`/api/video/inspections/${id}`, { method: "DELETE" });
      location.hash = "#/videos";
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!ins) return error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>;
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <a href="#/videos" className="small">← Video inspections</a>
          <div className="row"><h1>{ins.name}</h1><Badge v={inspectionVerdict(ins)} /></div>
          <div className="muted small">
            {when(ins.createdAt)}
            {ins.durationMs !== null && ` · ${clock(ins.durationMs)} video`}
            {ins.score && ` · ${ins.score.ok} of ${ins.score.total} OK`}
            {ins.needsReview > 0 && ` · ${ins.needsReview} to review`}
          </div>
        </div>
        {ins.status !== "processing" && <button className="ghost" onClick={remove}>Delete</button>}
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {ins.status === "processing" && <div className="banner info"><span className="spinner" /> {ins.stage ?? "Processing"}. Usually under a minute per area.</div>}
      {ins.status === "failed" && <div className="banner error">{ins.error ?? "The inspection failed."}</div>}
      {ins.video && <video ref={videoRef} className="player" src={ins.video.url} controls preload="metadata" playsInline />}
      {ins.areas?.map((a) => <AreaReport key={a.sceneId} area={a} inspectionId={id} onSeek={seek} onChange={load} onError={setError} />)}
    </>
  );
}

function AreaReport({ area, inspectionId, onSeek, onChange, onError }: {
  area: InspectionArea; inspectionId: string; onSeek: (ms: number) => void; onChange: () => void; onError: (m: string) => void;
}) {
  const check = area.check;
  const findings = (check?.result.findings ?? []).filter((f) => f.status !== "rejected");
  const items = check?.result.items ?? [];
  const flagged = area.checklist.filter((r) => r.status !== "pass" && r.box);

  const decide = async (path: string, body: object) => {
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      onChange();
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const reviewRule = (ruleId: string, decision: "confirm" | "reject") =>
    decide(`/api/video/inspections/${inspectionId}/review`, { sceneId: area.sceneId, ruleId, decision });
  const reviewFinding = (findingId: string, decision: "confirm" | "reject") =>
    check && decide(`/api/checks/${check.id}/review`, { findingId, decision });

  return (
    <section className="card area-section" aria-label={area.name}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div className="row"><h2 style={{ margin: 0 }}>{area.name}</h2><Badge v={areaVerdict(area)} /></div>
        {area.frameMs !== null && <button onClick={() => onSeek(area.frameMs!)} aria-label={`Play video at ${clock(area.frameMs)}`}>▶ {clock(area.frameMs)}</button>}
      </div>
      {area.note && <p className="muted small">{area.note}</p>}
      {area.status === "not_seen" && <p className="small warn">This area wasn't found in the video. Film it from about where its golden photo was taken.</p>}
      {check?.status === "retake" && <div className="banner warn-bg">The frame shows a different view, so the photos weren't compared. {check.result.viewNote}</div>}
      {check?.status === "failed" && <div className="banner error">{check.result.error ?? "The check failed."}</div>}

      {check && (
        <div className="compare">
          <Frame media={check.golden} label="Golden (how it should look)">
            {findings.flatMap((f) => f.goldenBoxes.map((b, j) => <Box key={`${f.id}-${j}`} b={b} m={check.golden} className={`ov ov-${f.status} ov-dashed`} />))}
          </Frame>
          <Frame media={check.snapshot} label={`Video at ${clock(area.frameMs ?? 0)}`}>
            {items.filter((i) => i.ok).flatMap((i) => i.boxes.map((b, j) => <Box key={`${i.itemId}-${j}`} b={b} m={check.snapshot} className="ov ov-ok" />))}
            {findings.map((f) => (
              <g key={f.id}>
                {f.mask && <g transform={`translate(${f.mask.dx} ${f.mask.dy})`}><path d={f.mask.path} className={`ov ov-${f.status} ov-fill`} /></g>}
                {f.boxes.map((b, j) => <Box key={j} b={b} m={check.snapshot} className={`ov ov-${f.status}${f.kind === "item_missing" ? " ov-dashed" : ""}`} />)}
              </g>
            ))}
            {flagged.map((r) => {
              const cls = r.status === "fail" ? "ov-confirmed" : "ov-needs_review";
              return (
                <g key={r.ruleId}>
                  {r.mask && <g transform={`translate(${r.mask.dx} ${r.mask.dy})`}><path d={r.mask.path} className={`ov ${cls} ov-fill`} /></g>}
                  <Box b={r.box!} m={check.snapshot} className={`ov ${cls}`} />
                </g>
              );
            })}
          </Frame>
        </div>
      )}

      {area.status === "done" && (
        <div className="report-lists">
          <div>
            <h3>Checklist</h3>
            {area.checklist.length === 0 && <p className="muted small">No checklist for this area. <a href="#/videos/checklists">Add rules</a></p>}
            {area.checklist.map((r) => (
              <div key={r.ruleId} className={`rule rule-${r.status}`}>
                <span className="rule-icon" aria-label={r.status === "pass" ? "Passed" : r.status === "fail" ? "Failed" : "Needs review"}>
                  {r.status === "pass" ? "✓" : r.status === "fail" ? "✕" : "?"}
                </span>
                <div>
                  <div>{r.text}</div>
                  <div className="muted small">{r.note} {r.why}</div>
                  {r.status === "needs_review" && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <button onClick={() => reviewRule(r.ruleId, "confirm")}>It failed</button>
                      <button className="ghost" onClick={() => reviewRule(r.ruleId, "reject")}>It's fine</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div>
            <h3>Compared with golden {check?.score && check.score.total > 0 && <span className="muted small">· {check.score.ok} of {check.score.total} items OK</span>}</h3>
            {findings.length === 0 && <p className="muted small">Nothing differs from the golden photo.</p>}
            {findings.map((f) => (
              <div key={f.id} className={`finding finding-${f.status}`}>
                <div style={{ fontWeight: 600 }}>{f.text}</div>
                <div className="muted small">{f.why}</div>
                {f.status === "needs_review" && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <button onClick={() => reviewFinding(f.id, "confirm")}>Confirm</button>
                    <button className="ghost" onClick={() => reviewFinding(f.id, "reject")}>Reject</button>
                  </div>
                )}
              </div>
            ))}
            {items.map((i) => (
              <div key={i.itemId} className="row small item-line">
                <span className={i.ok ? "ok" : "err"} aria-hidden="true">{i.ok ? "✓" : "✕"}</span>
                <span style={{ flex: 1 }}>{i.name}</span>
                <span className="muted">{i.found} of {i.expected}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// A photo with an SVG layer in the photo's own pixel space.
function Frame({ media, label, children }: { media: Media; label: string; children?: ReactNode }) {
  return (
    <figure className="photo">
      <figcaption className="small muted">{label}</figcaption>
      <div className="stage" style={{ cursor: "default" }}>
        <img src={media.url} alt={label} draggable={false} />
        <svg viewBox={`0 0 ${media.w} ${media.h}`} preserveAspectRatio="none" aria-hidden="true">{children}</svg>
      </div>
    </figure>
  );
}

function Box({ b, m, className }: { b: UnitBox; m: Media; className: string }) {
  return <rect className={className} x={b.left * m.w} y={b.top * m.h} width={(b.right - b.left) * m.w} height={(b.bottom - b.top) * m.h}
    rx={6} strokeWidth={Math.max(3, m.w / 350)} />;
}
