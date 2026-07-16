import { prisma } from "@/platform/db";
import { renderTemplate } from "@/platform/email/render/render";
import { getSetting } from "@/platform/settings/service";
import { getDescriptor, LAYOUT_KEY } from "./registry";

export type RenderedEmail = { subject: string; html: string };

/**
 * Resolve subject + body for `key` (DB override -> code default), render them with
 * `context`, then wrap the rendered body in the layout template. The layout is the
 * single seam where all emails share a wrapper.
 */
export async function renderEmail(
  key: string,
  context: Record<string, unknown>,
): Promise<RenderedEmail> {
  const descriptor = getDescriptor(key);
  if (!descriptor) throw new Error(`Unknown email template: ${key}`);

  const layout = getDescriptor(LAYOUT_KEY);
  if (!layout) throw new Error("Missing layout template");

  const overrides = await prisma.emailTemplate.findMany({
    where: { key: { in: [key, LAYOUT_KEY] } },
  });
  const byKey = new Map(overrides.map((o) => [o.key, o]));

  const subjectSource = byKey.get(key)?.subject ?? descriptor.defaultSubject;
  const bodySource = byKey.get(key)?.body ?? descriptor.defaultBody;

  // The subject is a plain-text header, so render it without HTML-escaping;
  // otherwise a value with "&" or "'" (e.g. a name like O'Brien) is garbled into
  // an entity. The layout re-escapes {{ subject }} for the HTML <title>, so this
  // is not an XSS vector. Bodies stay escaped since they render as HTML.
  const subject = renderTemplate(subjectSource, context, { escape: false });
  const renderedBody = renderTemplate(bodySource, context);

  // The layout's header band + link color track the admin's brand color. Inject
  // it first so an explicit caller-supplied `brandColor` (rare) still wins.
  const brandColor = await getSetting<string>("branding.brandColor");

  // When rendering the layout descriptor itself, the caller's `body` is authoritative.
  const layoutContext =
    key === LAYOUT_KEY
      ? { brandColor, ...context }
      : { brandColor, ...context, body: renderedBody, subject };
  const layoutSource = byKey.get(LAYOUT_KEY)?.body ?? layout.defaultBody;
  const html = renderTemplate(layoutSource, layoutContext);

  return { subject, html };
}

export async function loadLayoutSource(): Promise<string> {
  const layout = getDescriptor(LAYOUT_KEY);
  if (!layout) throw new Error("Missing layout template");
  const override = await prisma.emailTemplate.findUnique({ where: { key: LAYOUT_KEY } });
  return override?.body ?? layout.defaultBody;
}

export async function renderInlineEmail(
  input: { subject: string; body: string },
  context: Record<string, unknown>,
  layoutSource?: string,
): Promise<RenderedEmail> {
  // Plain-text subject header: render without HTML-escaping so per-recipient merge
  // vars (firstName, ...) with "&" or "'" are not garbled. The layout re-escapes
  // {{ subject }} for the <title>, so this is not an XSS vector; the body stays escaped.
  const subject = renderTemplate(input.subject, context, { escape: false });
  const renderedBody = renderTemplate(input.body, context);
  const src = layoutSource ?? (await loadLayoutSource());
  const brandColor = await getSetting<string>("branding.brandColor");
  const html = renderTemplate(src, { brandColor, ...context, body: renderedBody, subject });
  return { subject, html };
}
