"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/platform/ui/toast/toast";

/**
 * Pops the "Withdrawn from N volunteer assignment(s) this term." toast for
 * `MembershipsCard`, composing the exact same text the removed inline `<Alert>`
 * used to render.
 *
 * Deliberately NOT a `flash.ts` registry entry: `withdrawFromTerm` redirects
 * with `?withdrawn=<count>` unconditionally, including `withdrawn=0` (no active
 * term, or nothing left to withdraw from), and the page only ever meant to show
 * this when the count is greater than zero. The classifier's registry fires
 * whenever a param is present, with no way to also express "and only when the
 * value clears a threshold" -- see flash.ts's own doc comment on this exact
 * case. Calling `useToast()` directly here keeps that zero-suppression exactly
 * where it always lived (in this component), while still moving the actual
 * presentation to a toast.
 *
 * Since `withdrawn` is never claimed by the classifier, it is also never
 * stripped from the URL -- unchanged from before this migration, when the
 * inline `<Alert>` read straight off `searchParams` with no stripping either.
 */
export function WithdrawnToast({ withdrawn }: { withdrawn?: number }) {
  const toast = useToast();
  // Guards StrictMode's double-effect invocation in dev and any unrelated
  // re-render, the same shape flash-reader.tsx uses for its own processedRef.
  const firedFor = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (withdrawn === undefined || withdrawn <= 0) return;
    if (firedFor.current === withdrawn) return;
    firedFor.current = withdrawn;
    toast({
      tone: "success",
      message: `Withdrawn from ${withdrawn} volunteer assignment${withdrawn !== 1 ? "s" : ""} this term.`,
    });
  }, [withdrawn, toast]);

  return null;
}
