import { prisma } from "@/platform/db";
import { renderTemplate } from "@/platform/email/render/render";
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

  const subject = renderTemplate(subjectSource, context);
  const renderedBody = renderTemplate(bodySource, context);

  // When rendering the layout descriptor itself, the caller's `body` is authoritative.
  const layoutContext =
    key === LAYOUT_KEY ? context : { ...context, body: renderedBody, subject };
  const layoutSource = byKey.get(LAYOUT_KEY)?.body ?? layout.defaultBody;
  const html = renderTemplate(layoutSource, layoutContext);

  return { subject, html };
}

async function loadLayoutSource(): Promise<string> {
  const layout = getDescriptor(LAYOUT_KEY);
  if (!layout) throw new Error("Missing layout template");
  const override = await prisma.emailTemplate.findUnique({ where: { key: LAYOUT_KEY } });
  return override?.body ?? layout.defaultBody;
}

export async function renderInlineEmail(
  input: { subject: string; body: string },
  context: Record<string, unknown>,
): Promise<RenderedEmail> {
  const subject = renderTemplate(input.subject, context);
  const renderedBody = renderTemplate(input.body, context);
  const layoutSource = await loadLayoutSource();
  const html = renderTemplate(layoutSource, { ...context, body: renderedBody, subject });
  return { subject, html };
}
