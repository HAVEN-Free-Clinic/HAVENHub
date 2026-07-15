export type ModalSize = "default" | "large";

/** Max-width class for the modal panel. `large` suits dense reviewer content
 *  (two-column grids plus essays); `default` keeps the original 4xl width. */
export function modalSizeClass(size: ModalSize = "default"): string {
  return size === "large" ? "max-w-6xl" : "max-w-4xl";
}
