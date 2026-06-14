import { Spinner } from "./spinner";

type PageLoadingProps = {
  /** Accessible + visible label. Defaults to "Loading". */
  label?: string;
};

/**
 * Centered loading screen for use as a route-level `loading.tsx` Suspense
 * fallback. Fills the available content area so the page does not collapse, and
 * is the single status region for the loading state (the Spinner inside is
 * decorative).
 */
export function PageLoading({ label = "Loading" }: PageLoadingProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-brand"
    >
      <Spinner size="lg" />
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
    </div>
  );
}
