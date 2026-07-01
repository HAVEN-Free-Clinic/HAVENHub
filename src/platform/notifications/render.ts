// src/platform/notifications/render.ts

import { esc } from "@/platform/email/render/escape";

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
  const title = `<strong>${esc(input.title)}</strong>`;
  const summary = `<p>${esc(input.summary)}</p>`;
  const link = input.link
    ? `<p><a href="${esc(input.link)}">Open in HAVEN Hub</a></p>`
    : "";
  return `${title}${summary}${link}`;
}
