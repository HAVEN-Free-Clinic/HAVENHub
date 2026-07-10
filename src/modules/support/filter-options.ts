import type { TechRequestStatus, TechRequestCategory, TechRequestPriority } from "@prisma/client";
import { STATUS_LABELS } from "./components/status-badge";
import { CATEGORY_LABELS, PRIORITY_LABELS } from "./labels";

/**
 * Canonical enum-value lists for the support filter UI, derived from the label
 * maps. Kept in this server-safe module (no "use client") so both the client
 * filter bar and the server pages that validate query/form input against them
 * import the real arrays.
 *
 * These previously lived in the "use client" request-filters module. Importing
 * a plain value from a client module into a Server Component yields a
 * client-reference proxy rather than the value itself, so calling .includes()
 * on them in the server pages' pick() helper threw "includes is not a function".
 */
export const ALL_STATUSES = Object.keys(STATUS_LABELS) as TechRequestStatus[];
export const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as TechRequestCategory[];
export const ALL_PRIORITIES = Object.keys(PRIORITY_LABELS) as TechRequestPriority[];
