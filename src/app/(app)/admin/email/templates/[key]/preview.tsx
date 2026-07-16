"use client";

import { useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { renderTemplate } from "@/platform/email/render/render";
import type { VariableDef } from "@/platform/email/templates/types";
import { Input, Textarea, Field } from "@/platform/ui/input";

type Mode = "rich" | "source";

export function TemplateEditor(props: {
  templateKey?: string;
  variables: VariableDef[];
  initialSubject: string;
  initialBody: string;
  isLayout: boolean;
  layoutSource: string;
  brandColor: string;
}) {
  const [subject, setSubject] = useState(props.initialSubject);
  const [body, setBody] = useState(props.initialBody);
  // TipTap (StarterKit only) cannot represent tables, <style>, or a full HTML
  // document, so the rich editor would silently drop them on the first edit. For
  // such templates -- the layout, and any body with a table/style/doctype/head --
  // lock the editor to HTML source mode so the structured markup round-trips intact.
  const richUnsafe = props.isLayout || /<table|<style|<!doctype|<head/i.test(props.initialBody);
  const [mode, setMode] = useState<Mode>(richUnsafe ? "source" : "rich");
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  const editor = useEditor({
    immediatelyRender: false, // avoid SSR hydration mismatch in Next App Router
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: "Write your message…" }),
    ],
    content: props.initialBody,
    editorProps: {
      attributes: { class: "tt-content", "aria-label": "Message body" },
    },
    onUpdate: ({ editor }) => setBody(editor.getHTML()),
  });

  // Sample context: each variable mapped to its sample value, for the live preview.
  const sample = useMemo(() => {
    const ctx: Record<string, unknown> = {};
    for (const v of props.variables) {
      // A boolean-flag variable carries a "true"/"false" sample string, but the
      // template engine treats any non-empty string as truthy, so a "false" flag
      // would still render its {{#if}} block here. Coerce those to real booleans so
      // the preview matches how the flag renders at send time.
      ctx[v.name] = v.sampleValue === "true" ? true : v.sampleValue === "false" ? false : v.sampleValue;
    }
    // The layout's {{ brandColor }} is injected at render time, not a per-template
    // variable, so seed it with the resolved setting; the preview band and links
    // then match what recipients actually see.
    ctx.brandColor = props.brandColor;
    return ctx;
  }, [props.variables, props.brandColor]);

  // The subject is a plain-text header: every send path renders it with
  // escape:false (renderEmail / recruitment render), so the preview must too or it
  // shows HTML entities (e.g. O&#39;Brien) the recipient never sees.
  const previewSubject = renderTemplate(subject, sample, { escape: false });
  // For a normal template, wrap the rendered body inside the (effective) layout.
  // For the layout template itself, the body IS the layout; render it directly.
  const previewDoc = props.isLayout
    ? renderTemplate(body, sample)
    : renderTemplate(props.layoutSource, {
        ...sample,
        subject: previewSubject,
        body: renderTemplate(body, sample),
      });

  function switchMode(next: Mode) {
    if (next === mode) return;
    // Locked to source for templates whose HTML the rich editor cannot represent:
    // switching to rich would strip tables/style/structure on the next edit.
    if (next === "rich" && richUnsafe) return;
    // Source -> rich: push the textarea's HTML into the editor.
    if (next === "rich") editor?.commands.setContent(body, { emitUpdate: false });
    setMode(next);
  }

  function insertToken(token: string) {
    if (mode === "rich") {
      editor?.chain().focus().insertContent(token).run();
      return;
    }
    // Source mode: splice at the textarea cursor.
    const el = sourceRef.current;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <EditorStyles />
      {/* Editor column */}
      <div>
        <Field label="Subject">
          <Input
            name="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. Welcome to HAVEN!"
          />
        </Field>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm font-medium text-foreground-soft">Message body</span>
          <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
            {/* eslint-disable-next-line no-restricted-syntax -- segmented editor-mode toggle, active state applied inline */}
            <button type="button" aria-pressed={mode === "rich"} onClick={() => switchMode("rich")} disabled={richUnsafe} title={richUnsafe ? "This template uses tables or a full HTML layout that the formatted editor can't represent. Edit it as HTML." : undefined} className={`px-2 py-1 ${mode === "rich" ? "bg-brand text-white" : "bg-surface text-foreground-soft"} ${richUnsafe ? "cursor-not-allowed opacity-40" : ""}`}>
              Formatted
            </button>
            {/* eslint-disable-next-line no-restricted-syntax -- segmented editor-mode toggle, active state applied inline */}
            <button type="button" aria-pressed={mode === "source"} onClick={() => switchMode("source")} className={`px-2 py-1 ${mode === "source" ? "bg-brand text-white" : "bg-surface text-foreground-soft"}`}>
              HTML
            </button>
          </div>
        </div>

        {mode === "rich" ? (
          <div className="mt-1 overflow-hidden rounded-xl border border-border">
            <Toolbar editor={editor} />
            <EditorContent editor={editor} />
          </div>
        ) : (
          <Textarea
            ref={sourceRef}
            aria-label="Message body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={16}
            placeholder="<p>Your message…</p>"
            className="mt-1 font-mono text-xs"
          />
        )}

        {/* The body posts via this hidden field, kept in sync with state. */}
        <input type="hidden" name="body" value={body} />

        {props.variables.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-medium text-muted-foreground">Insert a variable:</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {props.variables.map((v) => {
                return (
                  // eslint-disable-next-line no-restricted-syntax -- editor variable-insert token chip
                  <button key={v.name} type="button" title={v.label} onClick={() => insertToken(`{{ ${v.name} }}`)} className="rounded-lg border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground-soft hover:bg-muted-strong">
                    {`{{ ${v.name} }}`}
                  </button>
                );
              })}
              {/* eslint-disable-next-line no-restricted-syntax -- editor variable-insert token chip */}
              <button type="button" title="Conditional block: shows the inner content only when the variable has a value" onClick={() => insertToken("{{#if VARIABLE}}\n\n{{/if}}")} className="rounded-lg border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground-soft hover:bg-muted-strong">
                {`{{#if}}…{{/if}}`}
              </button>
            </div>
            <p className="mt-1 text-xs text-subtle-foreground">
              Conditionals only work in HTML mode. Switch to HTML to edit them precisely.
            </p>
          </div>
        )}
      </div>

      {/* Preview column */}
      <div>
        <div className="text-sm font-medium text-foreground-soft">Preview (with sample data)</div>
        <div className="mt-1 rounded-xl border border-border bg-muted px-3 py-1 text-sm">
          <span className="text-subtle-foreground">Subject:&nbsp;</span>
          <strong>{previewSubject}</strong>
        </div>
        <iframe
          title="preview"
          sandbox="allow-same-origin"
          className="mt-2 h-[34rem] w-full rounded-xl border border-border bg-surface"
          srcDoc={previewDoc}
        />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return <div className="h-9 border-b border-border" />;

  const btn = (active: boolean) =>
    `rounded-lg px-2 py-1 text-sm ${active ? "bg-brand text-white" : "text-foreground-soft hover:bg-muted-strong"}`;

  function setLink() {
    const prev = editor!.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return; // cancelled
    if (url === "") {
      editor!.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor!.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border p-1">
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" aria-pressed={editor.isActive("bold")} className={btn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>
        <strong>B</strong>
      </button>
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" aria-pressed={editor.isActive("italic")} className={btn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <em>I</em>
      </button>
      <span className="mx-1 h-5 w-px bg-border" />
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" aria-pressed={editor.isActive("heading", { level: 2 })} className={btn(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        H2
      </button>
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" aria-pressed={editor.isActive("heading", { level: 3 })} className={btn(editor.isActive("heading", { level: 3 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        H3
      </button>
      <span className="mx-1 h-5 w-px bg-border" />
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" aria-pressed={editor.isActive("bulletList")} className={btn(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        • List
      </button>
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" aria-pressed={editor.isActive("orderedList")} className={btn(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1. List
      </button>
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" aria-pressed={editor.isActive("blockquote")} className={btn(editor.isActive("blockquote"))} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        &ldquo; Quote
      </button>
      <span className="mx-1 h-5 w-px bg-border" />
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" aria-pressed={editor.isActive("link")} className={btn(editor.isActive("link"))} onClick={setLink}>
        Link
      </button>
      <span className="mx-1 h-5 w-px bg-border" />
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" className={btn(false)} onClick={() => editor.chain().focus().undo().run()}>
        Undo
      </button>
      {/* eslint-disable-next-line no-restricted-syntax -- editor toolbar toggle, active state applied via btn() helper */}
      <button type="button" className={btn(false)} onClick={() => editor.chain().focus().redo().run()}>
        Redo
      </button>
    </div>
  );
}

