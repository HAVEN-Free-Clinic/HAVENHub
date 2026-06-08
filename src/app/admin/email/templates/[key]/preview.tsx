"use client";
import { useMemo, useState } from "react";
import { renderTemplate } from "@/platform/email/render/render";
import type { VariableDef } from "@/platform/email/templates/types";

export function TemplateEditor(props: {
  templateKey: string;
  variables: VariableDef[];
  initialSubject: string;
  initialBody: string;
}) {
  const [subject, setSubject] = useState(props.initialSubject);
  const [body, setBody] = useState(props.initialBody);

  const sample = useMemo(() => {
    const ctx: Record<string, unknown> = {};
    for (const v of props.variables) ctx[v.name] = v.sampleValue;
    return ctx;
  }, [props.variables]);

  const previewSubject = renderTemplate(subject, sample);
  const previewHtml = renderTemplate(body, sample);

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="block text-sm font-medium text-slate-700">Subject</label>
        <input
          name="subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="mt-1 w-full rounded border border-slate-200 px-3 py-2 text-sm"
        />
        <label className="mt-3 block text-sm font-medium text-slate-700">Body (HTML)</label>
        <textarea
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={18}
          className="mt-1 w-full rounded border border-slate-200 px-3 py-2 font-mono text-xs"
        />
        {props.variables.length > 0 && (
          <div className="mt-2 text-xs text-slate-500">
            Variables: {props.variables.map((v) => `{{ ${v.name} }}`).join(", ")}
          </div>
        )}
      </div>
      <div>
        <div className="text-sm font-medium text-slate-700">Preview (sample data)</div>
        <div className="mt-1 border-b py-1 text-sm">
          <strong>{previewSubject}</strong>
        </div>
        <iframe
          title="preview"
          sandbox="allow-same-origin"
          className="mt-2 h-[28rem] w-full rounded border border-slate-200"
          srcDoc={previewHtml}
        />
      </div>
    </div>
  );
}
