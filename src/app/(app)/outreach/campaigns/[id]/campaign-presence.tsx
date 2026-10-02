"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import type { CampaignPresence as Presence } from "@/platform/email/campaigns/service";

/** Often enough that a banner appears within a beat of someone opening the
 *  editor, rare enough to be one tiny request per open tab. Paired with
 *  PRESENCE_WINDOW_MS (60s) on the server, which tolerates two missed beats. */
const HEARTBEAT_MS = 20_000;

/**
 * Who else has this campaign open, and whether the version on screen is stale.
 *
 * Campaigns are shared by everyone granted the scope, so two people editing the
 * same draft is the normal case, not an edge. The save itself refuses to
 * overwrite a newer version (see saveAction); this is the early warning, so
 * nobody spends ten minutes on a body only to be told someone else saved first.
 *
 * Heartbeats pause while the tab is hidden: a background tab is not someone
 * "editing", and the banner on the other side should drop them after the
 * window rather than show a name that left for lunch.
 */
export function CampaignPresence({
  heartbeat,
  leave,
  loadedVersion,
}: {
  heartbeat: () => Promise<Presence | null>;
  leave: () => Promise<void>;
  loadedVersion: number;
}) {
  const [presence, setPresence] = useState<Presence | null>(null);

  useEffect(() => {
    let cancelled = false;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      heartbeat()
        .then((p) => {
          if (!cancelled) setPresence(p);
        })
        .catch(() => {
          // Presence is decoration. A failed beat (offline, deploy in flight)
          // keeps the last answer and tries again next interval.
        });
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
      void leave().catch(() => {});
    };
  }, [heartbeat, leave]);

  if (!presence) return null;
  const stale = presence.contentVersion > loadedVersion;
  const others = presence.editors;

  return (
    <div className="space-y-2" aria-live="polite">
      {stale && (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {presence.savedByName ?? "Someone else"} saved a newer version of this campaign.
              Saving now will ask before replacing it. Reload to see their changes (anything you
              have not saved will be lost).
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </Alert>
      )}
      {others.length > 0 && (
        <Alert tone="info">
          {formatNames(others)} {others.length === 1 ? "is" : "are"} also editing this campaign.
          Coordinate before saving so you do not overwrite each other.
        </Alert>
      )}
    </div>
  );
}

function formatNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
