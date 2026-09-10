import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const noEmDash = {
  meta: { type: "problem", docs: { description: "Ban the em-dash character; it reads as AI-generated." }, schema: [] },
  create(context) {
    const src = context.sourceCode ?? context.getSourceCode();
    return {
      Program(node) {
        const text = src.getText();
        // The character AND the HTML entity. Scanning for the character alone
        // let `&mdash;` through, and six absent-value markers in the schedule
        // module drifted in that way: the rule was passing while the rendered
        // page showed exactly what it bans.
        for (const form of ["—", "&mdash;"]) {
          for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) {
            context.report({
              node,
              loc: src.getLocFromIndex(i),
              message:
                "Em-dash reads as AI-generated; use a comma, colon, parentheses, or hyphen. For an absent value use \"-\", which the date helpers already default to. Add an eslint-disable-next-line local/no-em-dash with a reason if genuinely required.",
            });
          }
        }
      },
    };
  },
};

// Keep ad-hoc empty states from drifting back. Before the EmptyState primitive
// the app had 78 of them drawn in four different neutral tokens, because the
// pattern was doc-covered rather than lint-covered (exactly how the surfaces
// convention drifted in cohesion Phase 2). A selector cannot see JSX text
// content, so this walks the element instead of using no-restricted-syntax.
const NEUTRAL_TOKENS = ["text-subtle-foreground", "text-muted-foreground", "text-foreground-soft"];
const noAdhocEmptyState = {
  meta: {
    type: "problem",
    docs: { description: "Use the EmptyState primitive instead of a hand-rolled empty-state paragraph." },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        if (node.openingElement.name?.name !== "p") return;

        const className = node.openingElement.attributes.find(
          (a) => a.type === "JSXAttribute" && a.name?.name === "className",
        );
        const classes = className?.value?.type === "Literal" ? String(className.value.value) : "";
        if (!NEUTRAL_TOKENS.some((t) => classes.split(/\s+/).includes(t))) return;

        const text = node.children
          .filter((c) => c.type === "JSXText")
          .map((c) => c.value)
          .join("")
          .trim();
        // \b keeps this off labels like "Note from the old scheduler:".
        if (!/^(No|Nothing|None|Nobody)\b/.test(text)) return;

        context.report({
          node,
          message:
            "Hand-rolled empty state. Use <EmptyState> from @/platform/ui/empty-state so the neutral token and spacing stay canonical: `inline` for a table cell or tight section, the default block for an empty page or card body. Add an eslint-disable-next-line local/no-adhoc-empty-state with a reason if this is genuinely not an empty state.",
        });
      },
    };
  },
};

// One ellipsis character in user-visible copy, not three dots. The SubmitButton
// primitive already defaults its pending label to "Saving\u2026", so every
// three-dot override contradicted the default it was overriding, and a search
// box using "..." sat beside one using "\u2026" on the same page.
//
// AST-scoped, unlike no-em-dash, which scans raw text. "..." is also spread
// syntax, so a raw-text scan would fire on every rest spread. Three shapes
// carry the copy: JSXText between tags (an <option> label), a JSXAttribute
// string literal (placeholder=, pendingLabel=, aria-label=), and a string
// inside a JSX expression container, which is where the in-flight ternaries
// live ({busy ? "Generating..." : "Generate PDF"}). Missing the third would
// have left about twenty pending labels three-dotted beside the swept ones.
//
// Deliberately blind to plain .ts and to non-JSX helpers: `{...rest}` is a
// JSXSpreadAttribute rather than an expression container, so no rest spread is
// reachable from here, but a truncation helper or a status string set in a
// handler is, and neither is safe to rewrite by rule.
const noAsciiEllipsis = {
  meta: {
    type: "problem",
    docs: { description: "Use the ellipsis character in user-visible copy, not three dots." },
    schema: [],
  },
  create(context) {
    const MESSAGE =
      "Use the \u2026 character, not three dots; the SubmitButton default is \"Saving\u2026\". Add an eslint-disable-next-line local/no-ascii-ellipsis with a reason if this is a truncation marker rather than copy.";
    // One visitor per node kind, walking UP to decide, rather than a descendant
    // selector: `JSXExpressionContainer Literal` also matches a plain
    // placeholder= inside any element rendered from a .map() callback, and
    // reported every one of those twice.
    const insideJsx = (node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (p.type === "JSXAttribute" || p.type === "JSXExpressionContainer") return true;
      }
      return false;
    };
    return {
      JSXText(node) {
        if (node.value.includes("...")) context.report({ node, message: MESSAGE });
      },
      Literal(node) {
        if (typeof node.value !== "string" || !node.value.includes("...")) return;
        if (insideJsx(node)) context.report({ node, message: MESSAGE });
      },
      TemplateElement(node) {
        if (!node.value.raw.includes("...")) return;
        if (insideJsx(node)) context.report({ node, message: MESSAGE });
      },
    };
  },
};

