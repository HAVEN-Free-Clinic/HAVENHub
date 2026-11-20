/**
 * Embedded documents inside a NOTICE field: a slide deck or PDF an applicant
 * reads in place (the info-session slides, a role description PDF).
 *
 * Stored as `validation.embedUrl` -- the link exactly as staff pasted it -- for
 * the same reason the acknowledgement lives there: no new column, and the
 * notice stays display-only (an embed asks nothing, so it never touches the
 * answer schema, review summary, reviewer grid or speed board).
 *
 * The pasted link is NEVER used as an iframe src directly. Staff copy whatever
 * is in their address bar (".../edit?usp=sharing"), and an /edit URL inside a
 * frame either refuses to render or shows the editor chrome. resolveNoticeEmbed
 * rewrites the known providers to their embed form and rejects everything else,
 * so the apply portal only ever frames a short allowlist of hosts. That check
 * runs at RENDER time, not only in the builder, so a stale client or a
 * hand-edited row cannot get an arbitrary page framed on the public portal.
 */

export type NoticeEmbedKind = "slides" | "document";

export type NoticeEmbed = {
  /** The iframe src. */
  src: string;
  /** Where "Open in a new tab" goes: the viewer, not the editor. */
  openUrl: string;
  /** slides -> 16:9 frame; document -> a tall page-shaped frame. */
  kind: NoticeEmbedKind;
};

/** The shape of the embed key inside FormField.validation. */
export type NoticeEmbedValidation = { embedUrl?: string };

/** Shown in the builder under the link input. */
export const NOTICE_EMBED_HINT =
  "Google Slides, Docs or a Drive PDF (shared with “Anyone with the link”), a Canva design, or a direct link to a .pdf.";

function parseHttps(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  // https only: an http frame is blocked as mixed content on the portal anyway,
  // and javascript:/data: must never reach an iframe src.
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url;
}

const GOOGLE_ID = "[A-Za-z0-9_-]+";

/**
 * The embeddable form of a pasted link, or null when the link is not one this
 * notice can show. Pure and isomorphic: the builder calls it to validate input
 * and the renderer calls it again to build the frame.
 */
export function resolveNoticeEmbed(raw: string): NoticeEmbed | null {
  const url = parseHttps(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host === "docs.google.com") {
    // Published-to-web decks/docs: /presentation/d/e/<pubId>/pub|embed
    let m = path.match(new RegExp(`^/presentation/d/e/(${GOOGLE_ID})(?:/|$)`));
    if (m) {
      const base = `https://docs.google.com/presentation/d/e/${m[1]}`;
      return { kind: "slides", src: `${base}/embed?start=false&loop=false`, openUrl: `${base}/pub` };
    }
    m = path.match(new RegExp(`^/presentation/d/(${GOOGLE_ID})(?:/|$)`));
    if (m) {
      const base = `https://docs.google.com/presentation/d/${m[1]}`;
      return { kind: "slides", src: `${base}/embed?start=false&loop=false`, openUrl: `${base}/view` };
    }
    m = path.match(new RegExp(`^/document/d/e/(${GOOGLE_ID})(?:/|$)`));
    if (m) {
      const base = `https://docs.google.com/document/d/e/${m[1]}`;
      return { kind: "document", src: `${base}/pub?embedded=true`, openUrl: `${base}/pub` };
    }
    m = path.match(new RegExp(`^/document/d/(${GOOGLE_ID})(?:/|$)`));
    if (m) {
      const base = `https://docs.google.com/document/d/${m[1]}`;
      return { kind: "document", src: `${base}/preview`, openUrl: `${base}/view` };
    }
    return null;
  }

  if (host === "drive.google.com") {
    // /file/d/<id>/view, or the older /open?id=<id>
    const m = path.match(new RegExp(`^/file/d/(${GOOGLE_ID})(?:/|$)`));
    const id = m?.[1] ?? (path === "/open" ? url.searchParams.get("id") : null);
    if (id && new RegExp(`^${GOOGLE_ID}$`).test(id)) {
      const base = `https://drive.google.com/file/d/${id}`;
      return { kind: "document", src: `${base}/preview`, openUrl: `${base}/view` };
    }
    return null;
  }

  if (host === "www.canva.com" || host === "canva.com") {
    // /design/<id>/<token>/view -- only the public view link embeds.
    const m = path.match(/^\/design\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/view\/?$/);
    if (m) {
      const base = `https://www.canva.com/design/${m[1]}/${m[2]}/view`;
      return { kind: "slides", src: `${base}?embed`, openUrl: base };
    }
    return null;
  }

  // Any other host: only a direct PDF, which the browser's own viewer renders.
  if (/\.pdf$/i.test(path)) {
    const href = url.toString();
    return { kind: "document", src: href, openUrl: href };
  }
  return null;
}

/** The raw embed link stored on a notice, or "" when none. */
export function noticeEmbedUrl(validation: unknown): string {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return "";
  const v = (validation as NoticeEmbedValidation).embedUrl;
  return typeof v === "string" ? v.trim() : "";
}

/** The resolved embed for a notice, or null when it has none (or an unusable one). */
export function noticeEmbed(validation: unknown): NoticeEmbed | null {
  const raw = noticeEmbedUrl(validation);
  return raw ? resolveNoticeEmbed(raw) : null;
}
