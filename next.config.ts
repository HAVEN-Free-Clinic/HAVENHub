import type { NextConfig } from "next";
import { withPostHogConfig } from "@posthog/nextjs-config";

/**
 * Refs whose builds upload source maps to PostHog Error Tracking. These are
 * exactly the two Vercel builds itself (see `ignoreCommand` in vercel.json):
 * `main` -> hub.havenfreeclinic.org, `staging` -> staging.havenfreeclinic.org.
 * PR previews are built by .github/workflows/neon-preview.yml and are left out
 * on purpose -- every preview would otherwise mint its own release and symbol
 * set for a URL nobody triages errors from.
 */
const UPLOAD_REFS = ["main", "staging"];

const ref = process.env.VERCEL_GIT_COMMIT_REF ?? "";
const isUploadRef = UPLOAD_REFS.includes(ref);
// The key is required to be present, not just expected: `resolveConfig` throws
// "personalApiKey is required when sourcemaps are enabled" while next.config is
// being loaded, which would fail the deploy outright rather than skip the
// upload. Gating on the key keeps a missing/rotated secret from taking
// production down, at the cost of failing quietly -- hence the warning below.
const uploadSourcemaps = isUploadRef && Boolean(process.env.POSTHOG_API_KEY);

if (isUploadRef && !uploadSourcemaps) {
  console.warn(
    `[posthog] POSTHOG_API_KEY is not set for the "${ref}" build; skipping source map upload. ` +
      `Stack traces from this deploy will stay minified in Error Tracking.`,
  );
}

/**
 * Refuse to start a dev server against a database that is not local.
 *
 * `.env` holds the production Neon URL, because the deploy and import scripts
 * need it, and Next does not override variables that are already set. So the
 * bare `next dev` ran the whole app against production: every page load mutated
 * live clinic data, and paid a ~49ms round trip per query instead of ~3ms.
 * `npm run dev` now names the local database explicitly; this is the backstop
 * for the paths that do not go through it.
 *
 * Deliberately scoped to `next dev`. Builds are the case where a remote database
 * is correct: Vercel, the preview workflow, and a local `next build` all set
 * NODE_ENV=production and must not be blocked.
 *
 * Same shape and same escape-hatch convention as the guards in
 * playwright.config.ts (E2E_ALLOW_REMOTE_DB) and prisma/seed.ts (ALLOW_PROD_SEED).
 */
function assertLocalDevDatabase(): void {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.ALLOW_REMOTE_DEV_DB === "1") return;
  const url = process.env.DATABASE_URL;
  if (!url) return; // config.ts reports a missing URL far better than this can.

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return; // Not parseable, so not provably remote. config.ts will complain.
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return;

  throw new Error(
    `Refusing to start a dev server against a non-local database (host: "${hostname}").\n` +
      `Every request would read and write real clinic data.\n\n` +
      `  npm run dev          use the local database (set it up once with \`npm run db:setup\`)\n` +
      `  npm run dev:remote   connect to this database on purpose\n`,
  );
}

assertLocalDevDatabase();

const nextConfig: NextConfig = {
  output: "standalone",
  /**
   * Files the build must ship that static tracing cannot discover on its own.
   *
   * `@img/**` is sharp's native payload, and it is here because sharp is split
   * across two packages. The binding (`@img/sharp-<platform>/lib/*.node`) is
   * require'd, so tracing finds it. The 17MB shared library it dlopens lives in
   * the sibling `@img/sharp-libvips-<platform>`, whose entry point is literally
   * `module.exports = __dirname`: the library is located by path at runtime and
   * referenced by no import anywhere, so tracing ships the binding, drops the
   * library, and the function dies on first use with
   * "ERR_DLOPEN_FAILED: libvips-cpp.so.<version>: cannot open shared object file".
   *
   * Scoped to `sharp-libvips-*` rather than all of `@img/**` because that is the
   * only genuine gap: the binding traces correctly on its own (verified by
   * inspecting a build without this entry). npm installs only the current
   * platform's optional packages, so this expands to one directory, not every
   * architecture.
   *
   * Note for anyone here about bundle size: `@img/sharp-wasm32` is roughly 9MB
   * and ships regardless of this entry, because sharp's own loader references it
   * as a fallback and tracing follows that. Narrowing this glob does not remove
   * it; that would need a different lever.
   *
   * Nothing in the test suite can catch a regression here, because tracing only
   * happens at build time and `npm test` runs against an intact node_modules. To
   * verify a change, run `next build` and confirm the library is present:
   *   find .next/standalone -name "libvips-cpp*"
   */
  outputFileTracingIncludes: {
    "*": [
      "./node_modules/.prisma/client/**",
      "./node_modules/@img/sharp-libvips-*/**",
    ],
  },
  experimental: {
    serverActions: {
      // The platform hard-limits a Server Action request body to ~4.5 MB
      // (FUNCTION_PAYLOAD_TOO_LARGE) and answers a larger POST at the edge,
      // before any app code runs. This ceiling must not promise more than the
      // platform delivers: the old "25mb" claimed ~5x what an upload could ever
      // reach, so a file the config accepted still died opaquely at the edge.
      // Kept just above uploads.maxMb (capped at 4) so the app-level cap is what
      // rejects an oversized upload, with a real message (#75).
      bodySizeLimit: "5mb",
    },
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

/**
 * Wraps the config so `next build` generates browser source maps, uploads them
 * to Error Tracking, then deletes them. Without this, every client stack frame
 * arrives as a minified name in an anonymous chunk ("Could not find sourcemap
 * for source url"), and server frames as single letters, which is as far as any
 * client-side issue can currently be triaged.
 *
 * Turbopack (the Next 16 default) is driven through the `runAfterProductionCompile`
 * compiler hook rather than a webpack plugin; the package picks the right path
 * itself. It must stay the OUTERMOST wrapper -- another wrapper around it would
 * flatten the config to a plain object and silently drop these build hooks.
 */
export default withPostHogConfig(nextConfig, {
  personalApiKey: process.env.POSTHOG_API_KEY!,
  projectId: "514029",
  sourcemaps: {
    enabled: uploadSourcemaps,
    // Ties each stack trace back to the commit that produced it. Vercel builds
    // from a tarball without full git metadata, so the CLI cannot infer this.
    releaseVersion: process.env.VERCEL_GIT_COMMIT_SHA,
    // Source maps reconstruct the original source, including the RBAC checks and
    // query shapes behind PHI. They must never be served: uploaded, then deleted
    // from the build output before it ships.
    deleteAfterUpload: true,
  },
});
