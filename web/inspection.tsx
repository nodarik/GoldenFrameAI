// One inspection: review status and history, Wonder's summary, framing, the two photos with outlines, and the
// checklist in sections (watched objects, written rules, differences) like a housekeeping checklist.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Check, type CheckSummary, type Finding, type Media, type Review, type RuleResult, type Run, type Source, STATUS_LABEL,
  type Motion, type UnitBox, type Video,
  api, clock, getReviewer, post, setReviewer, useStream, when,
} from "./api.js";
import { AnnotatedPhoto, type Shape } from "./photo.js";
import { type Track, boxAt, trackBox } from "./track.js";

export function ReviewPill({ c }: { c: Pick<CheckSummary, "reviewStatus" | "status"> }) {
  if (c.status === "running") return <span className="pill pill-running">Checking…</span>;
  return c.reviewStatus === "reviewed"
    ? <span className="pill pill-reviewed">Reviewed</span>
    : <span className="pill pill-review">Needs review</span>;
}

export function SourceIcon({ source }: { source: Source }) {
  return source.type === "video"
    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Video"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3z" /></svg>
    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Photo"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>;
}

// One photo with a before/after wipe: golden on the left, inspection on the
// right, drag the divider to move it. Both layers stay mounted (the top one is
// clipped), so outlines and checklist hover highlighting keep working on each
// side. Both layers share the inspection photo's frame; the golden layer
// stretches slightly when the two photos' aspects differ, and outlines stay
// aligned because boxes are relative to each photo. `surface` puts something else on the right in place of the
// inspection photo: the video a frame came from.
function CompareSlider({ golden, snapshot, goldenShapes, newShapes, active, onActive, frame, rightLabel, surface }: {
  golden: Media; snapshot: Media; goldenShapes: Shape[]; newShapes: Shape[];
  active: string | null; onActive: (id: string | null) => void; frame: UnitBox | null; rightLabel: string; surface?: ReactNode;
}) {
  const [pos, setPos] = useState(10);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const move = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    setPos(Math.min(94, Math.max(6, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div ref={ref} className="ba-stage" style={{ aspectRatio: `${snapshot.w} / ${snapshot.h}` }}
      onPointerDown={(e) => { drag.current = true; ref.current?.setPointerCapture(e.pointerId); move(e.clientX); }}
      onPointerMove={(e) => { if (drag.current) move(e.clientX); }}
      onPointerUp={() => { drag.current = false; }}
      onPointerCancel={() => { drag.current = false; }}>
      <div className="ba-layer">
        <AnnotatedPhoto media={golden} label="Initial photo" shapes={goldenShapes} active={active} onActive={onActive} />
      </div>
      <div className="ba-layer" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
        <AnnotatedPhoto media={snapshot} label="Inspection photo" shapes={newShapes} active={active} onActive={onActive} frame={frame} surface={surface} />
      </div>
      <span className="ba-tag ba-tag-left">Initial</span>
      <span className="ba-tag ba-tag-right">{rightLabel}</span>
      <div className="ba-divider" style={{ left: `${pos}%` }} aria-hidden="true">
        <div className="ba-knob" role="slider" tabIndex={0} aria-label="Reveal inspection photo"
          aria-valuenow={Math.round(pos)} aria-valuemin={0} aria-valuemax={100}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") { e.preventDefault(); setPos((p) => Math.max(6, p - 4)); }
            if (e.key === "ArrowRight") { e.preventDefault(); setPos((p) => Math.min(94, p + 4)); }
          }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m9 6-4 6 4 6M15 6l4 6-4 6" /></svg>
        </div>
      </div>
    </div>
  );
}

type Decide = (kind: "finding" | "rule", id: string, decision: "confirm" | "reject") => void;
type Tone = Shape["tone"];
const toneOf = (s: string): Tone => (s === "confirmed" || s === "fail" ? "issue" : s === "needs_review" ? "review" : "ok");

// The outlines on an inspection photo (or video frame): watched objects, differences and failed checklist points.
function inspectionShapes(r: Check["result"]): Shape[] {
  return [
    ...(r.items ?? []).map((i) => ({ id: `item:${i.itemId}`, label: i.name, sub: `${i.found} of ${i.expected} found`, tone: (i.ok ? "ok" : "issue") as Tone, boxes: i.boxes })),
    ...(r.findings ?? []).filter((f) => f.status !== "rejected" || f.outsideFrame).map((f) => ({
      id: `finding:${f.id}`, label: f.text, sub: f.outsideFrame ? "Outside the initial photo's view" : f.status === "needs_review" ? "Needs your decision" : "Issue",
      tone: f.outsideFrame ? ("muted" as Tone) : toneOf(f.status), boxes: f.boxes, masks: f.mask ? [f.mask] : [], dashed: f.kind === "item_missing" || !!f.outsideFrame,
    })),
    ...(r.checklist ?? []).filter((x) => x.box && x.status !== "pass").map((x) => ({
      id: `rule:${x.ruleId}`, label: x.text, sub: x.note, tone: toneOf(x.status), boxes: [x.box!], masks: x.mask ? [x.mask] : [],
    })),
  ];
}

// Outlines follow their objects through the video for this long around a checked moment (the motion is measured
// from frame to frame, so small errors add up further away). Until the motion is in, or if it can't be measured,
// they show only right around the moment: a handheld camera has moved on a second later.
const TRACK_MS = 10_000;
const NEAR_MS = 750;

type Visit = { ms: number; check: Check; shapes: Shape[]; tracks: Track[][] | null };

// A video inspection's before/after: the initial photo against the video the frame came from, paused on that frame
// and playable, with outlines that move with their objects, from every moment of it that was checked for this scene
// (this frame and the scene's other visits in the same video). The bar under it plays, seeks and jumps to each moment;
// the player has no controls of its own, since the slider takes every click on the picture.
function VideoCompare({ check, inspectionId, frameMs, golden, goldenShapes, frame, active, onActive }: {
  check: Check; inspectionId: string; frameMs: number; golden: Media; goldenShapes: Shape[]; frame: UnitBox | null;
  active: string | null; onActive: (id: string | null) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [others, setOthers] = useState<{ ms: number; check: Check }[]>([]);
  const [motion, setMotion] = useState<Motion | "failed" | null>(null);
  const [t, setT] = useState(frameMs);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    let live = true;
    api<Video>(`/api/video/inspections/${inspectionId}`).then(async (v) => {
      const ids = (v.scenes.find((s) => s.sceneId === check.sceneId)?.checkIds ?? []).filter((x) => x !== check.id);
      const list = await Promise.all(ids.map((x) => api<Check>(`/api/checks/${x}`).catch(() => null)));
      if (live) setOthers(list.flatMap((c) => (c && c.source.type === "video" && c.source.frameMs !== null && c.status !== "running" && c.status !== "failed"
        ? [{ ms: c.source.frameMs, check: c }] : [])));
    }).catch(() => {}); // the other visits are extra; this frame's outlines still show
    api<Motion>(`/api/video/inspections/${inspectionId}/motion`).then((m) => live && setMotion(m)).catch(() => live && setMotion("failed"));
    return () => { live = false; };
  }, [inspectionId, check.sceneId, check.id]);
  // The video's own time, every animation frame while it plays (timeupdate comes only a few times a second, and
  // animation frames stop in a hidden tab, so seeked and timeupdate set it too).
  useEffect(() => {
    let raf = 0, last = -1;
    const tick = () => {
      const ms = (ref.current?.currentTime ?? frameMs / 1000) * 1000;
      if (ms !== last) setT((last = ms));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frameMs]);

  const m = typeof motion === "object" ? motion : null;
  const visits: Visit[] = useMemo(() => [{ ms: frameMs, check }, ...others].sort((a, b) => a.ms - b.ms).map((v) => {
    const shapes = inspectionShapes(v.check.result);
    const tracks = m && shapes.map((s) => s.boxes.map((b) => trackBox(m, b, (v.ms / 1000) * m.fps, (TRACK_MS / 1000) * m.fps)));
    return { ...v, shapes, tracks };
  }), [frameMs, check, others, m]);

  const near = visits.reduce((a, b) => (Math.abs(b.ms - t) < Math.abs(a.ms - t) ? b : a));
  const on = Math.abs(near.ms - t) <= (near.tracks ? TRACK_MS : NEAR_MS);
  const atFrame = Math.abs(frameMs - t) < 50; // this inspection's own frame: its masks and framing guide fit exactly
  let shapes: Shape[] = [];
  if (on && near.tracks && m) {
    const f = (t / 1000) * m.fps, still = Math.abs(near.ms - t) < 500 / m.fps; // masks only on a checked frame itself
    shapes = near.shapes.flatMap((s, i) => {
      const boxes = near.tracks![i].map((tr) => boxAt(tr, f)).filter((b): b is UnitBox => !!b);
      return boxes.length ? [{ ...s, boxes, masks: still ? s.masks : undefined }] : [];
    });
  } else if (on) shapes = near.shapes;

  const seek = (ms: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    setT(ms);
  };
  const jump = (ms: number) => { ref.current?.pause(); seek(ms); };
  const seekAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (r && r.width && durationMs) seek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * durationMs);
  };
  const toggle = () => {
    const v = ref.current;
    if (v) void (v.paused ? v.play() : v.pause());
  };

  return (
    // While it plays, only the labels ride along on the video (the rectangles come back when it's paused).
    <div className={playing ? "video-playing" : undefined}>
      <CompareSlider golden={golden} snapshot={check.snapshot} goldenShapes={goldenShapes} newShapes={shapes}
        active={active} onActive={onActive} frame={atFrame ? frame : null} rightLabel="Video"
        surface={
          // #t= opens the player on the checked frame; the media route supports Range requests, so seeking works.
          <video ref={ref} src={`/media/video/${inspectionId}#t=${frameMs / 1000}`} muted playsInline preload="auto" aria-label="Inspection video"
            onLoadedMetadata={(e) => setDurationMs(e.currentTarget.duration * 1000)}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onSeeked={(e) => setT(e.currentTarget.currentTime * 1000)} onTimeUpdate={(e) => setT(e.currentTarget.currentTime * 1000)} />
        } />
      <div className="video-bar">
        <button type="button" className="sm video-play" onClick={toggle} aria-label={playing ? "Pause video" : "Play video"}>
          {playing
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>}
        </button>
        <span className="small muted video-time">{clock(t)}{durationMs ? ` / ${clock(durationMs)}` : ""}</span>
        <div ref={trackRef} className="moments-track" role="slider" tabIndex={0} aria-label="Video position"
          aria-valuemin={0} aria-valuemax={Math.round((durationMs ?? 0) / 1000)} aria-valuenow={Math.round(t / 1000)} aria-valuetext={clock(t)}
          title={motion === null ? "Following the objects through the video…" : m ? "Outlines follow their objects around each checked moment (dots)" : "Outlines show at the checked moments (dots)"}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekAt(e.clientX); }}
          onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e.clientX); }}
          onKeyDown={(e) => {
            const d = { ArrowLeft: -1000, ArrowRight: 1000 }[e.key];
            if (d && durationMs) { e.preventDefault(); seek(Math.min(durationMs, Math.max(0, t + d))); }
          }}>
          {durationMs ? <div className="moments-progress" style={{ width: `${Math.min(100, (t / durationMs) * 100)}%` }} /> : null}
          {durationMs ? visits.map((v) => (
            <button key={v.check.id} type="button" className={`moment${v.check.id === check.id ? " is-this" : ""}${v === near && on ? " is-on" : ""}`}
              style={{ left: `${Math.min(100, (v.ms / durationMs) * 100)}%` }} onPointerDown={(e) => e.stopPropagation()} onClick={() => jump(v.ms)}
              aria-label={`Show the moment at ${clock(v.ms)}${v.check.id === check.id ? " (this inspection)" : ""}`} title={clock(v.ms)} />
          )) : null}
        </div>
      </div>
    </div>
  );
}

