"use client";
import { useEffect, useRef, useState } from "react";
import SignaturePadLib from "signature_pad";
import { Button } from "@/platform/ui/button";
import { cx } from "@/platform/ui/cx";

// Cross-platform cursive stack for the typed-name fallback. Availability varies,
// but the legal record is the stored typed name; the cursive face is cosmetic.
const TYPED_FONT = "'Snell Roundhand', 'Segoe Script', 'Bradley Hand', cursive";

/**
 * Draw-a-signature control with a typed-name fallback. Always outputs a PNG data
 * URL into a hidden <input name={name}> so it serializes through the owning
 * form's FormData with no submit-plumbing changes. Companion hidden inputs record
 * the method (draw/type) and the printed name for the audit trail.
 */
export function SignaturePad({
  name,
  label,
  required = false,
  personName = "",
  defaultValue = "",
  error,
  onChange,
}: {
  name: string;
  label: string;
  required?: boolean;
  personName?: string;
  defaultValue?: string;
  error?: string;
  onChange?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadLib | null>(null);
  const hiddenRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState("");
  const [empty, setEmpty] = useState(!defaultValue);

  // Push the current PNG (or "") into the hidden input the form serializes, and
  // notify the owner so autosave can pick it up.
  function commit(dataUrl: string) {
    if (hiddenRef.current) hiddenRef.current.value = dataUrl;
    setEmpty(!dataUrl);
    onChange?.();
  }

  // Refit the canvas backing store to its CSS box at the current devicePixelRatio,
  // preserving the drawing. A canvas inside a display:none wizard step has zero
  // size, so this reruns when the pad becomes visible (via ResizeObserver).
  function resize() {
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const data = pad.toData();
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.getContext("2d")?.scale(ratio, ratio);
    pad.clear();
    if (data.length) pad.fromData(data);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    // SSR / no-2d-context guard (also the unit-test env): cannot draw, render inert.
    if (!canvas || !canvas.getContext("2d")) return;
    const pad = new SignaturePadLib(canvas, { penColor: "#0f172a", backgroundColor: "rgba(0,0,0,0)" });
    padRef.current = pad;
    const onEnd = () => commit(pad.toDataURL("image/png"));
    pad.addEventListener("endStroke", onEnd);
    if (defaultValue) pad.fromDataURL(defaultValue);
    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      pad.removeEventListener("endStroke", onEnd);
      padRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time init; defaultValue seeds, never re-runs
  }, []);

  function clear() {
    padRef.current?.clear();
    setTyped("");
    commit("");
  }

  // Rasterize the typed name in a cursive face so the stored artifact is always a
  // PNG, giving every display surface a single (image) render path.
  function renderTyped(value: string) {
    setTyped(value);
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    pad.clear();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!value.trim()) { commit(""); return; }
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const w = canvas.width / ratio;
    const h = canvas.height / ratio;
    ctx.fillStyle = "#0f172a";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = `italic ${Math.min(h * 0.5, 44)}px ${TYPED_FONT}`;
    ctx.fillText(value, w / 2, h / 2);
    commit(canvas.toDataURL("image/png"));
  }

  return (
    <div className="block">
      <span className="block text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-critical" aria-hidden="true"> *</span>}
      </span>

      <input ref={hiddenRef} type="hidden" name={name} defaultValue={defaultValue} />
      <input type="hidden" name={`${name}__method`} value={mode} readOnly />
      <input type="hidden" name={`${name}__name`} value={mode === "type" ? typed : personName} readOnly />

      {mode === "draw" ? (
        <div className={cx("mt-1.5 rounded-lg border bg-surface", error ? "border-critical" : "border-border-strong")}>
          <canvas ref={canvasRef} aria-label={`${label} signature pad`} className="h-40 w-full touch-none rounded-lg" />
        </div>
      ) : (
        <input
          type="text"
          value={typed}
          onChange={(e) => renderTyped(e.target.value)}
          placeholder="Type your full name"
          aria-label={`${label} typed signature`}
          className={cx("mt-1.5 w-full rounded-lg border bg-surface px-3 py-2 text-2xl", error ? "border-critical" : "border-border-strong")}
          style={{ fontFamily: TYPED_FONT }}
        />
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={clear}>Clear</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => { clear(); setMode((m) => (m === "draw" ? "type" : "draw")); }}>
          {mode === "draw" ? "Type instead" : "Draw instead"}
        </Button>
        {!empty && <span className="text-xs text-success">Signed</span>}
      </div>

      {error && <span className="mt-1 block text-xs text-critical">{error}</span>}
    </div>
  );
}