/** Minimal styling for the contentEditable area so the WYSIWYG roughly mirrors email output. */
function EditorStyles() {
  return (
    <style>{`
      /* The editing surface mirrors the light email output and stays light in
         both app themes, so the dark body text always has a readable background. */
      .tt-content { min-height: 16rem; padding: 12px 14px; font-size: 14px; line-height: 1.6; color: #1e293b; background: #ffffff; outline: none; }
      .tt-content:focus { outline: none; }
      .tt-content p { margin: 0 0 10px; }
      .tt-content h2 { font-size: 18px; font-weight: 600; margin: 16px 0 8px; }
      .tt-content h3 { font-size: 16px; font-weight: 600; margin: 14px 0 6px; }
      .tt-content ul { list-style: disc; padding-left: 1.4rem; margin: 0 0 10px; }
      .tt-content ol { list-style: decimal; padding-left: 1.4rem; margin: 0 0 10px; }
      .tt-content li { margin: 0 0 4px; }
      .tt-content a { color: #00356b; text-decoration: underline; }
      .tt-content blockquote { border-left: 3px solid #cbd5e1; padding-left: 12px; color: #475569; margin: 0 0 10px; }
      .tt-content p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: #94a3b8; float: left; height: 0; pointer-events: none; }
    `}</style>
  );
}
