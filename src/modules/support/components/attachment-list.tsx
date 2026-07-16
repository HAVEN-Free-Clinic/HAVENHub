/**
 * AttachmentList: a compact list of file links for a ticket or comment.
 * Each link hits the authenticated download route, which enforces
 * requester-or-manager (and INTERNAL-comment manager-only) access and
 * always forces a download.
 */

type AttachmentRow = { id: string; filename: string; size: number };

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

export function AttachmentList({ attachments }: { attachments: AttachmentRow[] }) {
  if (attachments.length === 0) return null;

  return (
    <ul className="mt-2 space-y-1">
      {attachments.map((a) => (
        <li key={a.id}>
          <a
            href={`/support/attachment/${a.id}`}
            className="inline-flex items-center gap-1.5 text-sm text-brand-fg underline underline-offset-2 hover:no-underline"
          >
            {a.filename}
          </a>
          <span className="ml-1.5 text-xs text-muted-foreground">({formatSize(a.size)})</span>
        </li>
      ))}
    </ul>
  );
}
