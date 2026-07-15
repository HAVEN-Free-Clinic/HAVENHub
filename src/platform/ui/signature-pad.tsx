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
 *
 * The <canvas> is ALWAYS mounted (never conditionally rendered per mode) so
 * signature_pad stays bound to a single live node for the component's lifetime,
 * and the typed-name rasterization has a real canvas to draw onto. Draw vs. type
 * is toggled by gating pointer input on the shared canvas, not by swapping it.
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
  // Keep the latest onChange in a ref so the one-time init effect's endStroke
  // handler always calls the current callback, never a stale first-render closure.
  // Updated in an effect (not during render) so refs are only touched outside render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState("");
  const [empty, setEmpty] = useState(!defaultValue);

  // Push the current PNG (or "") into the hidden input the form serializes, and
  // notify the owner so autosave can pick it up.
  function commit(dataUrl: string) {
    if (hiddenRef.current) hiddenRef.current.value = dataUrl;
    setEmpty(!dataUrl);
    onChangeRef.current?.();
  }

  // Refit the canvas backing store to its CSS box, preserving the current image.
  // Drawn strokes are re-rendered from vector data; a seeded/typed raster (no
  // stroke data) is re-rendered from the last committed PNG in the hidden input.
  // A canvas inside a display:none wizard step has zero size, so this early-returns
  // and reruns via ResizeObserver once the pad becomes visible.
  function resize() {
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const strokes = pad.toData();
    const current = hiddenRef.current?.value ?? "";
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    ctx?.scale(ratio, ratio);
    pad.clear();
    if (strokes.length) {
      pad.fromData(strokes);
    } else if (ctx && current.startsWith("data:image/png")) {
      // A seeded (defaultValue) or typed signature is a raster with no stroke data;
      // redraw it directly at CSS dimensions (the context is already ratio-scaled).
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, width, height);
      img.src = current;
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    // SSR / no-2d-context guard (also the unit-test env): cannot draw, render inert.
    if (!canvas || !canvas.getContext("2d")) return;
    const pad = new SignaturePadLib(canvas, { penColor: "#0f172a", backgroundColor: "rgba(0,0,0,0)" });
    padRef.current = pad;
    const onEnd = () => commit(pad.toDataURL("image/png"));
    pad.addEventListener("endStroke", onEnd);
    // Seed defaultValue into the hidden input is already done via the input's
    // defaultValue attribute; resize() re-renders it onto the canvas from there.
    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      pad.removeEventListener("endStroke", onEnd);
      padRef.current = null;
    };
    // Deliberately empty deps: one-time init. The canvas is always mounted (never
    // conditionally rendered), so the pad binds to it exactly once for the
    // component's lifetime; commit/resize are stable across renders via refs.
  }, []);

  function clear() {
    padRef.current?.clear();
    setTyped("");
    commit("");
  }

  function switchMode(next: "draw" | "type") {
    clear();
    setMode(next);
  }

  // Rasterize the typed name in a cursive face onto the shared (always-mounted)
  // canvas so the stored artifact is always a PNG on the same hidden input the
  // draw path writes.
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

      {/* Always mounted: signature_pad stays bound and typed rasterization has a
          live canvas. In type mode pointer input is disabled so only the text
          field drives it. */}
      <div className={cx("mt-1.5 rounded-lg border bg-surface", error ? "border-critical" : "border-border-strong")}>
        <canvas
          ref={canvasRef}
          aria-label={`${label} signature pad`}
          className={cx("h-40 w-full rounded-lg", mode === "draw" ? "touch-none" : "pointer-events-none")}
        />
      </div>

      {mode === "type" && (
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
        <Button type="button" variant="outline" size="sm" onClick={() => switchMode(mode === "draw" ? "type" : "draw")}>
          {mode === "draw" ? "Type instead" : "Draw instead"}
        </Button>
        {!empty && <span className="text-xs text-success">Signed</span>}
      </div>

      {error && <span className="mt-1 block text-xs text-critical">{error}</span>}
    </div>
  );
}