export function InspectionDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted?: (id: string) => void }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const load = useCallback(() => api<Check>(`/api/checks/${id}`).then((c) => { setCheck(c); setError(""); }).catch((e) => { setCheck(null); setError(e.message); }), [id]);
  useEffect(() => { setCheck(null); setError(""); setActive(null); void load(); }, [load]);
  useStream<{ id: string }>("check", (e) => e.id === id && void load());

  const act = async (path: string, body: object) => {
    setError("");
    try {
      setCheck(await post<Check>(path, { ...body, by: getReviewer() || undefined }));
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const decide: Decide = (kind, targetId, decision) => void act(`/api/checks/${id}/decide`, { kind, id: targetId, decision });
  const recheck = () => {
    const was = check?.reviewStatus === "reviewed" ? " It was reviewed: it will need review again, and its current result stays in the history." : "";
    if (confirm(`Check this photo again with the current initial photo, items and checklist? It costs about as much as a new inspection.${was}`)) {
      void act(`/api/checks/${id}/recheck`, {});
    }
  };

  const remove = async () => {
    if (check?.status === "running") return setError("Wait until the check finishes.");
    if (!confirm("Delete this inspection? Its photo and results will be gone.")) return;
    setDeleting(true);
    setError("");
    try {
      await api(`/api/checks/${id}`, { method: "DELETE" });
      onChanged();
      onDeleted?.(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  if (!check) return error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>;
  const r = check.result;
  const findings = r.findings ?? [];
  const items = r.items ?? [];
  const rules = r.checklist ?? [];
  const done = check.status !== "running" && check.status !== "failed";
  const differences = findings.filter((f) => !f.outsideFrame && f.status !== "rejected");
  const outside = findings.filter((f) => f.outsideFrame);
  const dismissed = findings.filter((f) => !f.outsideFrame && f.status === "rejected");
  // A watched object's count finding (missing, extra, moved) decides its row: a person or Wonder may have settled it.
  const countFinding = (itemId: string) => findings.find((f) => f.itemId === itemId && !f.outsideFrame && f.kind.startsWith("item_"));
  const itemState = (i: (typeof items)[number]) => {
    const f = countFinding(i.itemId);
    return f ? f.status : i.ok ? "pass" : "fail";
  };
  const itemPassed = items.filter((i) => ["pass", "rejected"].includes(itemState(i))).length;
  const passed = itemPassed + rules.filter((x) => x.status === "pass").length;
  const total = items.length + rules.length;

  // Outlines, keyed so hovering a checklist row lights its outline on both photos, and back.
  const framingGuide = r.alignment?.frame && r.alignment.level !== "aligned" ? r.alignment.frame : null;
  const goldenShapes: Shape[] = [
    ...items.map((i) => ({ id: `item:${i.itemId}`, label: i.name, sub: `${i.expected} expected`, tone: "muted" as Tone, boxes: i.goldenBoxes })),
    ...findings.filter((f) => f.goldenBoxes.length && f.status !== "rejected").map((f) => ({
      id: `finding:${f.id}`, label: f.text, sub: "Where it should be", tone: toneOf(f.status), boxes: f.goldenBoxes, dashed: true,
    })),
  ];

  const sections = new Map<string, RuleResult[]>();
  for (const x of rules) {
    const name = x.section ?? "GENERAL";
    sections.set(name, [...(sections.get(name) ?? []), x]);
  }
  const ratio = (list: { status: string }[], ok: string) => `${list.filter((x) => x.status === ok).length}/${list.length}`;
  const row = { active, onActive: setActive };

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <div className="row">
            <h3>{check.source.type === "video" ? `Video · ${check.source.inspectionName}` : "Photo inspection"}</h3>
            <ReviewPill c={check} />
          </div>
          <div className="muted small">
            {check.source.type === "photo" && Math.abs(Date.parse(check.createdAt) - Date.parse(check.takenAt)) > 60_000
              ? <>Taken {when(check.takenAt)} · uploaded {when(check.createdAt)}</> : when(check.createdAt)} · {STATUS_LABEL[check.status]}
            {check.uploadedBy && <> · sent by {check.uploadedBy}</>}
            {check.source.type === "video" && check.source.frameMs !== null && (
              <> · frame at {clock(check.source.frameMs)}</>
            )}
          </div>
        </div>
        {done && total > 0 && check.status !== "retake" && (
          <div className="progress-box">
            <b>{Math.round((passed / total) * 100)}% OK</b>
            <div className="bar"><div style={{ width: `${(passed / total) * 100}%` }} /></div>
            <span className="muted small">{passed} of {total} points</span>
          </div>
        )}
        <div className="row wrap head-actions">
          {check.status !== "running" && <ReviewStatusButtons check={check} onSet={(status, note) => act(`/api/checks/${id}/review`, { status, note })} />}
          {/* Confirmed issues keep the scene in Issues until a person says they were fixed. */}
          {check.reviewStatus === "reviewed" && check.issues > 0 && (check.fixedAt ? (
            <span className="row fixed-state">
              <span className="pill pill-reviewed" title={`Marked fixed ${when(check.fixedAt)}`}>✓ Fixed</span>
              <button type="button" className="link small" onClick={() => act(`/api/checks/${id}/fixed`, { fixed: false })}>Undo</button>
            </span>
          ) : (
            <button type="button" className="sm primary" onClick={() => act(`/api/checks/${id}/fixed`, { fixed: true })}
              title="The confirmed issues were fixed: the scene leaves Issues once none are open">Mark fixed</button>
          ))}
          <button type="button" className="ghost danger sm" onClick={remove} disabled={deleting || check.status === "running"}
            title={check.status === "running" ? "Wait until the check finishes." : "Delete this inspection"}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {check.status !== "running" && check.flags > 0 && (
        <p className="small review-hint head-hint">Decide {check.flags} flagged point{check.flags === 1 ? "" : "s"} below to mark it reviewed.</p>
      )}

      {error && <div className="banner error" role="alert">{error}</div>}
      {check.status === "running" && <div className="banner info"><span className="spinner" /> Comparing with the initial photo, counting what we watch and checking the checklist. Usually 20–40 seconds.</div>}
      {check.status === "failed" && (
        <div className="banner error">{r.error ?? "The check failed."} <button className="sm" onClick={recheck}>Check again</button></div>
      )}
      {check.outdated && check.status !== "failed" && (
        <div className="banner warn-bg">
          <span><strong>The setup changed after this inspection was checked.</strong> The initial photo, what we watch or the checklist is different now, so this result doesn't include those changes.</span>
          <button className="sm" onClick={recheck}>Re-check</button>
        </div>
      )}
      {check.status === "retake" && (
        <div className="banner warn-bg">
          <strong>Retake the photo.</strong> {r.alignment?.level === "far_off" ? "It's framed too differently from the initial photo to compare." : "It shows a different view."} {r.viewNote}
        </div>
      )}

      {r.summary && <div className="summary"><span className="by-model">✦ Muse Wonder summary</span><p>{r.summary}</p></div>}
      {r.alignment && check.status !== "running" && <Framing a={r.alignment} outside={outside.length + items.reduce((n, i) => n + (i.outsideFrame ?? 0), 0)} />}

      <div className="detail-body">
        <div className="detail-photos">
          {check.source.type === "video" && check.source.frameMs !== null ? (
            <VideoCompare check={check} inspectionId={check.source.inspectionId} frameMs={check.source.frameMs}
              golden={check.golden} goldenShapes={goldenShapes} frame={framingGuide} active={active} onActive={setActive} />
          ) : (
            <CompareSlider golden={check.golden} snapshot={check.snapshot} goldenShapes={goldenShapes} newShapes={inspectionShapes(r)}
              active={active} onActive={setActive} frame={framingGuide} rightLabel="Inspection photo" />
          )}
        </div>

        {done && check.status !== "retake" && (
        <div className="sections">
          {items.length > 0 && (
            <Section name="WATCHED OBJECTS" count={`${itemPassed}/${items.length}`} complete={itemPassed === items.length}
              tone={itemPassed === items.length ? "ok" : itemPassed === 0 ? "issue" : "review"}>
              {items.map((i) => {
                const f = countFinding(i.itemId);
                const note = [f && f.status !== "confirmed" ? f.why : "", i.outsideFrame ? `${i.outsideFrame} more outside the initial photo's view, not counted.` : ""]
                  .filter(Boolean).join(" ");
                return (
                  <Row key={i.itemId} id={`item:${i.itemId}`} {...row} state={itemState(i)} text={`${i.name}: ${i.found} of ${i.expected}`}
                    note={note || undefined} opinion={f?.secondOpinion}
                    onConfirm={f && (() => decide("finding", f.id, "confirm"))} onReject={f && (() => decide("finding", f.id, "reject"))}
                    confirmLabel="It's an issue" rejectLabel="It's fine" />
                );
              })}
            </Section>
          )}
          {[...sections].map(([name, list]) => {
            const passed = list.filter((x) => x.status === "pass").length;
            return (
            <Section key={name} name={name} count={ratio(list, "pass")} complete={list.every((x) => x.status === "pass")}
              tone={passed === list.length ? "ok" : passed === 0 ? "issue" : "review"}>
              {list.map((x) => (
                <Row key={x.ruleId} id={`rule:${x.ruleId}`} {...row} state={x.status} text={x.text} note={`${x.note} ${x.why}`} opinion={x.secondOpinion}
                  onConfirm={() => decide("rule", x.ruleId, "confirm")} onReject={() => decide("rule", x.ruleId, "reject")}
                  confirmLabel="It failed" rejectLabel="It's fine" />
              ))}
            </Section>
            );
          })}
          <Section name="DIFFERENCES FROM THE INITIAL PHOTO" count={String(differences.length)} complete={differences.length === 0}
            tone={differences.length === 0 ? "ok" : "issue"}>
            {differences.length === 0 && <p className="muted small row-pad">Nothing else differs from the initial photo.</p>}
            {differences.map((f) => <FindingRow key={f.id} f={f} {...row} decide={decide} />)}
          </Section>
          {outside.length > 0 && (
            <Section name="OUTSIDE THE INITIAL PHOTO'S VIEW" count={String(outside.length)} tone="muted"
              hint="These were never in the initial photo's frame, so they aren't compared. A person can still flag one.">
              {outside.map((f) => <FindingRow key={f.id} f={f} {...row} decide={decide} />)}
            </Section>
          )}
          {dismissed.length > 0 && (
            <Section name="DISMISSED" count={String(dismissed.length)} tone="muted">
              {dismissed.map((f) => <FindingRow key={f.id} f={f} {...row} decide={decide} />)}
            </Section>
          )}
        </div>
        )}
      </div>

      {check.status !== "running" && <NoteComposer check={check} onSet={(status, note) => act(`/api/checks/${id}/review`, { status, note })} />}

      <History history={check.history} />
      <details className="runs">
        <summary className="muted small">Model activity · ${check.costUsd.toFixed(3)}</summary>
        <RunLog sceneId={check.sceneId} checkId={check.id} />
      </details>
    </div>
  );
}

// Sections start closed: the header's dot and count say how it went; open one to see its rows.
function Section({ name, count, complete, hint, tone, children }: {
  name: string; count: string; complete?: boolean; hint?: string;
  tone?: "ok" | "review" | "issue" | "muted"; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const dot = tone ?? (complete ? "ok" : "review");
  const colour = dot === "ok" ? "var(--ok)" : dot === "review" ? "var(--review)" : dot === "issue" ? "var(--issue)" : "var(--muted)";
  return (
    <div className={`section-card${complete ? " complete" : ""}`}>
      <button className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="toggle" aria-hidden="true">{open ? "−" : "+"}</span>
        <span className="dot" style={{ "--c": colour } as React.CSSProperties} /> {name} <span className="count">{count}</span>
      </button>
      {open && hint && <p className="muted small row-pad">{hint}</p>}
      {open && children}
    </div>
  );
}

function Row({ id, active, onActive, state, text, note, opinion, onConfirm, onReject, confirmLabel = "Confirm", rejectLabel = "Reject" }: {
  id: string; active: string | null; onActive: (id: string | null) => void; state: "pass" | "fail" | "needs_review" | "confirmed" | "rejected";
  text: string; note?: string; opinion?: { verdict: string; note: string };
  onConfirm?: () => void; onReject?: () => void; confirmLabel?: string; rejectLabel?: string;
}) {
  const s = state === "confirmed" ? "fail" : state === "rejected" ? "pass" : state;
  const icon = s === "pass" ? "✓" : s === "fail" ? "✕" : "?";
  const label = s === "pass" ? "OK" : s === "fail" ? "Issue" : "Needs your decision";
  const decidable = !!onConfirm && !!onReject;
  // Both answers stay visible; the current one is pressed, so a reviewer flips it with one click.
  return (
    <div className={`crow crow-${s}${active === id ? " is-lit" : ""}`} onMouseEnter={() => onActive(id)} onMouseLeave={() => onActive(null)}>
      <span className="crow-icon" aria-label={label}>{icon}</span>
      <div className="crow-body">
        <div className="crow-text">{text}</div>
        {note && <div className="muted small">{note}</div>}
        {opinion && <div className="opinion small"><b>✦ Wonder:</b> {opinion.verdict === "real" ? "looks real" : opinion.verdict === "not_real" ? "looks fine" : "unsure"}. {opinion.note}</div>}
        {decidable && (
          <div className="row decide">
            <button className="sm danger-soft" aria-pressed={s === "fail"} disabled={s === "fail"} onClick={onConfirm}>{confirmLabel}</button>
            <button className="sm ok-soft" aria-pressed={s === "pass"} disabled={s === "pass"} onClick={onReject}>{rejectLabel}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function FindingRow({ f, active, onActive, decide }: { f: Finding; active: string | null; onActive: (id: string | null) => void; decide: Decide }) {
  return (
    <Row id={`finding:${f.id}`} active={active} onActive={onActive} state={f.status} text={f.text} note={f.why} opinion={f.secondOpinion}
      onConfirm={() => decide("finding", f.id, "confirm")} onReject={() => decide("finding", f.id, "reject")}
      confirmLabel="It's an issue" rejectLabel="It's fine" />
  );
}

function Framing({ a, outside }: { a: NonNullable<Check["result"]["alignment"]>; outside: number }) {
  const label = a.level === "aligned" ? "Framed like the initial photo" : a.level === "slightly_off" ? "Slightly off" : "Too far off to compare";
  return (
    <div className={`framing framing-${a.level}`}>
      <div className="framing-score">
        {a.score !== null ? <><b>{a.score}</b><span>/100</span></> : <b>{a.level === "aligned" ? "✓" : "!"}</b>}
      </div>
      <div>
        <div><strong>Framing:</strong> {label}</div>
        <div className="muted small">
          {a.source === "sam" ? `Measured from ${a.anchors} watched objects found in both photos.` : "Judged by Spark (too few watched objects to measure)."}
          {a.hint && ` ${a.hint}`}
          {outside > 0 && ` ${outside} thing${outside === 1 ? "" : "s"} outside the initial photo's view ignored.`}
        </div>
      </div>
    </div>
  );
}

// Status toggle lives in the header, left of Delete; the note composer lives
// below the photo workspace, above the review history and model activity.
function ReviewStatusButtons({ check, onSet }: { check: Check; onSet: (status: "needs_review" | "reviewed", note?: string) => void }) {
  const blocked = check.flags > 0;
  return (
    <div className="seg" role="radiogroup" aria-label="Review status">
      <button role="radio" aria-checked={check.reviewStatus === "needs_review"} className={check.reviewStatus === "needs_review" ? "on review" : undefined}
        onClick={() => check.reviewStatus !== "needs_review" && onSet("needs_review")}>Needs review</button>
      <button role="radio" aria-checked={check.reviewStatus === "reviewed"} className={check.reviewStatus === "reviewed" ? "on reviewed" : undefined}
        disabled={blocked && check.reviewStatus !== "reviewed"} title={blocked ? `Decide the ${check.flags} flagged point${check.flags === 1 ? "" : "s"} below first` : undefined}
        onClick={() => check.reviewStatus !== "reviewed" && onSet("reviewed")}>Reviewed</button>
    </div>
  );
}

function NoteComposer({ check, onSet }: { check: Check; onSet: (status: "needs_review" | "reviewed", note?: string) => void }) {
  const [note, setNote] = useState("");
  const [name, setName] = useState(getReviewer());
  const submit = () => {
    onSet(check.reviewStatus, note.trim() || undefined);
    setNote("");
  };
  return (
    <div className="review-box">
      <div className="review-note">
        <input type="text" value={note} maxLength={500} placeholder="Add a note (what was done, who was told…)" aria-label="Review note"
          onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && submit()} />
        <input type="text" value={name} maxLength={60} placeholder="Your name" aria-label="Your name" className="name"
          onChange={(e) => { setName(e.target.value); setReviewer(e.target.value); }} />
        <button onClick={() => note.trim() && submit()} disabled={!note.trim()}>Add note</button>
      </div>
    </div>
  );
}

const ACTION: Record<string, string> = {
  reviewed: "Marked reviewed", needs_review: "Marked needs review", auto_reviewed: "Reviewed automatically", note: "Note",
  fixed: "Marked fixed", unfixed: "Marked not fixed",
  rechecked: "Re-checked", finding_confirmed: "Confirmed issue", finding_rejected: "Dismissed", rule_confirmed: "Rule failed", rule_rejected: "Rule passed",
};

function History({ history }: { history: Review[] }) {
  if (!history.length) return null;
  return (
    <details className="history" open={history.length <= 4}>
      <summary className="small"><strong>Review history</strong> <span className="muted">· {history.length}</span></summary>
      <ol>
        {history.map((h) => (
          <li key={h.id}>
            <span className="small"><strong>{ACTION[h.action] ?? h.action}</strong>{h.note && ` — ${h.note}`}</span>
            <span className="muted small">{h.by ?? "Someone"} · {when(h.at)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

// ---------- run log (every model call, live) ----------
export function RunLog({ sceneId, checkId }: { sceneId: string; checkId?: string }) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    api<Run[]>(`/api/scenes/${sceneId}/runs?limit=30${checkId ? `&checkId=${checkId}` : ""}`).then(setRuns).catch(() => {});
  }, [sceneId, checkId]);
  useStream<Run>("run", (run) => {
    if (run.scene_id === sceneId && (!checkId || run.check_id === checkId)) setRuns((rs) => [run, ...rs].slice(0, 30));
  });
  return <RunTable runs={runs} />;
}

export function RunTable({ runs, withScene }: { runs: Run[]; withScene?: boolean }) {
  if (!runs.length) return <p className="muted small">No model calls yet.</p>;
  return (
    <div className="table-wrap">
      <table className="runs">
        <thead><tr>{withScene && <th>Scene</th>}<th>Step</th><th>Model</th><th>Result</th><th>Time</th><th>Cost</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              {withScene && <td>{r.scene_name ?? "—"}</td>}
              <td>{r.step}</td>
              <td><span className={`model model-${modelKind(r.model)}`}>{r.model}</span></td>
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

const modelKind = (m: string) => (m.includes("sam") ? "sam" : m.includes("wonder") ? "wonder" : "spark");

function summarise(json: string | null): string {
  if (!json) return "";
  const v = JSON.parse(json);
  if (typeof v?.count === "number") return `${v.count} match${v.count === 1 ? "" : "es"}`;
  if (v?.name && v?.phrase) return `${v.name} · "${v.phrase}"`;
  if (v?.same_view === false) return "Different view";
  if (Array.isArray(v?.issues)) return `${v.issues.length} issue${v.issues.length === 1 ? "" : "s"} reported · framing ${v.framing ?? "?"}`;
  if (Array.isArray(v?.items)) return `${v.items.length} objects listed`;
  if (Array.isArray(v?.opinions)) return `${v.opinions.length} second opinion${v.opinions.length === 1 ? "" : "s"}`;
  if (Array.isArray(v?.sections)) return `${v.sections.length} sections drafted`;
  if (Array.isArray(v?.results)) return `${v.results.length} rules checked`;
  if (typeof v?.summary === "string") return v.summary.slice(0, 120);
  return JSON.stringify(v).slice(0, 120);
}
