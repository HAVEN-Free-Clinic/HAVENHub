import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

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
  { ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**"] },
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
  // will need a scoped exception here — do not pre-add it.)
  {
    files: ["src/platform/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/modules/**", "@/modules/**"],
              message: "Platform code must not import module code.",
            },
          ],
        },
      ],
    },
  },

  // Resolved-path enforcement (catches relative-path evasion the specifier
  // globs above miss, e.g. `../my-info/internal` from inside a module).
  // eslint-config-next already registers the `import` plugin instance globally,
  // so we must NOT redeclare plugins here — just add the rule + settings.
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
