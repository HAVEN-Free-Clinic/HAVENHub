"use client";

import type { ComponentProps } from "react";

/**
 * The ref-bearing half of `Checkbox`, isolated behind "use client".
 *
 * WHY IT IS ITS OWN FILE. `indeterminate` is a DOM property, not an attribute,
 * so the only way to set it is to reach the element -- and a ref is exactly what
 * a Server Component may not render. React answers a ref in server-rendered
 * output with:
 *
 *   Error: Refs cannot be used in Server Components, nor passed to Client
 *   Components.
 *
 * The first cut put a CALLBACK ref directly in checkbox.tsx, reasoning that a
 * callback ref is not a hook so a file with no "use client" could carry one.
 * The premise is true and the conclusion is not: hooks are one thing RSC
 * forbids, refs are another, and this is the second. checkbox.tsx is rendered by
 * a couple of dozen server components, so every one of them threw on render and
 * fell back to client rendering -- /, /admin/roles, /admin/terms,
 * /admin/settings, /clinic and /incidents/strikes among them. Nothing 500'd,
 * which is why it reached main: the pages still painted, via a client re-render
 * nobody asked for, and only the e2e suite noticed.
 *
 * So the ref lives HERE, in a real client component, where it cannot leak back
 * into a server render however checkbox.tsx is later edited. That is the whole
 * point of the split: the guarantee is structural rather than a rule someone has
 * to remember.
 *
 * A callback ref rather than useRef + useEffect is still right, and for the
 * original reason: it is re-created each render, so React re-runs it every
 * render, which is what keeps the property in step with the prop.
 */
export function IndeterminateCheckboxInput({
  indeterminate,
  ref,
  ...rest
}: {
  indeterminate: boolean;
} & ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      {...rest}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
        // Forward the caller's own ref, so routing through this component cannot
        // silently steal a ref a call site depends on. Only reachable from a
        // client caller, which is the only kind that can hold one.
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
    />
  );
}
