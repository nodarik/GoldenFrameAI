// A photo with outlined objects. Hovering an outline spotlights it (the rest of the photo dims), lifts it with a glow,
// and shows a name tag that follows the cursor. `active` and `onActive` let a list next to the photo do the same.
// With `editable` and `onBoxChange`, that shape's boxes can be dragged and resized by their corners (or nudged with
// the arrow keys, Shift to resize); the change is handed over when the drag ends. With `onBoxDelete`, each box of a
// shape with several has a delete button (or Delete key), for "watch two of these three pillows".
import { type ReactNode, useId, useRef, useState } from "react";
import type { Mask, Media, UnitBox } from "./api.js";

export type Shape = {
  id: string; label: string; sub?: string;
  // Colour of the outline; `tone` picks a status colour instead (ok, issue, review, muted).
  colour?: string; tone?: "ok" | "issue" | "review" | "muted";
  boxes: UnitBox[]; masks?: (Mask | null)[]; dashed?: boolean;
};

const TONE: Record<NonNullable<Shape["tone"]>, string> = {
  ok: "var(--ok)", issue: "var(--issue)", review: "var(--review)", muted: "var(--muted)",
};

type Handle = "move" | "nw" | "ne" | "sw" | "se";
const MIN_SIDE = 0.02;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sameBox = (a: UnitBox, b: UnitBox) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

// Move a box, or drag one corner, by a fraction of the photo; it stays inside the photo and at least MIN_SIDE wide.
function reshape(b: UnitBox, handle: Handle, dx: number, dy: number): UnitBox {
  if (handle === "move") {
    const x = clamp(dx, -b.left, 1 - b.right), y = clamp(dy, -b.top, 1 - b.bottom);
    return { left: b.left + x, top: b.top + y, right: b.right + x, bottom: b.bottom + y };
  }
  const next = { ...b };
  if (handle === "nw" || handle === "sw") next.left = clamp(b.left + dx, 0, b.right - MIN_SIDE);
  else next.right = clamp(b.right + dx, b.left + MIN_SIDE, 1);
  if (handle === "nw" || handle === "ne") next.top = clamp(b.top + dy, 0, b.bottom - MIN_SIDE);
  else next.bottom = clamp(b.bottom + dy, b.top + MIN_SIDE, 1);
  return next;
}

