import type { TemplateDescriptor } from "./types";

// Passthrough by default: Phase 1 changes no existing email output.
// Admins can later edit this to add a HAVEN header/footer around {{{ body }}}.
export const layoutDescriptor: TemplateDescriptor = {
  key: "layout",
  name: "Shared layout wrapper",
  category: "layout",
  variables: [
    { name: "body", label: "Rendered email body (HTML)", sampleValue: "<p>Body goes here.</p>" },
    { name: "subject", label: "Email subject", sampleValue: "Subject line" },
  ],
  defaultSubject: "{{ subject }}",
  defaultBody: "{{{ body }}}",
};
