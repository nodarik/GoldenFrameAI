// Walkthroughs: upload a video that covers several scenes. Each scene's best frame becomes an ordinary inspection
// of that scene (reviewed on the scene page); this page lists walkthroughs and links to those inspections.
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type CheckStatus, type Media, type ReviewStatus, api, clock, plural, useStream, when } from "./api.js";
import { ReviewPill } from "./inspection.js";

type Area = { id: string; name: string; golden: Media; checklist: unknown[] };
type InspectionArea = {
  sceneId: string; name: string; status: "pending" | "checking" | "done" | "not_seen" | "failed"; frameMs: number | null; note: string | null;
  check: { id: string; status: CheckStatus; reviewStatus: ReviewStatus; snapshot: Media } | null;
};
type Walkthrough = {
  id: string; name: string; status: "processing" | "done" | "failed"; stage: string | null; error: string | null;
  createdAt: string; durationMs: number | null; areaCount: number; notSeen: number;
  score: { ok: number; total: number } | null; needsReview: number;
  video?: { url: string; type: string }; areas?: InspectionArea[];
};

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

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

export function Walkthroughs({ id }: { id: string | null }) {
  return id ? <Report id={id} /> : <List />;
}

function statusOf(w: Walkthrough): { cls: string; label: string } {
  if (w.status === "processing") return { cls: "running", label: "Processing…" };
  if (w.status === "failed") return { cls: "issue", label: "Failed" };
  if (w.needsReview) return { cls: "review", label: `${w.needsReview} to decide` };
  if (w.score && w.score.ok < w.score.total) return { cls: "issue", label: "Issues found" };
  if (w.notSeen) return { cls: "review", label: "Scenes not seen" };
  return { cls: "ok", label: "All good" };
}

function List() {
  const [list, setList] = useState<Walkthrough[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<Walkthrough[]>("/api/video/inspections").then(setList).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  useStream<{ id: string }>("inspection", () => void load());

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Walkthroughs</h1>
          <p className="muted">Film several scenes in one video. GoldenFrame picks the best frame for each scene and inspects it.</p>
        </div>
      </header>
      <NewWalkthrough onError={setError} />
      {error && <div className="banner error" role="alert">{error}</div>}
      {list && list.length === 0 && <p className="muted">No walkthroughs yet.</p>}
      <div className="wlist">
        {list?.map((w) => {
          const s = statusOf(w);
          return (
            <a key={w.id} href={`#/walkthroughs/${w.id}`} className="wrow">
              <strong>{w.name}</strong>
              <span className={`pill pill-${s.cls}`}>{s.label}</span>
              <span className="muted small">{plural(w.areaCount, "scene")}{w.score && ` · ${w.score.ok} of ${w.score.total} OK`}{w.notSeen > 0 && ` · ${w.notSeen} not seen`}</span>
              <span className="muted small">{when(w.createdAt)}</span>
            </a>
          );
        })}
      </div>
    </>
  );
}

function NewWalkthrough({ onError }: { onError: (message: string) => void }) {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => { api<Area[]>("/api/video/areas").then(setAreas).catch((e) => onError(e.message)); }, [onError]);

  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return onError("Give the walkthrough a name, for example \"Floor 12 – Monday\".");
    if (!chosen.size) return onError("Choose the scenes this video covers.");
    if (!file) return onError("Choose a video.");
    if (file.size > MAX_VIDEO_BYTES) return onError("Videos must be 200 MB or smaller.");
    onError("");
    setProgress(0);
    try {
      const query = new URLSearchParams({ name: name.trim(), sceneIds: [...chosen].join(",") });
      const { id } = await uploadVideo(`/api/video/inspections?${query}`, file, setProgress);
      location.hash = `#/walkthroughs/${id}`;
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setProgress(null);
    }
  };

  if (!areas) return null;
  if (!areas.length) return <section className="panel"><p className="muted" style={{ margin: 0 }}>No scenes with a golden photo yet. <a href="#/">Set one up</a> first.</p></section>;
  const uploading = progress !== null;
  return (
    <form className="panel" onSubmit={start}>
      <h2>New walkthrough</h2>
      <input type="text" placeholder="Floor 12 – Monday" value={name} maxLength={80} aria-label="Walkthrough name"
        onChange={(e) => { setName(e.target.value); onError(""); }} />
      <fieldset className="area-pick">
        <legend className="small muted">Scenes this video covers</legend>
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
        <button className="primary" disabled={uploading}>{uploading ? `Uploading ${Math.round(progress * 100)}%` : "Start walkthrough"}</button>
      </div>
      {uploading && (
        <div className="bar" role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>Film each scene from roughly where its golden photo was taken. Up to 3 minutes and 200 MB; a frame is taken every second.</p>
    </form>
  );
}

function Report({ id }: { id: string }) {
  const [w, setW] = useState<Walkthrough | null>(null);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const load = useCallback(() => api<Walkthrough>(`/api/video/inspections/${id}`).then(setW).catch((e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);
  useStream<{ id: string }>("inspection", (e) => e.id === id && void load());
  useStream<{ id: string }>("check", (e) => w?.areas?.some((a) => a.check?.id === e.id) && void load());

  const seek = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    v.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const remove = async () => {
    if (!w || !confirm(`Delete "${w.name}" and its video? The inspections it created stay on their scenes.`)) return;
    try {
      await api(`/api/video/inspections/${id}`, { method: "DELETE" });
      location.hash = "#/walkthroughs";
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!w) return error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>;
  const s = statusOf(w);
  return (
    <>
      <header className="page-head">
        <div className="row">
          <a href="#/walkthroughs" className="back" aria-label="Back to walkthroughs">←</a>
          <div>
            <div className="row"><h1>{w.name}</h1><span className={`pill pill-${s.cls}`}>{s.label}</span></div>
            <p className="muted">
              {when(w.createdAt)}{w.durationMs !== null && ` · ${clock(w.durationMs)} video`}{w.score && ` · ${w.score.ok} of ${w.score.total} OK`}
            </p>
          </div>
        </div>
        {w.status !== "processing" && <button className="ghost" onClick={remove}>Delete</button>}
      </header>
      {error && <div className="banner error" role="alert">{error}</div>}
      {w.status === "processing" && <div className="banner info"><span className="spinner" /> {w.stage ?? "Processing"}. Usually under a minute per scene.</div>}
      {w.status === "failed" && <div className="banner error">{w.error ?? "The walkthrough failed."}</div>}
      {w.video && <video ref={videoRef} className="player" src={w.video.url} controls preload="metadata" playsInline />}
      <section className="panel">
        <h2>Scenes</h2>
        <ul className="ilist">
          {w.areas?.map((a) => (
            <li key={a.sceneId} className="wscene">
              {a.check ? <img src={a.check.snapshot.url} alt="" /> : <span className="thumb-empty" />}
              <span className="irow-main">
                <strong>{a.name}</strong>
                <span className="muted small">
                  {a.status === "pending" ? "Waiting" : a.status === "checking" ? "Checking…" : a.status === "not_seen" ? "Not seen in the video" : a.status === "failed" ? "Failed" : ""}
                  {a.note && ` ${a.note}`}
                </span>
              </span>
              {a.check && <ReviewPill c={a.check} />}
              {a.frameMs !== null && <button className="sm" onClick={() => seek(a.frameMs!)} aria-label={`Play video at ${clock(a.frameMs)}`}>▶ {clock(a.frameMs)}</button>}
              {a.check && <a className="sm button" href={`#/scenes/${a.sceneId}/i/${a.check.id}`}>Open inspection →</a>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