export function AnnotatedPhoto({ media, shapes, active, onActive, onPick, onEmptyClick, label, frame, busyAt, caption, editable, onBoxChange, onBoxDelete }: {
  media: Media; shapes: Shape[]; active?: string | null; onActive?: (id: string | null) => void;
  onPick?: (id: string) => void; onEmptyClick?: (fx: number, fy: number) => void; label: string;
  // Where the golden photo's edges fall on this photo (framing check), drawn as a dashed frame.
  frame?: UnitBox | null; busyAt?: { x: number; y: number } | null; caption?: ReactNode;
  editable?: string | null; onBoxChange?: (id: string, boxes: UnitBox[]) => Promise<void>;
  onBoxDelete?: (id: string, index: number) => void;
}) {
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  // The box being changed, shown in place of the saved one until the change is saved.
  // Kept in a ref too: a key press and its release can both land before the next render.
  const [draft, setDraftState] = useState<{ index: number; box: UnitBox } | null>(null);
  const draftRef = useRef(draft);
  const setDraft = (d: typeof draft) => { draftRef.current = d; setDraftState(d); };
  const grab = useRef<{ index: number; handle: Handle; x: number; y: number; from: UnitBox } | null>(null);
  const [missing, setMissing] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const maskId = useId();
  const current = hover?.id ?? active ?? null;
  const lit = shapes.find((s) => s.id === current);
  const stroke = Math.max(2.5, media.w / 420);

  const move = (id: string) => (e: React.MouseEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    setHover({ id, x: e.clientX - r.left, y: e.clientY - r.top });
    if (hover?.id !== id) onActive?.(id);
  };
  const leave = () => { setHover(null); onActive?.(null); };

  const px = (b: UnitBox) => ({ x: b.left * media.w, y: b.top * media.h, width: (b.right - b.left) * media.w, height: (b.bottom - b.top) * media.h });

  const edited = onBoxChange ? shapes.find((s) => s.id === editable) : undefined;
  const boxesOf = (s: Shape) => (s === edited && draft ? s.boxes.map((b, i) => (i === draft.index ? draft.box : b)) : s.boxes);
  const commit = async () => {
    const d = draftRef.current;
    if (!edited || !d) return;
    const boxes = edited.boxes.map((b, i) => (i === d.index ? d.box : b));
    try {
      if (boxes.some((b, i) => !sameBox(b, edited.boxes[i]))) await onBoxChange!(edited.id, boxes);
    } finally {
      setDraft(null);
    }
  };
  const startDrag = (index: number, handle: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { index, handle, x: e.clientX, y: e.clientY, from: edited!.boxes[index] };
  };
  const dragTo = (e: React.PointerEvent) => {
    const g = grab.current;
    if (!g) return;
    const r = stageRef.current!.getBoundingClientRect();
    setDraft({ index: g.index, box: reshape(g.from, g.handle, (e.clientX - g.x) / r.width, (e.clientY - g.y) / r.height) });
  };
  const endDrag = () => {
    if (!grab.current) return;
    grab.current = null;
    void commit();
  };
  const deletable = !!onBoxDelete && !!edited && edited.boxes.length > 1;
  const nudge = (index: number) => (e: React.KeyboardEvent) => {
    if (deletable && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      return onBoxDelete!(edited!.id, index);
    }
    const step = 0.005;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const cur = draftRef.current;
    const from = cur?.index === index ? cur.box : edited!.boxes[index];
    setDraft({ index, box: reshape(from, e.shiftKey ? "se" : "move", d[0], d[1]) });
  };

  // The file is gone (an upload cut off by a restart): keep the photo's shape so the layout holds, and say so.
  if (missing) {
    return (
      <figure className="aphoto">
        {caption && <figcaption>{caption}</figcaption>}
        <div className="aphoto-stage aphoto-missing" style={{ aspectRatio: `${media.w} / ${media.h}` }} role="img" aria-label={`${label} missing`}>
          This photo didn't save. Upload it again.
        </div>
      </figure>
    );
  }

  return (
    <figure className="aphoto">
      {caption && <figcaption>{caption}</figcaption>}
      <div
        ref={stageRef}
        className={`aphoto-stage${onEmptyClick ? " can-add" : ""}${lit ? " has-lit" : ""}`}
        onClick={(e) => {
          if (!onEmptyClick || (e.target as Element).closest(".shape, .edit-box")) return;
          const r = e.currentTarget.getBoundingClientRect();
          onEmptyClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        }}
      >
        <img src={media.url} alt={label} draggable={false} onError={() => setMissing(true)} />
        <svg viewBox={`0 0 ${media.w} ${media.h}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <mask id={maskId}>
              <rect width={media.w} height={media.h} fill="white" />
              {lit?.boxes.map((b, i) => <rect key={i} {...px(b)} rx={stroke * 3} fill="black" />)}
            </mask>
          </defs>
          {/* Spotlight: everything but the lit object darkens. */}
          <rect className="spot" width={media.w} height={media.h} mask={`url(#${maskId})`} />
          {frame && <rect className="golden-frame" {...px(frame)} strokeWidth={stroke} />}
          {shapes.map((s) => {
            const c = s.colour ?? TONE[s.tone ?? "muted"];
            const cls = `shape${s.id === current ? " is-lit" : current ? " is-dim" : ""}${s.dashed ? " is-dashed" : ""}`;
            return (
              <g key={s.id} className={cls} style={{ "--c": c } as React.CSSProperties}
                onMouseMove={move(s.id)} onMouseLeave={leave} onClick={() => onPick?.(s.id)}>
                {s.masks?.map((m, i) => m && (
                  <path key={`m${i}`} d={m.path} transform={`translate(${m.dx} ${m.dy})`} className="shape-mask" />
                ))}
                {boxesOf(s).map((b, i) => <rect key={i} {...px(b)} rx={stroke * 3} strokeWidth={stroke} className="shape-box" pointerEvents="all" />)}
              </g>
            );
          })}
          {edited && boxesOf(edited).map((b, i) => {
            const r = px(b), h = Math.max(12, media.w / 70);
            const corners: [Handle, number, number][] = [["nw", r.x, r.y], ["ne", r.x + r.width, r.y], ["sw", r.x, r.y + r.height], ["se", r.x + r.width, r.y + r.height]];
            return (
              <g key={`edit${i}`} className="edit-box" style={{ "--c": edited.colour ?? TONE[edited.tone ?? "muted"] } as React.CSSProperties}
                onPointerMove={dragTo} onPointerUp={endDrag} onPointerCancel={endDrag}>
                <rect {...r} className="edit-body" strokeWidth={stroke} onPointerDown={startDrag(i, "move")}
                  tabIndex={0} role="slider" aria-label={`Move ${edited.label}${edited.boxes.length > 1 ? ` (${i + 1} of ${edited.boxes.length})` : ""}: arrow keys move, Shift + arrow keys resize${deletable ? ", Delete removes it" : ""}`}
                  onKeyDown={nudge(i)} onKeyUp={() => void commit()} onBlur={() => void commit()} />
                {corners.map(([handle, x, y]) => (
                  <rect key={handle} x={x - h / 2} y={y - h / 2} width={h} height={h} rx={h / 4} className={`edit-handle edit-${handle}`}
                    strokeWidth={stroke / 1.5} onPointerDown={startDrag(i, handle)} />
                ))}
                {deletable && (
                  <g className="edit-delete" role="button" tabIndex={0} aria-label={`Stop watching this ${edited.label} (${i + 1} of ${edited.boxes.length})`}
                    transform={`translate(${r.x + r.width - h * 1.6} ${r.y + h * 1.6})`}
                    onPointerDown={(e) => e.stopPropagation()} onClick={() => onBoxDelete!(edited.id, i)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onBoxDelete!(edited.id, i))}>
                    <title>Stop watching this one</title>
                    <circle r={h * 0.9} strokeWidth={stroke / 1.5} />
                    <path d={`M${-h * 0.35} ${-h * 0.35}L${h * 0.35} ${h * 0.35}M${h * 0.35} ${-h * 0.35}L${-h * 0.35} ${h * 0.35}`} strokeWidth={stroke / 1.2} />
                  </g>
                )}
              </g>
            );
          })}
        </svg>
        {busyAt && <div className="pending-dot" style={{ left: `${busyAt.x * 100}%`, top: `${busyAt.y * 100}%` }} />}
        {hover && lit && (
          <div className="tag" style={{ left: hover.x, top: hover.y, "--c": lit.colour ?? TONE[lit.tone ?? "muted"] } as React.CSSProperties} role="tooltip">
            <span className="tag-dot" />
            <span>
              <strong>{lit.label}</strong>
              {lit.sub && <small>{lit.sub}</small>}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}
