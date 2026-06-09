"use client";

import { useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { renderTemplate } from "@/platform/email/render/render";
import type { VariableDef } from "@/platform/email/templates/types";

type Mode = "rich" | "source";

export function TemplateEditor(props: {
  templateKey?: string;
  variables: VariableDef[];
  initialSubject: string;
  initialBody: string;
  isLayout: boolean;
  layoutSource: string;
}) {
  const [subject, setSubject] = useState(props.initialSubject);
  const [body, setBody] = useState(props.initialBody);
  const [mode, setMode] = useState<Mode>("rich");
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
      attributes: { class: "tt-content" },
    },
    onUpdate: ({ editor }) => setBody(editor.getHTML()),
  });

  // Sample context: each variable mapped to its sample value, for the live preview.
  const sample = useMemo(() => {
    const ctx: Record<string, unknown> = {};
    for (const v of props.variables) ctx[v.name] = v.sampleValue;
    return ctx;
  }, [props.variables]);

  const previewSubject = renderTemplate(subject, sample);
  // For a normal template, wrap the rendered body inside the (effective) layout.
  // For the layout template itself, the body IS the layout — render it directly.
  const previewDoc = props.isLayout
    ? renderTemplate(body, sample)
    : renderTemplate(props.layoutSource, {
        ...sample,
        subject: previewSubject,
        body: renderTemplate(body, sample),
      });

  function switchMode(next: Mode) {
    if (next === mode) return;
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
        <label className="block text-sm font-medium text-slate-700">Subject</label>
        <input
          name="subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. Welcome to HAVEN!"
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
        />

        <div className="mt-4 flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Message body</label>
          <div className="inline-flex overflow-hidden rounded border border-slate-200 text-xs">
            <button
              type="button"
              onClick={() => switchMode("rich")}
              className={`px-2 py-1 ${mode === "rich" ? "bg-slate-800 text-white" : "bg-white text-slate-600"}`}
            >
              Formatted
            </button>
            <button
              type="button"
              onClick={() => switchMode("source")}
              className={`px-2 py-1 ${mode === "source" ? "bg-slate-800 text-white" : "bg-white text-slate-600"}`}
            >
              HTML
            </button>
          </div>
        </div>

        {mode === "rich" ? (
          <div className="mt-1 rounded border border-slate-200">
            <Toolbar editor={editor} />
            <EditorContent editor={editor} />
          </div>
        ) : (
          <textarea
            ref={sourceRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={16}
            placeholder="<p>Your message…</p>"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
          />
        )}

        {/* The body posts via this hidden field, kept in sync with state. */}
        <input type="hidden" name="body" value={body} />

        {props.variables.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-medium text-slate-500">Insert a variable:</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {props.variables.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  title={v.label}
                  onClick={() => insertToken(`{{ ${v.name} }}`)}
                  className="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700 hover:bg-slate-100"
                >
                  {`{{ ${v.name} }}`}
                </button>
              ))}
              <button
                type="button"
                title="Conditional block — shows the inner content only when the variable has a value"
                onClick={() => insertToken("{{#if VARIABLE}}\n\n{{/if}}")}
                className="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700 hover:bg-slate-100"
              >
                {`{{#if}}…{{/if}}`}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Conditionals only work in HTML mode. Switch to HTML to edit them precisely.
            </p>
          </div>
        )}
      </div>

      {/* Preview column */}
      <div>
        <div className="text-sm font-medium text-slate-700">Preview (with sample data)</div>
        <div className="mt-1 rounded border border-slate-200 bg-slate-50 px-3 py-1 text-sm">
          <span className="text-slate-400">Subject:&nbsp;</span>
          <strong>{previewSubject}</strong>
        </div>
        <iframe
          title="preview"
          sandbox="allow-same-origin"
          className="mt-2 h-[34rem] w-full rounded border border-slate-200 bg-white"
          srcDoc={previewDoc}
        />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return <div className="h-9 border-b border-slate-200" />;

  const btn = (active: boolean) =>
    `rounded px-2 py-1 text-sm ${active ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`;

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
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 p-1">
      <button type="button" className={btn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>
        <strong>B</strong>
      </button>
      <button type="button" className={btn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <em>I</em>
      </button>
      <span className="mx-1 h-5 w-px bg-slate-200" />
      <button type="button" className={btn(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        H2
      </button>
      <button type="button" className={btn(editor.isActive("heading", { level: 3 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        H3
      </button>
      <span className="mx-1 h-5 w-px bg-slate-200" />
      <button type="button" className={btn(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        • List
      </button>
      <button type="button" className={btn(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1. List
      </button>
      <button type="button" className={btn(editor.isActive("blockquote"))} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        &ldquo; Quote
      </button>
      <span className="mx-1 h-5 w-px bg-slate-200" />
      <button type="button" className={btn(editor.isActive("link"))} onClick={setLink}>
        Link
      </button>
      <span className="mx-1 h-5 w-px bg-slate-200" />
      <button type="button" className={btn(false)} onClick={() => editor.chain().focus().undo().run()}>
        Undo
      </button>
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
      .tt-content { min-height: 16rem; padding: 12px 14px; font-size: 14px; line-height: 1.6; color: #1e293b; outline: none; }
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
