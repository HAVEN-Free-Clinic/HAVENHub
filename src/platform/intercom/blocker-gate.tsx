"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert } from "lucide-react";
import posthog from "posthog-js";
import { SupportLink } from "@/platform/branding/support-link";
import { useFocusTrap } from "@/platform/ui/use-focus-trap";
import { browserProbeDeps, probeContentBlocker, type BlockedProbe } from "./blocker-probe";

/**
 * Blocks the hub when a content blocker is breaking the Intercom Messenger.
 *
 * There is deliberately no way through. A member whose Messenger is blocked
 * cannot reach support and has no sign anything is wrong, so the gate demands
 * the blocker come off rather than letting them discover it at the moment they
 * need help. The false-positive risk that creates is answered in the probe (see
 * ./blocker-probe), not here: by the time this renders, a blocked request has
 * been confirmed twice against a control probe that proves the network works.
 *
 * Does NOT reuse the Modal primitive. Modal renders an unconditional close
 * button and calls onClose on Escape and backdrop click; a no-op onClose would
 * leave a dead X on screen, which reads as broken exactly when the page most
 * needs to be trusted. It shares Modal's focus trap through useFocusTrap, and
 * its scroll lock by construction, but not its dismissal contract.
 */
export function BlockerGate({ appId, supportEmail }: { appId: string; supportEmail: string }) {
  const [failed, setFailed] = useState<BlockedProbe[] | null>(null);
  const [checking, setChecking] = useState(false);
  const settled = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // One probe per full page load. This component lives in the (app) layout, so
  // it survives soft navigation and must not re-probe on every route change.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (settled.current) return;
      // A backgrounded tab throttles fetches, which would read as a block.
      // Defer rather than stand down: opening the hub in a background tab must
      // not buy a free pass, so the listener below picks it up on first view.
      if (document.visibilityState !== "visible") return;
      settled.current = true;
      const result = await probeContentBlocker(appId, browserProbeDeps());
      if (cancelled || !result.blocked) return;
      setFailed(result.failed);
      // /ingest is same-origin proxied, so this usually survives the very
      // blocker that triggered it. It is the only way to learn how often the
      // gate fires and how many people it strands.
      posthog.capture("content_blocker_gate_shown", { probes: result.failed });
    }
    void run();
    document.addEventListener("visibilitychange", run);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", run);
    };
  }, [appId]);

  const recheck = useCallback(async () => {
    setChecking(true);
    const result = await probeContentBlocker(appId, browserProbeDeps());
    setChecking(false);
    if (result.blocked) {
      setFailed(result.failed);
      return;
    }
    setFailed(null);
    posthog.capture("content_blocker_gate_cleared");
  }, [appId]);

  // Turning a blocker off means leaving the tab for the extension menu, so
  // catch them on the way back rather than making them find the button.
  useEffect(() => {
    if (!failed) return;
    function onFocus() {
      void recheck();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [failed, recheck]);

  // Shared with Modal. The re-check button disables itself while it runs, which
  // blurs focus to <body>, so the hook's pull-back is load-bearing here.
  useFocusTrap(panelRef, failed !== null);

  // Scroll lock. No Escape handler on purpose: Escape must do nothing.
  useEffect(() => {
    if (!failed) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [failed]);

  if (!failed) return null;

  return createPortal(
    // Above the help bubble and the toast viewport, both of which sit at z-50.
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="glass-panel flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-auto rounded-2xl p-6 outline-none"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-brand-fg" />
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              Turn off your content blocker to continue
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A content blocker in this browser is blocking HAVEN Hub&apos;s support
              assistant, so you would have no way to reach anyone for help. Turn it off
              for this site to continue.
            </p>
          </div>
        </div>

        <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Extensions</span> (uBlock Origin,
            AdBlock, Ghostery): click the extension icon in your toolbar, then disable it
            for this site.
          </li>
          <li>
            <span className="font-medium text-foreground">Brave</span>: click the Shields
            icon in the address bar and turn Shields off for this site.
          </li>
          <li>
            <span className="font-medium text-foreground">Safari</span>: turn off content
            blockers for this site in Settings, then reload.
          </li>
          <li>
            <span className="font-medium text-foreground">A managed device or network</span>{" "}
            (a clinic laptop, or a home filter like Pi-hole) may block this where you
            cannot change it yourself. Email us and we will sort it out.
          </li>
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            Still stuck?{" "}
            <SupportLink email={supportEmail}>Email the IT team</SupportLink>
          </span>
          <button
            type="button"
            data-testid="blocker-recheck"
            onClick={() => void recheck()}
            disabled={checking}
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60"
          >
            {checking ? "Checking..." : "I've turned it off"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
