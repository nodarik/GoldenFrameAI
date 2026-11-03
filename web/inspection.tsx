// One inspection: review status and history, Wonder's summary, framing, the two photos with outlines, and the
// checklist in sections (watched objects, written rules, differences) like a housekeeping checklist.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type Check, type CheckSummary, type Finding, type Review, type RuleResult, type Run, type Source, STATUS_LABEL,
  api, clock, getReviewer, post, setReviewer, useStream, when,
} from "./api.js";
import { AnnotatedPhoto, type Shape } from "./photo.js";

export function ReviewPill({ c }: { c: Pick<CheckSummary, "reviewStatus" | "status"> }) {
  if (c.status === "running") return <span className="pill pill-running">Checking…</span>;
  return c.reviewStatus === "reviewed"
    ? <span className="pill pill-reviewed">Reviewed</span>
    : <span className="pill pill-review">Needs review</span>;
}

export function SourceIcon({ source }: { source: Source }) {
  return source.type === "video"
    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Walkthrough video"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3z" /></svg>
    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Photo"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>;
}

type Decide = (kind: "finding" | "rule", id: string, decision: "confirm" | "reject") => void;
type Tone = Shape["tone"];
const toneOf = (s: string): Tone => (s === "confirmed" || s === "fail" ? "issue" : s === "needs_review" ? "review" : "ok");

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
  const passed = items.filter((i) => i.ok).length + rules.filter((x) => x.status === "pass").length;
  const total = items.length + rules.length;

  // Outlines, keyed so hovering a checklist row lights its outline on both photos, and back.
  const newShapes: Shape[] = [
    ...items.map((i) => ({ id: `item:${i.itemId}`, label: i.name, sub: `${i.found} of ${i.expected} found`, tone: (i.ok ? "ok" : "issue") as Tone, boxes: i.boxes })),
    ...findings.filter((f) => f.status !== "rejected" || f.outsideFrame).map((f) => ({
      id: `finding:${f.id}`, label: f.text, sub: f.outsideFrame ? "Outside the golden photo's view" : f.status === "needs_review" ? "Needs your decision" : "Issue",
      tone: f.outsideFrame ? ("muted" as Tone) : toneOf(f.status), boxes: f.boxes, masks: f.mask ? [f.mask] : [], dashed: f.kind === "item_missing" || !!f.outsideFrame,
    })),
    ...rules.filter((x) => x.box && x.status !== "pass").map((x) => ({
      id: `rule:${x.ruleId}`, label: x.text, sub: x.note, tone: toneOf(x.status), boxes: [x.box!], masks: x.mask ? [x.mask] : [],
    })),
  ];
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
            <h3>{check.source.type === "video" ? `Walkthrough · ${check.source.inspectionName}` : "Photo inspection"}</h3>
            <ReviewPill c={check} />
          </div>
          <div className="muted small">
            {when(check.createdAt)} · {STATUS_LABEL[check.status]}
            {check.source.type === "video" && check.source.frameMs !== null && (
              <> · <a href={`#/walkthroughs/${check.source.inspectionId}`}>frame at {clock(check.source.frameMs)}</a></>
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
        <button type="button" className="ghost danger sm" onClick={remove} disabled={deleting || check.status === "running"}
          title={check.status === "running" ? "Wait until the check finishes." : "Delete this inspection"}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}
      {check.status === "running" && <div className="banner info"><span className="spinner" /> Comparing with the golden photo, counting what we watch and checking the checklist. Usually 20–40 seconds.</div>}
      {check.status === "failed" && <div className="banner error">{r.error ?? "The check failed. Upload the photo again."}</div>}
      {check.status === "retake" && (
        <div className="banner warn-bg">
          <strong>Retake the photo.</strong> {r.alignment?.level === "far_off" ? "It's framed too differently from the golden photo to compare." : "It shows a different view."} {r.viewNote}
        </div>
      )}

      {check.status !== "running" && <ReviewBox check={check} onSet={(status, note) => act(`/api/checks/${id}/review`, { status, note })} />}

      {r.summary && <div className="summary"><span className="by-model">✦ Muse Wonder summary</span><p>{r.summary}</p></div>}
      {r.alignment && check.status !== "running" && <Framing a={r.alignment} outside={outside.length + items.reduce((n, i) => n + (i.outsideFrame ?? 0), 0)} />}

      <div className="compare">
        <AnnotatedPhoto media={check.golden} label="Golden photo" caption="Golden" shapes={goldenShapes} active={active} onActive={setActive} />
        <AnnotatedPhoto media={check.snapshot} label="Inspection photo" caption={check.source.type === "video" ? "Walkthrough frame" : "Inspection photo"}
          shapes={newShapes} active={active} onActive={setActive} frame={r.alignment?.frame && r.alignment.level !== "aligned" ? r.alignment.frame : null} />
      </div>

      {done && check.status !== "retake" && (
        <div className="sections">
          {items.length > 0 && (
            <Section name="WATCHED OBJECTS" count={`${items.filter((i) => i.ok).length}/${items.length}`} complete={items.every((i) => i.ok)}>
              {items.map((i) => (
                <Row key={i.itemId} id={`item:${i.itemId}`} {...row} state={i.ok ? "pass" : "fail"} text={`${i.name}: ${i.found} of ${i.expected}`}
                  note={i.outsideFrame ? `${i.outsideFrame} more outside the golden view, not counted.` : undefined} />
              ))}
            </Section>
          )}
          {[...sections].map(([name, list]) => (
            <Section key={name} name={name} count={ratio(list, "pass")} complete={list.every((x) => x.status === "pass")}>
              {list.map((x) => (
                <Row key={x.ruleId} id={`rule:${x.ruleId}`} {...row} state={x.status} text={x.text} note={`${x.note} ${x.why}`} opinion={x.secondOpinion}
                  onConfirm={() => decide("rule", x.ruleId, "confirm")} onReject={() => decide("rule", x.ruleId, "reject")}
                  confirmLabel="It failed" rejectLabel="It's fine" />
              ))}
            </Section>
          ))}
          <Section name="DIFFERENCES FROM GOLDEN" count={String(differences.length)} complete={differences.length === 0}>
            {differences.length === 0 && <p className="muted small row-pad">Nothing else differs from the golden photo.</p>}
            {differences.map((f) => <FindingRow key={f.id} f={f} {...row} decide={decide} />)}
          </Section>
          {outside.length > 0 && (
            <Section name="OUTSIDE THE GOLDEN VIEW" count={String(outside.length)} collapsed
              hint="These were never in the golden photo's frame, so they aren't compared. A person can still flag one.">
              {outside.map((f) => <FindingRow key={f.id} f={f} {...row} decide={decide} />)}
            </Section>
          )}
          {dismissed.length > 0 && (
            <Section name="DISMISSED" count={String(dismissed.length)} collapsed>
              {dismissed.map((f) => <FindingRow key={f.id} f={f} {...row} decide={decide} />)}
            </Section>
          )}
        </div>
      )}

      <History history={check.history} />
      <details className="runs">
        <summary className="muted small">Model activity · ${check.costUsd.toFixed(3)}</summary>
        <RunLog sceneId={check.sceneId} checkId={check.id} />
      </details>
    </div>
  );
}

