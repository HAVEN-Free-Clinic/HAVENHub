/**
 * The one measure every piece of the signed-in shell shares: the glass toolbar,
 * the breadcrumb row, the main column, the mobile nav panel and the footer. They
 * were five `max-w-6xl` literals, which is how a shell drifts: widen one and the
 * breadcrumb stops lining up with the heading under it.
 *
 * 7xl (80rem, 1280px) rather than 6xl (72rem). At 6xl a 1440px laptop left
 * 144px of empty canvas on each side while the widest tables (the Master view
 * compliance roster, the attending grid) scrolled sideways inside it. Pages that
 * want a narrower measure still say so through PageBody's named widths; this only
 * moves the outer bound.
 */
export const SHELL_WIDTH = "max-w-7xl";
