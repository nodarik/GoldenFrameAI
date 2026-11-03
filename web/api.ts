// Shared API types, fetch helper, live updates and small formatting helpers for every page.
import { useEffect, useRef } from "react";

export type UnitBox = { left: number; top: number; right: number; bottom: number };
export type Mask = { path: string; dx: number; dy: number };
export type Media = { url: string; w: number; h: number };

export type Item = {
  id: string; name: string; phrase: string; expectedCount: number; boxes: UnitBox[]; tapBox: UnitBox;
  mask: Mask | null; masks: (Mask | null)[] | null; phraseMatches: boolean; positionMatters: boolean;
};
export type Rule = { id: string; text: string; section: string };

export type CheckStatus = "running" | "ok" | "issues" | "needs_review" | "retake" | "failed";
export type ReviewStatus = "needs_review" | "reviewed";
export type LastCheck = { id: string; status: CheckStatus; reviewStatus: ReviewStatus; createdAt: string; issues: number; flags: number };

export type SceneSummary = {
  id: string; name: string; group: string; assignee: string; createdAt: string; golden: Media | null;
  itemCount: number; ruleCount: number; toReview: number; lastCheck: LastCheck | null;
};
export type Scene = { id: string; name: string; group: string; assignee: string; golden: Media | null; items: Item[]; checklist: Rule[] };
export type Integration = { ingestPath: string; token: string; webhookUrl: string; webhookSecret: string };

export type SecondOpinion = { verdict: "real" | "not_real" | "unsure"; note: string };
export type Finding = {
  id: string; kind: string; text: string; itemId: string | null; boxes: UnitBox[]; goldenBoxes: UnitBox[]; mask: Mask | null;
  source: "sam" | "spark" | "both"; status: "confirmed" | "needs_review" | "rejected"; why: string;
  outsideFrame?: boolean; secondOpinion?: SecondOpinion;
};
export type RuleResult = {
  ruleId: string; text: string; section?: string; verdict: "pass" | "fail" | "unclear"; note: string;
  box: UnitBox | null; mask: Mask | null; status: "pass" | "fail" | "needs_review"; why: string; secondOpinion?: SecondOpinion;
};
export type ItemResult = {
  itemId: string; name: string; expected: number; found: number; boxes: UnitBox[]; goldenBoxes: UnitBox[]; ok: boolean; outsideFrame?: number;
};
export type Alignment = {
  score: number | null; level: "aligned" | "slightly_off" | "far_off"; hint: string; source: "sam" | "spark"; anchors: number; frame: UnitBox | null;
};
export type Source = { type: "photo" } | { type: "video"; inspectionId: string; inspectionName: string; frameMs: number | null };
export type Review = { id: number; action: string; note: string | null; by: string | null; at: string };

export type CheckSummary = {
  id: string; sceneId: string; status: CheckStatus; createdAt: string; costUsd: number;
  reviewStatus: ReviewStatus; reviewedAt: string | null; issues: number; flags: number; source: Source;
  score: { ok: number; total: number } | null; snapshot: Media;
  // The golden photo this check was compared with (the scene's may have been replaced since).
  golden: Media;
};
export type Check = CheckSummary & {
  result: {
    sameView?: boolean; viewNote?: string; items?: ItemResult[]; findings?: Finding[]; checklist?: RuleResult[];
    alignment?: Alignment; summary?: string; error?: string;
  };
  history: Review[];
};

export type Run = {
  id: number; step: string; model: string; input_summary: string; ms: number; cost_usd: number; error: string | null; at: string;
  output_json: string | null; scene_id: string | null; check_id: string | null; scene_name?: string | null;
};

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof data.error === "string" ? data.error : `Request failed (${res.status})`, res.status);
  return data as T;
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

// POST a FormData with upload progress (fetch can't report upload progress, so XHR is used).
// onProgress receives 0-100 while the request body uploads.
export function uploadForm<T>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
        reject(new ApiError(typeof data.error === "string" ? data.error : `Request failed (${xhr.status})`, xhr.status));
      } catch {
        reject(new ApiError(`Request failed (${xhr.status})`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError("Upload failed. Check your connection and try again.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      };
    }
    xhr.send(form);
  });
}

// One shared connection to the server's live updates (run, check, event, inspection).
let stream: EventSource | null = null;
export function useStream<T>(type: string, on: (data: T) => void) {
  const ref = useRef(on);
  useEffect(() => { ref.current = on; });
  useEffect(() => {
    stream ??= new EventSource("/api/stream");
    const handler = (e: Event) => ref.current(JSON.parse((e as MessageEvent).data));
    stream.addEventListener(type, handler);
    return () => stream?.removeEventListener(type, handler);
  }, [type]);
}

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export const COLOURS = ["#2f7de1", "#1d9e75", "#e0662f", "#7f6ee0", "#d4537e", "#c48a16", "#5c9a1f", "#e24b4a", "#1aa3b8", "#9a5bd1"];

// The reviewer's name for review history. There are no accounts: it's remembered in this browser only.
const REVIEWER_KEY = "gf_reviewer";
export const getReviewer = () => { try { return localStorage.getItem(REVIEWER_KEY) ?? ""; } catch { return ""; } };
export const setReviewer = (name: string) => { try { localStorage.setItem(REVIEWER_KEY, name); } catch { /* private mode */ } };

// Board columns: what a manager has to do next for each scene.
export type Column = "setup" | "ready" | "review" | "issues" | "reviewed";
export const COLUMNS: { id: Column; title: string; hint: string }[] = [
  { id: "setup", title: "Not set up", hint: "Needs a golden photo and something to watch or a checklist" },
  { id: "ready", title: "Ready", hint: "Set up, no inspection yet" },
  { id: "review", title: "Needs review", hint: "An inspection waits for a person" },
  { id: "issues", title: "Issues", hint: "Reviewed, something needs fixing or a retake" },
  { id: "reviewed", title: "Reviewed", hint: "Latest inspection reviewed and clean" },
];
export function columnOf(s: SceneSummary): Column {
  if (!s.golden || (s.itemCount === 0 && s.ruleCount === 0)) return "setup";
  if (!s.lastCheck) return "ready";
  if (s.toReview > 0 || s.lastCheck.reviewStatus === "needs_review") return "review";
  if (s.lastCheck.issues > 0 || s.lastCheck.status === "retake" || s.lastCheck.status === "failed") return "issues";
  return "reviewed";
}

export const STATUS_LABEL: Record<CheckStatus, string> = {
  running: "Checking…", ok: "All good", issues: "Issues found", needs_review: "Flags to decide", retake: "Retake photo", failed: "Check failed",
};