function Section({ name, count, complete, collapsed, hint, children }: {
  name: string; count: string; complete?: boolean; collapsed?: boolean; hint?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div className={`section-card${complete ? " complete" : ""}`}>
      <button className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="toggle" aria-hidden="true">{open ? "−" : "+"}</span>
        <span className="dot" /> {name} <span className="count">{count}</span>
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
  const [changing, setChanging] = useState(false);
  const s = state === "confirmed" ? "fail" : state === "rejected" ? "pass" : state;
  const icon = s === "pass" ? "✓" : s === "fail" ? "✕" : "?";
  const label = s === "pass" ? "OK" : s === "fail" ? "Issue" : "Needs your decision";
  const decidable = !!onConfirm && !!onReject;
  return (
    <div className={`crow crow-${s}${active === id ? " is-lit" : ""}`} onMouseEnter={() => onActive(id)} onMouseLeave={() => onActive(null)}>
      <span className="crow-icon" aria-label={label}>{icon}</span>
      <div className="crow-body">
        <div className="crow-text">{text}</div>
        {note && <div className="muted small">{note}</div>}
        {opinion && <div className="opinion small"><b>✦ Wonder:</b> {opinion.verdict === "real" ? "looks real" : opinion.verdict === "not_real" ? "looks fine" : "unsure"}. {opinion.note}</div>}
        {decidable && (s === "needs_review" || changing) && (
          <div className="row decide">
            <button className="sm danger-soft" onClick={() => { setChanging(false); onConfirm!(); }}>{confirmLabel}</button>
            <button className="sm" onClick={() => { setChanging(false); onReject!(); }}>{rejectLabel}</button>
            {changing && <button className="sm ghost" onClick={() => setChanging(false)}>Cancel</button>}
          </div>
        )}
      </div>
      {decidable && s !== "needs_review" && !changing && <button className="link small" onClick={() => setChanging(true)}>Change</button>}
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
  const label = a.level === "aligned" ? "Framed like the golden photo" : a.level === "slightly_off" ? "Slightly off" : "Too far off to compare";
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
          {outside > 0 && ` ${outside} thing${outside === 1 ? "" : "s"} outside the golden view ignored.`}
        </div>
      </div>
    </div>
  );
}

function ReviewBox({ check, onSet }: { check: Check; onSet: (status: "needs_review" | "reviewed", note?: string) => void }) {
  const [note, setNote] = useState("");
  const [name, setName] = useState(getReviewer());
  const blocked = check.flags > 0;
  const submit = (status: "needs_review" | "reviewed") => {
    onSet(status, note.trim() || undefined);
    setNote("");
  };
  return (
    <div className="review-box">
      <div className="seg" role="radiogroup" aria-label="Review status">
        <button role="radio" aria-checked={check.reviewStatus === "needs_review"} className={check.reviewStatus === "needs_review" ? "on review" : undefined}
          onClick={() => check.reviewStatus !== "needs_review" && submit("needs_review")}>Needs review</button>
        <button role="radio" aria-checked={check.reviewStatus === "reviewed"} className={check.reviewStatus === "reviewed" ? "on reviewed" : undefined}
          disabled={blocked && check.reviewStatus !== "reviewed"} title={blocked ? `Decide the ${check.flags} flagged point${check.flags === 1 ? "" : "s"} below first` : undefined}
          onClick={() => check.reviewStatus !== "reviewed" && submit("reviewed")}>Reviewed</button>
      </div>
      {blocked && <span className="small review-hint">Decide {check.flags} flagged point{check.flags === 1 ? "" : "s"} below to mark it reviewed.</span>}
      <div className="review-note">
        <input type="text" value={note} maxLength={500} placeholder="Add a note (what was done, who was told…)" aria-label="Review note"
          onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && submit(check.reviewStatus)} />
        <input type="text" value={name} maxLength={60} placeholder="Your name" aria-label="Your name" className="name"
          onChange={(e) => { setName(e.target.value); setReviewer(e.target.value); }} />
        <button onClick={() => note.trim() && submit(check.reviewStatus)} disabled={!note.trim()}>Add note</button>
      </div>
    </div>
  );
}

const ACTION: Record<string, string> = {
  reviewed: "Marked reviewed", needs_review: "Marked needs review", auto_reviewed: "Reviewed automatically", note: "Note",
  finding_confirmed: "Confirmed issue", finding_rejected: "Dismissed", rule_confirmed: "Rule failed", rule_rejected: "Rule passed",
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
