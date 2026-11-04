// A scene's report: everything that happened there, oldest first, in plain words. The server builds it from stored
// inspections and reviews (no model call); "Summarise with Muse Wonder" adds a short overview of the whole history.
import { useCallback, useEffect, useState } from "react";
import { type CheckStatus, type ReviewStatus, type Scene, type Source, STATUS_LABEL, ago, api, plural, post, useStream, when } from "./api.js";
import { ReviewPill, SourceIcon } from "./inspection.js";

type ReportInspection = {
  id: string; at: string; status: CheckStatus; reviewStatus: ReviewStatus; source: Source; uploadedBy: string | null;
  score: { ok: number; total: number } | null; summary: string | null; error: string | null;
  problems: string[]; toDecide: string[]; confirmed: number; dismissed: number;
  reviewed: { by: string | null; at: string } | null;
  fixed: { by: string | null; at: string } | null;
  notes: { note: string; by: string | null; at: string }[];
};
type Report = {
  initialPhotos: { at: string; current: boolean; replaced: boolean }[];
  items: number; rules: number;
  inspections: ReportInspection[];
  overview: { overview: string; at: string; inspections: number; stale: boolean } | null;
};
type Entry = { kind: "initial"; at: string; replaced: boolean; current: boolean } | ({ kind: "inspection" } & ReportInspection);

const pct = (s: { ok: number; total: number }) => Math.round((s.ok / s.total) * 100);
const kindOf = (i: ReportInspection) => (i.source.type === "video" ? `Video inspection · ${i.source.inspectionName}` : "Photo inspection");

function entriesOf(r: Report): Entry[] {
  return [
    ...r.initialPhotos.map((g) => ({ kind: "initial" as const, ...g })),
    ...r.inspections.map((i) => ({ kind: "inspection" as const, ...i })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

function reviewLine(i: ReportInspection) {
  if (i.status === "running") return "Being checked…";
  const decided = [i.confirmed && `${i.confirmed} confirmed`, i.dismissed && `${i.dismissed} dismissed`].filter(Boolean).join(", ");
  if (!i.reviewed) return `Waiting for review${decided ? ` · ${decided} so far` : ""}`;
  const fixed = i.fixed ? ` · marked fixed${i.fixed.by ? ` by ${i.fixed.by}` : ""} ${when(i.fixed.at)}` : "";
  return `Reviewed ${i.reviewed.by ? `by ${i.reviewed.by}` : "automatically"} · ${when(i.reviewed.at)}${decided ? ` · ${decided}` : ""}${fixed}`;
}

// The same report as plain text, to paste into an email or chat.
function asText(scene: Scene, r: Report) {
  const lines = [`Report: ${scene.name}${scene.group ? ` (${scene.group})` : ""}`, ""];
  if (r.overview) lines.push(r.overview.overview, "");
  for (const e of entriesOf(r)) {
    if (e.kind === "initial") {
      lines.push(`${when(e.at)}: Initial photo ${e.replaced ? "replaced" : "set"}.`);
      continue;
    }
    lines.push(`${when(e.at)}: ${kindOf(e)}${e.score ? `, ${pct(e.score)}% OK` : ""}. ${STATUS_LABEL[e.status]}.`);
    if (e.summary) lines.push(`  ${e.summary}`);
    if (e.error) lines.push(`  ${e.error}`);
    for (const p of e.problems) lines.push(`  - ${p}`);
    if (e.toDecide.length) lines.push(`  Still to decide: ${e.toDecide.join("; ")}`);
    lines.push(`  ${reviewLine(e)}`);
    for (const n of e.notes) lines.push(`  Note${n.by ? ` from ${n.by}` : ""}: ${n.note}`);
  }
  return lines.join("\n");
}

export function ReportPanel({ scene }: { scene: Scene }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => api<Report>(`/api/scenes/${scene.id}/report`).then(setReport).catch((e) => setError((e as Error).message)), [scene.id]);
  useEffect(() => { setReport(null); void load(); }, [load]);
  useStream<{ sceneId: string }>("check", (e) => e.sceneId === scene.id && void load());

  if (!report) return error ? <div className="banner error">{error}</div> : <p className="muted">Loading…</p>;
  const done = report.inspections.filter((i) => i.status !== "running");
  const waiting = done.filter((i) => i.reviewStatus === "needs_review").length;
  const problems = done.reduce((n, i) => n + i.problems.length, 0);

  const summarise = async () => {
    setBusy(true);
    setError("");
    try {
      setReport(await post<Report>(`/api/scenes/${scene.id}/report/overview`, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText(scene, report));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy. Select the text and copy it instead.");
    }
  };

  return (
    <section className="panel report">
      <div className="panel-head">
        <div>
          <h2>Report</h2>
          <p className="muted">
            {done.length ? `${plural(done.length, "inspection")} since ${when(done[0].at)} · ${waiting} waiting for review · ${plural(problems, "problem")} found` : "No inspections yet."}
          </p>
        </div>
        <div className="row">
          <button onClick={copy} disabled={!done.length}>{copied ? "Copied ✓" : "Copy"}</button>
          <button onClick={summarise} disabled={busy || !done.length}>
            {busy ? "Summarising…" : report.overview ? "✦ Summarise again" : "✦ Summarise with Muse Wonder"}
          </button>
        </div>
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}

      {busy && !report.overview && <div className="summary"><span className="by-model">✦ Muse Wonder</span><p className="muted">Reading {plural(done.length, "inspection")}…</p></div>}
      {report.overview && (
        <div className="summary">
          <span className="by-model">
            ✦ Muse Wonder overview · {ago(report.overview.at)}
            {report.overview.stale && !busy && <> · <b>new inspections since</b></>}
          </span>
          <p>{report.overview.overview}</p>
        </div>
      )}

      <ol className="timeline">
        {entriesOf(report).map((e) => e.kind === "initial" ? (
          <li key={`g${e.at}`} className="t-initial">
            <time>{when(e.at)}</time>
            <div>
              <b>Initial photo {e.replaced ? "replaced" : "set"}</b>
              {e.current && <span className="muted"> · {plural(report.items, "watched object")}, {plural(report.rules, "checklist rule")}</span>}
              {e.replaced && <p className="muted small">Inspections after this are compared with the new photo.</p>}
            </div>
          </li>
        ) : (
          <li key={e.id} className={e.problems.length ? "t-issues" : e.reviewStatus === "needs_review" ? "t-review" : "t-ok"}>
            <time>{when(e.at)}</time>
            <div>
              <div className="t-head">
                <a href={`#/scenes/${scene.id}/i/${e.id}`}><SourceIcon source={e.source} /> {kindOf(e)}</a>
                <ReviewPill c={e} />
                <span className="muted small">{e.score ? `${pct(e.score)}% OK · ` : ""}{STATUS_LABEL[e.status]}{e.uploadedBy ? ` · sent by ${e.uploadedBy}` : ""}</span>
              </div>
              {e.summary && <p>{e.summary}</p>}
              {e.error && <p className="error-text">{e.error}</p>}
              {e.problems.length > 0 && <ul className="t-problems">{e.problems.map((p, n) => <li key={n}>{p}</li>)}</ul>}
              {e.toDecide.length > 0 && <p className="muted small">Still to decide: {e.toDecide.join("; ")}</p>}
              <p className="muted small">{reviewLine(e)}</p>
              {e.notes.map((n, k) => <p key={k} className="t-note">“{n.note}”{n.by && <span className="muted"> · {n.by}</span>}</p>)}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