const MODULE_IDS = [
  "schedule",
  "my-info",
  "volunteers",
  "admin",
  "recruitment",
  "triage",
  "referrals",
  "patient-trackers",
];

const eslintConfig = [
  ...coreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      ".claude/**",
      // Gitignored local design-system scratch. It is not part of the app and
      // does not exist in a CI checkout, but `eslint .` walks it anyway (flat
      // config does not read .gitignore), reporting ~20 errors that can never
      // be fixed by this repo. That noise makes the whole-repo `npm run lint`
      // in pre-push easy to ignore, which is the opposite of what it is for.
      "HAVEN Free Clinic Design System/**",
      ".superpowers/**",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Spec §4.3: modules may import platform; modules never import each other.
  ...MODULE_IDS.map((id) => ({
    files: [`src/modules/${id}/**/*.{ts,tsx}`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: MODULE_IDS.filter((other) => other !== id).map((other) => ({
            group: [`**/modules/${other}/**`, `@/modules/${other}/**`],
            message: `Module "${id}" may not import module "${other}". Go through src/platform.`,
          })),
        },
      ],
    },
  })),
  // Platform must not depend on any module's internals. (When module manifests
  // move into src/modules/<id>/manifest.ts in later plans, the registry import
  // will need a scoped exception here; do not pre-add it.)
  // Group is deliberately narrow: "**/modules/**" would false-positive on
  // src/platform/modules/* (the registry). Relative-path evasions are caught
  // by the resolved-path zones below.
  {
    files: ["src/platform/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/modules/**", "src/modules/**"],
              message: "Platform code must not import module code.",
            },
          ],
        },
      ],
    },
  },

  // Spec §5: no styled raw controls -- use platform/ui primitives.
  //
  // src/platform is in scope too, minus src/platform/ui, which IS the primitives.
  // Leaving the rest of platform out was a real hole: platform/auth/inactivity.tsx
  // hand-rolled a styled button with NO focus style at all, and it is the button
  // that keeps a member from being signed out mid-form. A rule that stops at
  // app/modules cannot see a component just because of where it lives.
  {
    files: ["src/app/**/*.tsx", "src/modules/**/*.tsx", "src/platform/**/*.tsx"],
    ignores: ["src/platform/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.name=/^(button|input|select|textarea)$/] > JSXAttribute[name.name='className']",
          message:
            "Use the shared UI primitives (Button/Input/Select/Textarea/Checkbox/Radio from @/platform/ui) instead of a styled raw control. If a raw element is genuinely required, add an eslint-disable-next-line no-restricted-syntax with a one-line reason. See docs/ui-house-style.md.",
        },
      ],
    },
  },

  // Ban the em-dash character (U+2014) in all src files. Catches it in comments
  // AND strings because the rule scans raw source text, not the AST.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      local: {
        rules: {
          "no-em-dash": noEmDash,
          "no-adhoc-empty-state": noAdhocEmptyState,
          "no-ascii-ellipsis": noAsciiEllipsis,
        },
      },
    },
    rules: { "local/no-em-dash": "error" },
  },

  // Empty states must go through the primitive. Scoped to app/modules the same
  // way the raw-control rule is: src/platform/ui is where EmptyState lives.
  {
    files: ["src/app/**/*.tsx", "src/modules/**/*.tsx"],
    rules: { "local/no-adhoc-empty-state": "error" },
  },

  // Ellipsis character, not three dots. tsx only: the rule is AST-scoped to JSX
  // nodes, so it has nothing to say about a plain .ts file. The handful of
  // user-visible strings that live in .ts (platform/posthog's reload copy) are
  // therefore outside its reach and are held by review, not lint.
  {
    files: ["src/**/*.tsx"],
    rules: { "local/no-ascii-ellipsis": "error" },
  },

  // Resolved-path enforcement (catches relative-path evasion the specifier
  // globs above miss, e.g. `../my-info/internal` from inside a module).
  // eslint-config-next already registers the `import` plugin instance globally,
  // so we must NOT redeclare plugins here; just add the rule + settings.
  {
    files: ["src/**/*.{ts,tsx}"],
    settings: {
      "import/resolver": { typescript: true, node: true },
    },
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            ...MODULE_IDS.map((id) => ({
              target: `./src/modules/${id}`,
              from: `./src/modules`,
              except: [`./${id}`],
              message: `Modules may not import other modules. Go through src/platform.`,
            })),
            {
              target: "./src/platform",
              from: "./src/modules",
              message: "Platform code must not import module code.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
