"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";
import { Button } from "@/platform/ui/button";
import type { SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
import type { ReviewApplicationView } from "@/modules/recruitment/services/speed-score";
import { SpeedScoreModal } from "./speed-score-modal";

export function SpeedScoreLauncher({
  items,
  onScore,
  onLoad,
}: {
  items: SpeedScoreItem[];
  onScore: (applicationId: string, score: number, comments: string | null) => Promise<{ error?: string }>;
  onLoad: (applicationId: string) => Promise<{ view: ReviewApplicationView } | { error: string }>;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const unscored = items.filter((i) => i.myScore == null).length;
  // speedScoreAction intentionally does not revalidate (so the modal stays open
  // and advances). Refresh on close so the roster's committee averages reflect
  // the scores just entered, and a reopen starts from fresh server data.
  function close() {
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button type="button" variant="primary" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Zap className="h-4 w-4" />
        Speed score{unscored > 0 ? ` (${unscored})` : ""}
      </Button>
      {open && (
        <SpeedScoreModal
          open={open}
          onClose={close}
          items={items}
          onScore={onScore}
          onLoad={onLoad}
        />
      )}
    </>
  );
}
