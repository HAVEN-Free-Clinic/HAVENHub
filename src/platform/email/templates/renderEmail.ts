import { prisma } from "@/platform/db";
import { renderTemplate } from "@/platform/email/render/render";
import { getSetting } from "@/platform/settings/service";
import { log } from "@/platform/logging";
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
  // Collect every {{name}} the template asks for that the caller did not supply.
  //
  // The renderer resolves an unknown name to the empty string, which is right at
  // runtime (an email must still go out) but means drift is invisible: an admin
  // override written against a variable a later code change removed renders a
  // blank where a name or a link should be, and an {{#if}} on a dropped name
  // takes its whole block with it. registry.test.ts pins the SHIPPED templates
  // against their descriptors, so this covers the case tests cannot -- overrides
  // stored in the database, edited by a human, months before the descriptor moved.
  //
  // Warn rather than throw: a degraded email beats no email, and this is a
  // reporting path, not a guard.
  const unknown = new Set<string>();
  const onUnknownName = (name: string) => unknown.add(name);

  const subject = renderTemplate(subjectSource, context, { escape: false, onUnknownName });
  const renderedBody = renderTemplate(bodySource, context, { onUnknownName });

  if (unknown.size > 0) {
    log.warn("[email] template referenced variables the caller did not supply", {
      template: key,
      // Names only. The VALUES are the email's content, which routinely carries
      // member names and links, and this line goes to the shared log stream.
      names: [...unknown].sort().join(", "),
      overridden: byKey.has(key),
    });
  }

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
  brandColor?: string,
): Promise<RenderedEmail> {
  // Plain-text subject header: render without HTML-escaping so per-recipient merge
  // vars (firstName, ...) with "&" or "'" are not garbled. The layout re-escapes
  // {{ subject }} for the <title>, so this is not an XSS vector; the body stays escaped.
  const subject = renderTemplate(input.subject, context, { escape: false });
  const renderedBody = renderTemplate(input.body, context);
  const src = layoutSource ?? (await loadLayoutSource());
  // A campaign send resolves brandColor once and passes it in so the per-recipient
  // loop issues zero DB round-trips (a large audience would otherwise fire one
  // setting.findUnique per recipient concurrently and exhaust the pool). Falls back
  // to a lookup for single-render callers that don't hoist it.
  const resolvedBrandColor = brandColor ?? (await getSetting<string>("branding.brandColor"));
  const html = renderTemplate(src, { brandColor: resolvedBrandColor, ...context, body: renderedBody, subject });
  return { subject, html };
}
