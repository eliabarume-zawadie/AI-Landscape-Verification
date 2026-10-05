import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { imageUrl } from "../api";
import { RISK_TONE, STATUS_LABEL, STATUS_TONE, type Tone } from "../labels";

export function Tag({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`tag ${tone}`} title={title}>
      {children}
    </span>
  );
}

export const StatusTag = ({ status }: { status: string }) => <Tag tone={STATUS_TONE[status] ?? "neutral"}>{STATUS_LABEL[status] ?? status}</Tag>;

export const RiskTag = ({ level }: { level: string | null }) =>
  level ? <Tag tone={RISK_TONE[level] ?? "neutral"}>{`${level.toLowerCase()} risk`}</Tag> : <span className="muted">—</span>;

/**
 * Before/after wipe: the AFTER photo is revealed over the BEFORE photo by dragging the
 * divider (or with ←/→ when focused). Replaces opening two photos side by side.
 */
export function WipeCompare(props: { locationId: string; beforeId: string; afterId: string; beforeRef: string; afterRef: string }) {
  const [split, setSplit] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const fromPointer = useCallback((clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    setSplit(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  }, []);

  return (
    <div
      ref={box}
      className="wipe"
      style={{ "--split": `${split}%` } as CSSProperties}
      role="slider"
      tabIndex={0}
      aria-label={`Compare ${props.beforeRef} (before) with ${props.afterRef} (after)`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split)}
      aria-valuetext={`${Math.round(split)}% before shown`}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && fromPointer(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setSplit((s) => Math.max(0, s - 5));
        else if (e.key === "ArrowRight") setSplit((s) => Math.min(100, s + 5));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <img src={imageUrl(props.locationId, props.beforeId, "full")} alt={`Before: ${props.beforeRef}`} draggable={false} />
      <img className="after" src={imageUrl(props.locationId, props.afterId, "full")} alt={`After: ${props.afterRef}`} draggable={false} />
      <div className="handle" aria-hidden />
      <span className="label b">BEFORE</span>
      <span className="label a">AFTER</span>
    </div>
  );
}

export interface ViewerItem {
  imageId: string;
  ref: string;
  caption?: string;
}

/** Full-size image viewer. ←/→ to move, Esc to close. Full views are audited server-side. */
export function ImageViewer({ locationId, items, index, onClose }: { locationId: string; items: ViewerItem[]; index: number; onClose(): void }) {
  const [i, setI] = useState(index);
  const item = items[i];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((x) => Math.min(items.length - 1, x + 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items.length, onClose]);
  if (!item) return null;
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Photo ${item.ref}`} onClick={onClose}>
      <img src={imageUrl(locationId, item.imageId, "full")} alt={item.ref} onClick={(e) => e.stopPropagation()} />
      <div className="bar" onClick={(e) => e.stopPropagation()}>
        <span className="mono">{item.ref}</span>
        {item.caption && <span>{item.caption}</span>}
        <span className="muted">
          {i + 1} / {items.length}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => setI((x) => Math.max(0, x - 1))} disabled={i === 0}>
          ← Previous
        </button>
        <button className="btn" onClick={() => setI((x) => Math.min(items.length - 1, x + 1))} disabled={i === items.length - 1}>
          Next →
        </button>
        <button className="btn" onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}

export function Toast({ text }: { text: string | null }) {
  return text ? (
    <div className="toast" role="status">
      {text}
    </div>
  ) : null;
}
