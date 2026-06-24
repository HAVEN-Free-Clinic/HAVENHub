// src/platform/notifications/render.ts

/** Escape the five characters that are unsafe in HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the short-form HTML body for a Teams chat message: a bold title, a
 * one or two line summary, and an optional link back into HAVEN Hub. Teams
 * renders only a limited HTML subset, so this stays intentionally plain.
 */
export function renderTeamsBody(input: {
  title: string;
  summary: string;
  link?: string | null;
}): string {
  const title = `<strong>${escapeHtml(input.title)}</strong>`;
  const summary = `<p>${escapeHtml(input.summary)}</p>`;
  const link = input.link
    ? `<p><a href="${escapeHtml(input.link)}">Open in HAVEN Hub</a></p>`
    : "";
  return `${title}${summary}${link}`;
}
