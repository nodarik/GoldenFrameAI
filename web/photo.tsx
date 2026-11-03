// A photo with outlined objects. Hovering an outline spotlights it (the rest of the photo dims), lifts it with a glow,
// and shows a name tag that follows the cursor. `active` and `onActive` let a list next to the photo do the same.
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

export function AnnotatedPhoto({ media, shapes, active, onActive, onPick, onEmptyClick, label, frame, busyAt, caption }: {
  media: Media; shapes: Shape[]; active?: string | null; onActive?: (id: string | null) => void;
  onPick?: (id: string) => void; onEmptyClick?: (fx: number, fy: number) => void; label: string;
  // Where the golden photo's edges fall on this photo (framing check), drawn as a dashed frame.
  frame?: UnitBox | null; busyAt?: { x: number; y: number } | null; caption?: ReactNode;
}) {
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
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

  return (
    <figure className="aphoto">
      {caption && <figcaption>{caption}</figcaption>}
      <div
        ref={stageRef}
        className={`aphoto-stage${onEmptyClick ? " can-add" : ""}${lit ? " has-lit" : ""}`}
        onClick={(e) => {
          if (!onEmptyClick || (e.target as Element).closest(".shape")) return;
          const r = e.currentTarget.getBoundingClientRect();
          onEmptyClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        }}
      >
        <img src={media.url} alt={label} draggable={false} />
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
                {s.boxes.map((b, i) => <rect key={i} {...px(b)} rx={stroke * 3} strokeWidth={stroke} className="shape-box" pointerEvents="all" />)}
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
