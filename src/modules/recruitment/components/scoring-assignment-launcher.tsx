"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";
import { Button } from "@/platform/ui/button";
import type { ScoringPanel } from "@/modules/recruitment/services/score-assignment";
import { ScoringAssignmentModal } from "./scoring-assignment-modal";

export function ScoringAssignmentLauncher({
  cycleId,
  onLoad,
  onSave,
}: {
  cycleId: string;
  onLoad: (cycleId: string) => Promise<{ panel: ScoringPanel } | { error: string }>;
  onSave: (
    cycleId: string,
    input: { scorerIds: string[]; target: number },
  ) => Promise<{ added: number; removed: number; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  // Assigning changes whose queue holds what and moves every row's "2 of 3"
  // coverage flag, so the roster behind the modal is stale by the time it
  // closes. The action revalidates too; this covers the modal being closed
  // without a save landing on this client.
  function close() {
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Users className="h-4 w-4" />
        Assign scoring
      </Button>
      {open && (
        <ScoringAssignmentModal open={open} onClose={close} cycleId={cycleId} onLoad={onLoad} onSave={onSave} />
      )}
    </>
  );
}
