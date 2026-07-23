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
 * The PNG lives in React state and drives a CONTROLLED hidden input. An
 * uncontrolled input whose value is set imperatively via a ref is reset back to
 * its defaultValue on the next re-render (e.g. the autosave/`setState` that fires
 * right after a stroke), which silently dropped the captured signature before
 * submit. A controlled value survives every re-render, matching how the sibling
 * __method / __name inputs already work.
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
  helpText,
  personName = "",
  defaultValue = "",
  defaultMethod = "draw",
  defaultName = "",
  error,
  onChange,
  onValueChange,
}: {
  name: string;
  label: string;
  required?: boolean;
  helpText?: string | null;
  personName?: string;
  defaultValue?: string;
  // A resumed draft carries the method/printed-name it was captured with (the
  // companion __method / __name inputs). Seeding from them keeps a typed
  // signature typed (not silently relabelled "draw") and restores the typed name.
  defaultMethod?: "draw" | "type";
  defaultName?: string;
  error?: string;
  onChange?: () => void;
  // Fired with the committed value (a PNG data URL, or "" when cleared) so an
  // owner that gates other fields on this signature's presence can react. Every
  // other control reports its value this way; without it a visibleWhen condition
  // keyed on a SIGNATURE field never updates client-side, so the server enforced
  // a required field the applicant was shown as hidden.
  onValueChange?: (value: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadLib | null>(null);
  const [mode, setMode] = useState<"draw" | "type">(defaultMethod === "type" ? "type" : "draw");
  const [typed, setTyped] = useState(defaultMethod === "type" ? defaultName : "");
  // The captured PNG data URL. Drives the controlled hidden input below.
  const [value, setValue] = useState(defaultValue);

  // Keep the latest onChange and value in refs so the one-time init effect's
  // endStroke handler and resize() (both captured once, with [] deps) always see
  // the current values without re-binding. Updated in effects, never during render
  // (react-hooks/refs forbids mutating a ref in the render body).
  const onChangeRef = useRef(onChange);
  const onValueChangeRef = useRef(onValueChange);
  const valueRef = useRef(value);
  useEffect(() => { onChangeRef.current = onChange; });
  useEffect(() => { onValueChangeRef.current = onValueChange; });
  useEffect(() => { valueRef.current = value; });

  // Push the current PNG (or "") into React state -> the controlled hidden input,
  // notify the owner so autosave can pick it up, and report the value so an owner
  // gating other fields on this signature can update its visibility map.
  function commit(dataUrl: string) {
    setValue(dataUrl);
    onChangeRef.current?.();
    onValueChangeRef.current?.(dataUrl);
  }

  // Refit the canvas backing store to its CSS box, preserving the current image.
  // Every non-empty signature -- freshly drawn strokes, a typed rasterization, or
  // a resumed draft -- lives in the last committed PNG (endStroke/renderTyped both
  // commit the full canvas), so we always re-render from that raster. Re-rendering
  // drawn strokes from vector data instead would drop any seeded/typed raster the
  // strokes were layered onto (a resumed drawn draft loses its original ink the
  // moment a new stroke coexists with it). A canvas inside a display:none wizard
  // step has zero size, so this early-returns and reruns via ResizeObserver once
  // the pad becomes visible.
  function resize() {
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const current = valueRef.current;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    ctx?.scale(ratio, ratio);
    pad.clear();
    if (ctx && current.startsWith("data:image/png")) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, width, height);
      img.src = current;
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    // SSR / no-2d-context guard (also the unit-test env): cannot draw, render inert.
    if (!canvas || !canvas.getContext("2d")) return;
    // Dark ink on a white "paper" background baked into the PNG. A transparent
    // background left the near-black ink invisible wherever the signature sits on
    // a dark surface -- while signing on the app's dark theme, and in the stored
    // image shown in the reviewer views. A self-contained white background makes
    // the signature legible on any surface, capture-side and at every display site.
    const pad = new SignaturePadLib(canvas, { penColor: "#0f172a", backgroundColor: "#ffffff" });
    padRef.current = pad;
    const onEnd = () => commit(pad.toDataURL("image/png"));
    pad.addEventListener("endStroke", onEnd);
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
  function renderTyped(v: string) {
    setTyped(v);
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    pad.clear();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!v.trim()) { commit(""); return; }
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const w = canvas.width / ratio;
    const h = canvas.height / ratio;
    ctx.fillStyle = "#0f172a";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = `italic ${Math.min(h * 0.5, 44)}px ${TYPED_FONT}`;
    ctx.fillText(v, w / 2, h / 2);
    commit(canvas.toDataURL("image/png"));
  }

  const empty = !value;
  const errorId = `${name.replace(/[^\w-]/g, "_")}-error`;
  const describedBy = error ? errorId : undefined;

  return (
    <div className="block">
      <span className="block text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-critical" aria-hidden="true"> *</span>}
      </span>
      {helpText && <span className="mt-1 block text-xs text-muted-foreground">{helpText}</span>}

      <input type="hidden" name={name} value={value} readOnly />
      <input type="hidden" name={`${name}__method`} value={mode} readOnly />
      <input type="hidden" name={`${name}__name`} value={mode === "type" ? typed : personName} readOnly />

      {/* Always mounted: signature_pad stays bound and typed rasterization has a
          live canvas. In type mode pointer input is disabled so only the text
          field drives it. */}
      <div className={cx("mt-1.5 rounded-lg border bg-surface", error ? "border-critical" : "border-border-strong")}>
        <canvas
          ref={canvasRef}
          aria-label={`${label} signature pad${required ? ", required" : ""}`}
          aria-describedby={describedBy}
          className={cx("h-40 w-full rounded-lg", mode === "draw" ? "touch-none" : "pointer-events-none")}
        />
      </div>

      {mode === "type" && (
        <input
          type="text"
          value={typed}
          onChange={(e) => renderTyped(e.target.value)}
          placeholder="Type your full name"
          aria-label={`${label} typed signature${required ? ", required" : ""}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx("mt-1.5 w-full rounded-lg border bg-surface px-3 py-2 text-2xl", error ? "border-critical" : "border-border-strong")}
          style={{ fontFamily: TYPED_FONT }}
        />
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={clear}>Clear</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => switchMode(mode === "draw" ? "type" : "draw")}>
          {mode === "draw" ? "Type instead" : "Draw instead"}
        </Button>
        {/* role="status" (implicit aria-live="polite") announces capture to AT,
            which cannot perceive the ink on the canvas. */}
        <span role="status" className={cx("text-xs text-success", empty && "sr-only")}>
          {empty ? "No signature yet" : "Signed"}
        </span>
      </div>

      {error && <span id={errorId} role="alert" className="mt-1 block text-xs text-critical">{error}</span>}
    </div>
  );
}
