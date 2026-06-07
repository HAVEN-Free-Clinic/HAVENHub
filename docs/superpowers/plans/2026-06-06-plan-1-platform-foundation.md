# Plan 1: Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running HAVENHub shell: sign in (Entra ID in prod, dev login locally), get matched to a Person record, land on a permission-gated hub of module tiles — with the RBAC engine, core schema, audit log, module registry, lint-enforced boundaries, and CI all in place.

**Architecture:** Modular monolith per the spec (`docs/superpowers/specs/2026-06-06-havenhub-platform-design.md`). One Next.js 16 App Router app; platform code in `src/platform/`, future modules in `src/modules/` (placeholder manifests only in this plan); Postgres 16 via Docker Compose; Prisma migrations from day one. No custom server, no worker yet (worker arrives in Plan 2 with the Airtable mirror).

**Tech Stack:** TypeScript, Next.js 16.2.x, React 19.2.x, NextAuth v5 (beta), Prisma 6.19.x, Postgres 16, Tailwind CSS v4, Vitest 4, Playwright, zod.

**Reference code:** the analyzed clones at `/tmp/haven-analysis/haven-triage` (auth pattern, compose) and `/tmp/haven-analysis/HAVEN-scheduler` (ported later) — if missing, re-clone from `github.com/jcarney2024/<name>`.

---

## File structure (end state of this plan)

```
.github/workflows/ci.yml         # lint + typecheck + tests on PR/main
docker-compose.yml               # postgres only (app/worker containers come later)
.env.example / .env              # documented config
package.json, tsconfig.json, next.config.ts, postcss.config.mjs,
eslint.config.mjs, vitest.config.ts, vitest.setup.ts, playwright.config.ts
prisma/
  schema.prisma                  # Person, Term, Department, TermMembership,
                                 # Role, RoleGrant, RoleAssignment, AuditLog
  seed.ts                        # dev departments, system roles, SU26 term, dev people
src/
  platform/
    config.ts                    # zod-validated env, fails boot loudly
    db.ts                        # Prisma client singleton
    auth/
      auth.ts                    # NextAuth: Entra + dev credentials
      match-person.ts            # login → Person resolution (the 4-step order)
      session.ts                 # requirePersonSession / requirePermission
    rbac/engine.ts               # getEffectivePermissions / can
    audit.ts                     # recordAudit
    modules/
      types.ts                   # ModuleManifest
      registry.ts                # MODULES — single wiring point
    test/db.ts                   # resetDb truncation helper for tests
    ui/app-shell.tsx             # header: brand, user name, sign out
  modules/                       # (empty dirs reserved; manifests live in registry for now)
  app/
    layout.tsx, globals.css
    page.tsx                     # redirect → /hub or /login
    login/page.tsx               # "Sign in with Yale" + dev login form
    welcome/page.tsx             # signed in but not in our records
    hub/page.tsx                 # permission-gated tiles
    api/auth/[...nextauth]/route.ts
    api/health/route.ts
  types/next-auth.d.ts           # session/JWT augmentation
e2e/login.spec.ts                # Playwright: dev login → hub
```

Colocated unit/integration tests as `*.test.ts` next to sources.

---

### Task 0: Prerequisites

- [ ] **Step 1: Verify toolchain**

Run: `node --version && docker --version && docker compose version`
Expected: Node ≥ 20, Docker and Compose present. If Node < 20, install Node 22 LTS first.

---

### Task 1: Scaffold the Next.js app

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `.gitignore`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`

We hand-write the scaffold (no `create-next-app` — it refuses non-empty directories and we want pinned, known-good versions from haven-triage).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "havenhub",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:prepare": "docker compose exec -T postgres psql -U haven -d havenhub -c \"CREATE DATABASE havenhub_test\" || true && DATABASE_URL=postgresql://haven:haven_dev@localhost:5433/havenhub_test npx prisma migrate deploy",
    "db:up": "docker compose up -d postgres",
    "db:migrate": "prisma migrate dev",
    "db:seed": "prisma db seed",
    "e2e": "playwright test"
  },
  "prisma": {
    "seed": "npx tsx prisma/seed.ts"
  },
  "dependencies": {
    "@prisma/client": "^6.19.2",
    "lucide-react": "^0.487.0",
    "next": "16.2.1",
    "next-auth": "^5.0.0-beta.30",
    "prisma": "^6.19.2",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@eslint/eslintrc": "^3.3.0",
    "@playwright/test": "^1.56.0",
    "@tailwindcss/postcss": "^4",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.2.1",
    "tailwindcss": "^4",
    "tsx": "^4.21.0",
    "typescript": "^5",
    "vitest": "^4.1.2"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Write `next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

- [ ] **Step 4: Write `postcss.config.mjs`**

```js
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
```

- [ ] **Step 5: Write `eslint.config.mjs`** (boundary rules get added in Task 13; start with the Next presets)

```js
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**"] },
];

export default eslintConfig;
```

- [ ] **Step 6: Write `.gitignore`**

```
node_modules/
.next/
.env
*.tsbuildinfo
next-env.d.ts
playwright-report/
test-results/
```

- [ ] **Step 7: Write `src/app/globals.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 8: Write `src/app/layout.tsx`**

```tsx
import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "HAVENHub",
  description: "HAVEN Free Clinic — unified platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 9: Write placeholder `src/app/page.tsx`** (replaced in Task 7)

```tsx
export default function Home() {
  return <main className="p-8">HAVENHub — under construction</main>;
}
```

- [ ] **Step 10: Install and verify boot**

Run: `npm install && npm run dev`
Expected: dev server starts; `http://localhost:3000` shows "HAVENHub — under construction". Stop the server.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 16 app skeleton"
```

---

### Task 2: Vitest setup

**Files:**
- Create: `vitest.config.ts`, `vitest.setup.ts`

- [ ] **Step 1: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    pool: "forks",
    fileParallelism: false, // integration tests share one test database
  },
});
```

- [ ] **Step 2: Write `vitest.setup.ts`**

```ts
// Tests run against a dedicated test database, never the dev one.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://haven:haven_dev@localhost:5433/havenhub_test";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
```

- [ ] **Step 3: Verify the runner works**

Run: `npm test`
Expected: "No test files found" (exit code 0 or a clear no-tests message — either is fine at this point).

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts vitest.setup.ts
git commit -m "chore: add vitest with test-database isolation"
```

---

### Task 3: Postgres compose, env files, validated config

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `.env`, `src/platform/config.ts`
- Test: `src/platform/config.test.ts`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: haven
      POSTGRES_PASSWORD: haven_dev
      POSTGRES_DB: havenhub
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U haven -d havenhub"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

(Port 5433 on the host to avoid colliding with any local Postgres — same convention haven-triage used.)

- [ ] **Step 2: Write `.env.example`** (every variable documented — this file is the contract)

```bash
# --- Database ---------------------------------------------------------------
# Local dev points at the compose postgres (host port 5433).
DATABASE_URL=postgresql://haven:haven_dev@localhost:5433/havenhub
# Used by `npm test` (vitest.setup.ts). Created by `npm run test:prepare`.
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5433/havenhub_test

# --- Auth -------------------------------------------------------------------
# Generate with: openssl rand -base64 32
AUTH_SECRET=change-me
# Microsoft Entra ID app registration (Yale tenant).
# OPTIONAL in development (dev credentials login works without them),
# REQUIRED in production — boot fails loudly if missing.
AZURE_AD_CLIENT_ID=
AZURE_AD_CLIENT_SECRET=
AZURE_AD_TENANT_ID=
```

- [ ] **Step 3: Create `.env`** — copy `.env.example`, set a real `AUTH_SECRET` (`openssl rand -base64 32`). Leave Azure vars blank for now.

- [ ] **Step 4: Write the failing config test** — `src/platform/config.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const base = {
  DATABASE_URL: "postgresql://x:y@localhost:5433/db",
  AUTH_SECRET: "secret",
  NODE_ENV: "development",
};

describe("loadConfig", () => {
  it("accepts a valid development env without Azure vars", () => {
    const config = loadConfig(base);
    expect(config.DATABASE_URL).toBe(base.DATABASE_URL);
  });

  it("fails loudly when DATABASE_URL is missing, naming the variable", () => {
    const { DATABASE_URL: _omitted, ...env } = base;
    expect(() => loadConfig(env)).toThrowError(/DATABASE_URL/);
  });

  it("requires Azure variables in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrowError(
      /AZURE_AD_CLIENT_ID/
    );
  });

  it("accepts production env when Azure variables are present", () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: "production",
      AZURE_AD_CLIENT_ID: "id",
      AZURE_AD_CLIENT_SECRET: "secret",
      AZURE_AD_TENANT_ID: "tenant",
    });
    expect(config.AZURE_AD_TENANT_ID).toBe("tenant");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm test -- src/platform/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 6: Write `src/platform/config.ts`**

```ts
import { z } from "zod";

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    AUTH_SECRET: z.string().min(1),
    AZURE_AD_CLIENT_ID: z.string().optional(),
    AZURE_AD_CLIENT_SECRET: z.string().optional(),
    AZURE_AD_TENANT_ID: z.string().optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    const required = [
      "AZURE_AD_CLIENT_ID",
      "AZURE_AD_CLIENT_SECRET",
      "AZURE_AD_TENANT_ID",
    ] as const;
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "required in production",
        });
      }
    }
  });

export type AppConfig = z.infer<typeof schema>;

/** Parse and validate env. Throws a readable error listing every problem. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const config = loadConfig();
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- src/platform/config.test.ts`
Expected: 4 passed.

- [ ] **Step 8: Start the database**

Run: `npm run db:up && docker compose ps`
Expected: `postgres` service healthy.

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml .env.example src/platform/config.ts src/platform/config.test.ts
git commit -m "feat: postgres compose + boot-validated env config"
```

---

### Task 4: Prisma schema, migration, client, test database

**Files:**
- Create: `prisma/schema.prisma`, `src/platform/db.ts`, `src/platform/test/db.ts`

- [ ] **Step 1: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum PersonStatus {
  ACTIVE
  OFFBOARDED
}

enum TermStatus {
  PLANNING
  ACTIVE
  ARCHIVED
}

enum MembershipKind {
  DIRECTOR
  VOLUNTEER
}

enum MembershipStatus {
  ACTIVE
  REMOVED
}

model Person {
  id               String        @id @default(cuid())
  netId            String?       @unique
  entraObjectId    String?       @unique
  name             String
  contactEmail     String?       @unique
  yaleEmail        String?       @unique
  phone            String?
  epicId           String?
  yaleAffiliation  String?
  gradYear         String?
  status           PersonStatus  @default(ACTIVE)
  airtableRecordId String?       @unique
  memberships      TermMembership[]
  roleAssignments  RoleAssignment[]
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt
}

model Term {
  id              String     @id @default(cuid())
  code            String     @unique // "SU26", "FA26"
  name            String // "Summer 2026"
  startDate       DateTime
  endDate         DateTime
  status          TermStatus @default(PLANNING)
  clinicDates     DateTime[]
  memberships     TermMembership[]
  roleAssignments RoleAssignment[]
}

model Department {
  id              String  @id @default(cuid())
  code            String  @unique // "ITCM", "EXEC", "SRR", ...
  name            String
  isActive        Boolean @default(true)
  memberships     TermMembership[]
  roleAssignments RoleAssignment[]
}

model TermMembership {
  id                         String           @id @default(cuid())
  personId                   String
  termId                     String
  departmentId               String
  kind                       MembershipKind
  status                     MembershipStatus @default(ACTIVE)
  baselineAvailability       DateTime[]
  selfUpdatedAvailability    String?
  availabilityUpdatedAt      DateTime?
  availabilityAcknowledgedAt DateTime?
  person                     Person           @relation(fields: [personId], references: [id])
  term                       Term             @relation(fields: [termId], references: [id])
  department                 Department       @relation(fields: [departmentId], references: [id])

  @@unique([personId, termId, departmentId, kind])
  @@index([termId, departmentId])
}

model Role {
  id          String  @id @default(cuid())
  name        String  @unique
  description String?
  isSystem    Boolean @default(false)
  grants      RoleGrant[]
  assignments RoleAssignment[]
}

model RoleGrant {
  id         String @id @default(cuid())
  roleId     String
  permission String // e.g. "schedule.edit_all" or "*"
  role       Role   @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@unique([roleId, permission])
}

/// Exactly one of personId / departmentId is set. termId null = global scope.
model RoleAssignment {
  id           String      @id @default(cuid())
  roleId       String
  personId     String?
  departmentId String?
  termId       String?
  role         Role        @relation(fields: [roleId], references: [id], onDelete: Cascade)
  person       Person?     @relation(fields: [personId], references: [id])
  department   Department? @relation(fields: [departmentId], references: [id])
  term         Term?       @relation(fields: [termId], references: [id])

  @@index([personId])
  @@index([departmentId])
}

model AuditLog {
  id            String   @id @default(cuid())
  actorPersonId String?
  action        String // e.g. "person.update", "auth.login_unmatched"
  entityType    String
  entityId      String?
  before        Json?
  after         Json?
  ip            String?
  createdAt     DateTime @default(now())

  @@index([entityType, entityId])
  @@index([createdAt])
}
```

- [ ] **Step 2: Create the migration**

Run: `npx prisma migrate dev --name platform-core`
Expected: migration created and applied; Prisma Client generated.

- [ ] **Step 3: Write `src/platform/db.ts`**

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

- [ ] **Step 4: Write `src/platform/test/db.ts`** (integration-test reset helper)

```ts
import { prisma } from "@/platform/db";

/** Truncate all platform tables between tests. Test database only. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "RoleAssignment", "RoleGrant", "Role", "TermMembership",
              "Department", "Term", "Person", "AuditLog"
     RESTART IDENTITY CASCADE`
  );
}
```

- [ ] **Step 5: Create and migrate the test database**

Run: `npm run test:prepare`
Expected: `CREATE DATABASE` (or "already exists" error swallowed by `|| true`), then migrations applied to `havenhub_test`.

- [ ] **Step 6: Commit**

```bash
git add prisma/ src/platform/db.ts src/platform/test/db.ts
git commit -m "feat: platform core schema (Person/Term/Department/RBAC/Audit)"
```

---

### Task 5: Seed script

**Files:**
- Create: `prisma/seed.ts`

Dev-fixture data only — Plan 2's Airtable importer supersedes it for real data. Idempotent (upserts) so it can run repeatedly.

- [ ] **Step 1: Write `prisma/seed.ts`**

```ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEPARTMENTS = [
  { code: "EXEC", name: "Executive Directors" },
  { code: "ITCM", name: "IT & Compliance Management" },
  { code: "SRR", name: "Staff Recruitment & Retention" },
  { code: "VADM", name: "Volunteer Administration" },
  { code: "VADC", name: "Volunteer Administration Directors" },
  { code: "PATS", name: "Patient Services" },
];

// Director/Volunteer are auto-attached by the RBAC engine via TermMembership.kind.
const SYSTEM_ROLES: Array<{ name: string; description: string; grants: string[] }> = [
  {
    name: "Platform Admin",
    description: "Full access to every module and admin function",
    grants: ["*"],
  },
  {
    name: "Director",
    description: "Baseline access for current-term directors",
    grants: ["schedule.view", "schedule.edit_own_dept", "volunteers.view", "my-info.access"],
  },
  {
    name: "Volunteer",
    description: "Baseline access for current-term volunteers",
    grants: ["schedule.view", "my-info.access"],
  },
];

/** Every Saturday from start to end, inclusive. */
function saturdays(startIso: string, endIso: string): Date[] {
  const out: Date[] = [];
  const end = new Date(endIso);
  for (let d = new Date(startIso); d <= end; d = new Date(d.getTime() + 7 * 86400000)) {
    out.push(new Date(d));
  }
  return out;
}

async function main() {
  for (const dept of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { code: dept.code },
      update: { name: dept.name },
      create: dept,
    });
  }

  for (const role of SYSTEM_ROLES) {
    const created = await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description, isSystem: true },
      create: { name: role.name, description: role.description, isSystem: true },
    });
    for (const permission of role.grants) {
      await prisma.roleGrant.upsert({
        where: { roleId_permission: { roleId: created.id, permission } },
        update: {},
        create: { roleId: created.id, permission },
      });
    }
  }

  const su26 = await prisma.term.upsert({
    where: { code: "SU26" },
    update: { status: "ACTIVE" },
    create: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-30"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
      clinicDates: saturdays("2026-05-30", "2026-09-26"), // 18 Saturdays
    },
  });

  const itcm = await prisma.department.findUniqueOrThrow({ where: { code: "ITCM" } });
  const vadm = await prisma.department.findUniqueOrThrow({ where: { code: "VADM" } });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: "Platform Admin" } });

  // Dev people: a platform admin (your real email so Entra login also matches),
  // a director, and a volunteer.
  const jack = await prisma.person.upsert({
    where: { contactEmail: "j.carney@yale.edu" },
    update: {},
    create: { name: "Jack Carney", contactEmail: "j.carney@yale.edu", yaleEmail: "j.carney@yale.edu" },
  });
  const director = await prisma.person.upsert({
    where: { contactEmail: "dev.director@yale.edu" },
    update: {},
    create: { name: "Dev Director", contactEmail: "dev.director@yale.edu", netId: "dd123" },
  });
  const volunteer = await prisma.person.upsert({
    where: { contactEmail: "dev.volunteer@yale.edu" },
    update: {},
    create: { name: "Dev Volunteer", contactEmail: "dev.volunteer@yale.edu", netId: "dv456" },
  });

  const membership = (personId: string, departmentId: string, kind: "DIRECTOR" | "VOLUNTEER") =>
    prisma.termMembership.upsert({
      where: {
        personId_termId_departmentId_kind: {
          personId,
          termId: su26.id,
          departmentId,
          kind,
        },
      },
      update: { status: "ACTIVE" },
      create: { personId, termId: su26.id, departmentId, kind },
    });

  await membership(jack.id, itcm.id, "DIRECTOR");
  await membership(director.id, vadm.id, "DIRECTOR");
  await membership(volunteer.id, vadm.id, "VOLUNTEER");

  const existingAssignment = await prisma.roleAssignment.findFirst({
    where: { roleId: adminRole.id, personId: jack.id, termId: null },
  });
  if (!existingAssignment) {
    await prisma.roleAssignment.create({
      data: { roleId: adminRole.id, personId: jack.id, termId: null },
    });
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run the seed twice (idempotency check)**

Run: `npm run db:seed && npm run db:seed`
Expected: "Seed complete." both times, no unique-constraint errors.

- [ ] **Step 3: Spot-check**

Run: `docker compose exec -T postgres psql -U haven -d havenhub -c 'SELECT code, status FROM "Term"; SELECT count(*) FROM "Person";'`
Expected: SU26 ACTIVE; 3 people.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat: idempotent dev seed (departments, system roles, SU26, dev people)"
```

---

### Task 6: Login → Person matching

**Files:**
- Create: `src/platform/auth/match-person.ts`
- Test: `src/platform/auth/match-person.test.ts`

The spec's resolution order: (1) linked `entraObjectId`, (2) NetID from UPN, (3) email against `contactEmail`/`yaleEmail`, (4) no match → null. Matches 2 and 3 link the `entraObjectId` for next time.

- [ ] **Step 1: Write the failing tests** — `src/platform/auth/match-person.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { netIdFromUpn, resolvePersonForLogin } from "./match-person";

describe("netIdFromUpn", () => {
  it("extracts a NetID-shaped local part", () => {
    expect(netIdFromUpn("abc123@yale.edu")).toBe("abc123");
  });
  it("lowercases", () => {
    expect(netIdFromUpn("ABC123@yale.edu")).toBe("abc123");
  });
  it("rejects alias-style addresses (first.last)", () => {
    expect(netIdFromUpn("jack.carney@yale.edu")).toBeNull();
  });
  it("handles empty/garbage input", () => {
    expect(netIdFromUpn("")).toBeNull();
    expect(netIdFromUpn("@yale.edu")).toBeNull();
  });
});

describe("resolvePersonForLogin", () => {
  beforeEach(resetDb);

  it("matches by already-linked entraObjectId first", async () => {
    const person = await prisma.person.create({
      data: { name: "A", entraObjectId: "oid-1", contactEmail: "a@yale.edu" },
    });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-1",
      upn: "zz999@yale.edu", // would not match anyone
      email: "other@yale.edu",
    });
    expect(found?.id).toBe(person.id);
  });

  it("matches by NetID from UPN and links the entraObjectId", async () => {
    const person = await prisma.person.create({
      data: { name: "B", netId: "bb123" },
    });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-2",
      upn: "BB123@yale.edu",
      email: null,
    });
    expect(found?.id).toBe(person.id);
    const reloaded = await prisma.person.findUniqueOrThrow({ where: { id: person.id } });
    expect(reloaded.entraObjectId).toBe("oid-2");
  });

  it("falls back to case-insensitive email match on contactEmail or yaleEmail", async () => {
    const person = await prisma.person.create({
      data: { name: "C", yaleEmail: "c.person@yale.edu" },
    });
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-3",
      upn: null,
      email: "C.Person@yale.edu",
    });
    expect(found?.id).toBe(person.id);
  });

  it("returns null when nothing matches", async () => {
    const found = await resolvePersonForLogin({
      entraObjectId: "oid-4",
      upn: "nobody1@yale.edu",
      email: "nobody@yale.edu",
    });
    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/platform/auth/match-person.test.ts`
Expected: FAIL — cannot resolve `./match-person`.

- [ ] **Step 3: Write `src/platform/auth/match-person.ts`**

```ts
import type { Person } from "@prisma/client";
import { prisma } from "@/platform/db";

export type LoginProfile = {
  entraObjectId?: string | null;
  upn?: string | null;
  email?: string | null;
};

/**
 * Yale UPNs look like "abc123@yale.edu" (NetID local part).
 * Alias addresses ("first.last@yale.edu") are not NetIDs.
 */
export function netIdFromUpn(upn: string): string | null {
  const local = upn.split("@")[0] ?? "";
  return /^[a-z]{2,8}[0-9]*$/i.test(local) ? local.toLowerCase() : null;
}

/** Resolution order per spec §5. Matches via steps 2/3 link entraObjectId. */
export async function resolvePersonForLogin(
  profile: LoginProfile
): Promise<Person | null> {
  // 1. Already linked
  if (profile.entraObjectId) {
    const linked = await prisma.person.findUnique({
      where: { entraObjectId: profile.entraObjectId },
    });
    if (linked) return linked;
  }

  // 2. NetID extracted from UPN
  const netId = profile.upn ? netIdFromUpn(profile.upn) : null;
  if (netId) {
    const byNetId = await prisma.person.findFirst({
      where: { netId: { equals: netId, mode: "insensitive" } },
    });
    if (byNetId) return link(byNetId, profile.entraObjectId);
  }

  // 3. Email against contactEmail or yaleEmail
  if (profile.email) {
    const byEmail = await prisma.person.findFirst({
      where: {
        OR: [
          { contactEmail: { equals: profile.email, mode: "insensitive" } },
          { yaleEmail: { equals: profile.email, mode: "insensitive" } },
        ],
      },
    });
    if (byEmail) return link(byEmail, profile.entraObjectId);
  }

  // 4. No match
  return null;
}

async function link(person: Person, entraObjectId?: string | null): Promise<Person> {
  if (!entraObjectId || person.entraObjectId === entraObjectId) return person;
  return prisma.person.update({
    where: { id: person.id },
    data: { entraObjectId },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/platform/auth/match-person.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/
git commit -m "feat: login-to-person resolution with entra linking"
```

---

### Task 7: NextAuth wiring, login/welcome pages, session helpers

**Files:**
- Create: `src/platform/auth/auth.ts`, `src/platform/auth/session.ts`, `src/types/next-auth.d.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `src/app/login/page.tsx`, `src/app/welcome/page.tsx`
- Modify: `src/app/page.tsx`

Pattern lifted from haven-triage's proven `src/lib/auth.ts`, adapted: Person matching replaces the User-allowlist, unmatched logins go to `/welcome` (not `/denied`).

- [ ] **Step 1: Write `src/types/next-auth.d.ts`**

```ts
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    personId: string | null;
    user: DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    personId?: string | null;
  }
}
```

- [ ] **Step 2: Write `src/platform/auth/auth.ts`**

```ts
import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/platform/db";
import { config } from "@/platform/config";
import { resolvePersonForLogin, type LoginProfile } from "./match-person";

type EntraClaims = {
  oid?: string;
  preferred_username?: string;
  email?: string;
};

function profileFromEntra(
  profile: unknown,
  providerAccountId: string | undefined,
  fallbackEmail: string | null | undefined
): LoginProfile {
  const claims = (profile ?? {}) as EntraClaims;
  return {
    entraObjectId: claims.oid ?? providerAccountId ?? null,
    upn: claims.preferred_username ?? null,
    email: claims.email ?? fallbackEmail ?? null,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: config.AUTH_SECRET,
  session: { strategy: "jwt" },
  providers: [
    ...(config.AZURE_AD_CLIENT_ID
      ? [
          MicrosoftEntraID({
            clientId: config.AZURE_AD_CLIENT_ID,
            clientSecret: config.AZURE_AD_CLIENT_SECRET!,
            issuer: `https://login.microsoftonline.com/${config.AZURE_AD_TENANT_ID}/v2.0`,
          }),
        ]
      : []),
    // Dev-only login: email lookup, no password. Never registered in production.
    ...(config.NODE_ENV !== "production"
      ? [
          Credentials({
            id: "credentials",
            name: "Dev Login",
            credentials: { email: { label: "Email", type: "text" } },
            async authorize(credentials) {
              const email = credentials?.email as string | undefined;
              if (!email) return null;
              const person = await resolvePersonForLogin({ email });
              if (!person || person.status !== "ACTIVE") return null;
              return { id: person.id, email, name: person.name };
            },
          }),
        ]
      : []),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "credentials") return true; // authorize() validated
      const person = await resolvePersonForLogin(
        profileFromEntra(profile, account?.providerAccountId, user.email)
      );
      return person ? true : "/welcome";
    },
    async jwt({ token, user, account, profile }) {
      if (account) {
        // Initial sign-in only
        if (account.provider === "credentials" && user) {
          token.personId = user.id;
        } else {
          const person = await resolvePersonForLogin(
            profileFromEntra(profile, account.providerAccountId, user?.email)
          );
          token.personId = person?.id ?? null;
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.personId = (token.personId as string | null) ?? null;
      return session;
    },
  },
});
```

- [ ] **Step 3: Write `src/app/api/auth/[...nextauth]/route.ts`**

```ts
import { handlers } from "@/platform/auth/auth";

export const { GET, POST } = handlers;
```

- [ ] **Step 4: Write `src/platform/auth/session.ts`**

```ts
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { can } from "@/platform/rbac/engine";

export type PersonSession = {
  personId: string;
  name: string | null;
  email: string | null;
};

/** For pages/actions that need a signed-in, matched person. Redirects otherwise. */
export async function requirePersonSession(): Promise<PersonSession> {
  const session = await auth();
  if (!session) redirect("/login");
  if (!session.personId) redirect("/welcome");
  return {
    personId: session.personId,
    name: session.user?.name ?? null,
    email: session.user?.email ?? null,
  };
}

/** Layout/page-level permission gate. */
export async function requirePermission(permission: string): Promise<PersonSession> {
  const person = await requirePersonSession();
  if (!(await can(person.personId, permission))) redirect("/hub");
  return person;
}
```

(`can` is implemented in Task 8 — write this file as-is now; the import will resolve then. If executing strictly in order, you may stub `src/platform/rbac/engine.ts` with `export async function can() { return false; }` and replace it in Task 8.)

- [ ] **Step 5: Write `src/app/login/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { auth, signIn } from "@/platform/auth/auth";
import { config } from "@/platform/config";

export default async function LoginPage() {
  const session = await auth();
  if (session?.personId) redirect("/hub");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">HAVENHub</h1>
        <p className="mt-1 text-sm text-slate-500">
          HAVEN Free Clinic — directors &amp; volunteers
        </p>

        {config.AZURE_AD_CLIENT_ID ? (
          <form
            className="mt-6"
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: "/hub" });
            }}
          >
            <button
              type="submit"
              className="w-full rounded-lg bg-blue-700 px-4 py-2.5 font-medium text-white hover:bg-blue-800"
            >
              Sign in with Yale
            </button>
          </form>
        ) : (
          <p className="mt-6 text-sm text-amber-600">
            Entra ID is not configured (AZURE_AD_* unset).
          </p>
        )}

        {config.NODE_ENV !== "production" && (
          <form
            className="mt-4 border-t border-slate-100 pt-4"
            action={async (formData: FormData) => {
              "use server";
              await signIn("credentials", {
                email: formData.get("email"),
                redirectTo: "/hub",
              });
            }}
          >
            <label className="text-xs font-medium text-slate-500" htmlFor="email">
              Dev login (email lookup, local only)
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              placeholder="j.carney@yale.edu"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
            >
              Dev sign in
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Write `src/app/welcome/page.tsx`**

```tsx
import { signOut } from "@/platform/auth/auth";

export default function WelcomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold">Welcome to HAVEN Free Clinic</h1>
        <p className="mt-3 text-sm text-slate-600">
          You signed in successfully, but we couldn&apos;t find you in our records.
          If you&apos;re a current member, contact the IT team so we can fix your
          record. If you&apos;d like to join HAVEN, keep an eye out for the next
          recruitment cycle.
        </p>
        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button
            type="submit"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Replace `src/app/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { auth } from "@/platform/auth/auth";

export default async function Home() {
  const session = await auth();
  redirect(session?.personId ? "/hub" : "/login");
}
```

- [ ] **Step 8: Stub the engine so typecheck passes** (replaced in Task 8) — `src/platform/rbac/engine.ts`

```ts
/** Stub — real implementation lands in Task 8. */
export async function can(_personId: string, _permission: string): Promise<boolean> {
  return false;
}
```

- [ ] **Step 9: Manual verification**

Run: `npm run dev`
- Visit `http://localhost:3000` → redirected to `/login`.
- Dev sign in as `j.carney@yale.edu` → redirected toward `/hub` (404 for now — page lands in Task 11; the session cookie is what we're verifying).
- Dev sign in as `nobody@yale.edu` → stays on login (authorize rejected).
Expected: both behaviors as described. Stop the server.

- [ ] **Step 10: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/ && git commit -m "feat: NextAuth (Entra + dev credentials), login/welcome pages, session helpers"
```

---

### Task 8: RBAC engine

**Files:**
- Modify: `src/platform/rbac/engine.ts` (replace the stub)
- Test: `src/platform/rbac/engine.test.ts`

Effective permissions = union of: roles assigned directly to the person (global or active-term scope), roles assigned to departments the person actively belongs to in the **active term**, plus auto-attached system roles (`Director`/`Volunteer`) from membership kind. `"*"` grants everything.

- [ ] **Step 1: Write the failing tests** — `src/platform/rbac/engine.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { can, getEffectivePermissions } from "./engine";

async function fixture() {
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-30"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
    },
  });
  const oldTerm = await prisma.term.create({
    data: {
      code: "SP26",
      name: "Spring 2026",
      startDate: new Date("2026-01-10"),
      endDate: new Date("2026-05-01"),
      status: "ARCHIVED",
    },
  });
  const itcm = await prisma.department.create({ data: { code: "ITCM", name: "IT" } });
  const vadm = await prisma.department.create({ data: { code: "VADM", name: "Vol Admin" } });

  const adminRole = await prisma.role.create({
    data: { name: "Platform Admin", isSystem: true, grants: { create: [{ permission: "*" }] } },
  });
  const directorRole = await prisma.role.create({
    data: {
      name: "Director",
      isSystem: true,
      grants: { create: [{ permission: "schedule.view" }, { permission: "schedule.edit_own_dept" }] },
    },
  });
  const volunteerRole = await prisma.role.create({
    data: { name: "Volunteer", isSystem: true, grants: { create: [{ permission: "schedule.view" }] } },
  });
  const recruiterRole = await prisma.role.create({
    data: {
      name: "Recruitment Manager",
      grants: { create: [{ permission: "recruitment.manage_cycle" }] },
    },
  });

  return { term, oldTerm, itcm, vadm, adminRole, directorRole, volunteerRole, recruiterRole };
}

describe("rbac engine", () => {
  beforeEach(resetDb);

  it("grants everything via a global '*' assignment", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Admin" } });
    await prisma.roleAssignment.create({
      data: { roleId: f.adminRole.id, personId: person.id, termId: null },
    });
    expect(await can(person.id, "anything.at_all")).toBe(true);
  });

  it("auto-attaches Director role from active-term membership kind", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Dir" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "DIRECTOR" },
    });
    expect(await can(person.id, "schedule.edit_own_dept")).toBe(true);
    expect(await can(person.id, "recruitment.manage_cycle")).toBe(false);
  });

  it("grants department-assigned roles to active members of that department", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "SRR member" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.itcm.id, kind: "VOLUNTEER" },
    });
    await prisma.roleAssignment.create({
      data: { roleId: f.recruiterRole.id, departmentId: f.itcm.id, termId: f.term.id },
    });
    expect(await can(person.id, "recruitment.manage_cycle")).toBe(true);
  });

  it("ignores assignments scoped to a non-active term", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Old" } });
    await prisma.roleAssignment.create({
      data: { roleId: f.recruiterRole.id, personId: person.id, termId: f.oldTerm.id },
    });
    expect(await can(person.id, "recruitment.manage_cycle")).toBe(false);
  });

  it("ignores REMOVED memberships", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Removed" } });
    await prisma.termMembership.create({
      data: {
        personId: person.id,
        termId: f.term.id,
        departmentId: f.vadm.id,
        kind: "DIRECTOR",
        status: "REMOVED",
      },
    });
    expect(await can(person.id, "schedule.edit_own_dept")).toBe(false);
  });

  it("returns the full effective permission set", async () => {
    const f = await fixture();
    const person = await prisma.person.create({ data: { name: "Vol" } });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: f.term.id, departmentId: f.vadm.id, kind: "VOLUNTEER" },
    });
    const perms = await getEffectivePermissions(person.id);
    expect(perms.has("schedule.view")).toBe(true);
    expect(perms.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/platform/rbac/engine.test.ts`
Expected: FAIL — the stub returns false for everything; `getEffectivePermissions` doesn't exist.

- [ ] **Step 3: Replace `src/platform/rbac/engine.ts`**

```ts
import type { MembershipKind } from "@prisma/client";
import { prisma } from "@/platform/db";

const MEMBERSHIP_KIND_ROLE: Record<MembershipKind, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
};

/**
 * Union of:
 *  - roles assigned directly to the person (global, or scoped to the active term)
 *  - roles assigned to departments the person actively belongs to in the active term
 *  - auto-attached system roles (Director/Volunteer) from active-term membership kind
 * Computed from live DB state on every call — role changes apply immediately (spec §5).
 */
export async function getEffectivePermissions(personId: string): Promise<Set<string>> {
  const activeTerm = await prisma.term.findFirst({ where: { status: "ACTIVE" } });

  const memberships = activeTerm
    ? await prisma.termMembership.findMany({
        where: { personId, termId: activeTerm.id, status: "ACTIVE" },
      })
    : [];
  const departmentIds = [...new Set(memberships.map((m) => m.departmentId))];
  const autoRoleNames = [...new Set(memberships.map((m) => MEMBERSHIP_KIND_ROLE[m.kind]))];

  const [assignments, autoRoles] = await Promise.all([
    prisma.roleAssignment.findMany({
      where: {
        AND: [
          {
            OR: [
              { termId: null },
              ...(activeTerm ? [{ termId: activeTerm.id }] : []),
            ],
          },
          {
            OR: [
              { personId },
              ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : []),
            ],
          },
        ],
      },
      include: { role: { include: { grants: true } } },
    }),
    autoRoleNames.length
      ? prisma.role.findMany({
          where: { name: { in: autoRoleNames }, isSystem: true },
          include: { grants: true },
        })
      : Promise.resolve([]),
  ]);

  const permissions = new Set<string>();
  for (const a of assignments) for (const g of a.role.grants) permissions.add(g.permission);
  for (const r of autoRoles) for (const g of r.grants) permissions.add(g.permission);
  return permissions;
}

export async function can(personId: string, permission: string): Promise<boolean> {
  const permissions = await getEffectivePermissions(personId);
  return permissions.has(permission) || permissions.has("*");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/platform/rbac/engine.test.ts`
Expected: 6 passed. (Note the "full set" test asserts `size === 1` — auto roles only, no `"*"` leakage.)

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests pass (config, match-person, engine).

- [ ] **Step 6: Commit**

```bash
git add src/platform/rbac/
git commit -m "feat: RBAC engine — term-scoped roles, department grants, auto roles, wildcard"
```

---

### Task 9: Audit service

**Files:**
- Create: `src/platform/audit.ts`
- Modify: `src/platform/auth/auth.ts` (record unmatched logins)
- Test: `src/platform/audit.test.ts`

- [ ] **Step 1: Write the failing test** — `src/platform/audit.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { recordAudit } from "./audit";

describe("recordAudit", () => {
  beforeEach(resetDb);

  it("persists an audit row with before/after snapshots", async () => {
    await recordAudit({
      actorPersonId: "person-1",
      action: "person.update",
      entityType: "Person",
      entityId: "person-2",
      before: { phone: "111" },
      after: { phone: "222" },
      ip: "127.0.0.1",
    });
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("person.update");
    expect(rows[0].before).toEqual({ phone: "111" });
  });

  it("never throws — audit failure must not break the mutation it records", async () => {
    // entityType deliberately missing → Prisma rejects; recordAudit swallows and logs.
    await expect(
      recordAudit({ action: "x", entityType: undefined as unknown as string })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/platform/audit.test.ts`
Expected: FAIL — cannot resolve `./audit`.

- [ ] **Step 3: Write `src/platform/audit.ts`**

```ts
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";

export type AuditEntry = {
  actorPersonId?: string | null;
  action: string; // "entity.verb", e.g. "person.update", "auth.login_unmatched"
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
};

/** Fire-and-forget durable audit. Never throws — logs failures to stderr instead. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorPersonId: entry.actorPersonId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: entry.before,
        after: entry.after,
        ip: entry.ip ?? null,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record entry", entry.action, error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/platform/audit.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Wire unmatched-login auditing into auth** (spec §5: unmatched attempts are logged for admin review)

Modify `src/platform/auth/auth.ts`: add the import and replace the `signIn` callback.

```ts
import { recordAudit } from "@/platform/audit";
```

```ts
    async signIn({ user, account, profile }) {
      if (account?.provider === "credentials") return true; // authorize() validated
      const loginProfile = profileFromEntra(
        profile,
        account?.providerAccountId,
        user.email
      );
      const person = await resolvePersonForLogin(loginProfile);
      if (!person) {
        await recordAudit({
          action: "auth.login_unmatched",
          entityType: "Auth",
          after: { upn: loginProfile.upn, email: loginProfile.email },
        });
        return "/welcome";
      }
      return true;
    },
```

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/platform/audit.ts src/platform/audit.test.ts src/platform/auth/auth.ts
git commit -m "feat: audit log service + unmatched-login auditing"
```

---

### Task 10: Module manifest types and registry

**Files:**
- Create: `src/platform/modules/types.ts`, `src/platform/modules/registry.ts`
- Test: `src/platform/modules/registry.test.ts`

All eight modules from the spec are registered now; all start `coming-soon`. Each module's own plan flips it to `active`.

- [ ] **Step 1: Write `src/platform/modules/types.ts`**

```ts
import type { ComponentType } from "react";

export type ModuleStatus = "active" | "coming-soon";

export type ModuleNavItem = {
  label: string;
  href: string;
};

export type ModuleManifest = {
  /** URL segment and permission namespace, e.g. "schedule" → /schedule, "schedule.*" */
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** Controls hub-tile visibility and the module's route guard. */
  accessPermission: string;
  /** Every permission string this module declares — feeds the RBAC editor. */
  permissions: string[];
  status: ModuleStatus;
  nav: ModuleNavItem[];
};
```

- [ ] **Step 2: Write the failing registry test** — `src/platform/modules/registry.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { MODULES } from "./registry";

describe("module registry", () => {
  it("has unique module ids", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("namespaces every permission by its module id", () => {
    for (const m of MODULES) {
      for (const p of m.permissions) {
        expect(p.startsWith(`${m.id}.`)).toBe(true);
      }
    }
  });

  it("includes each module's accessPermission in its declared permissions", () => {
    for (const m of MODULES) {
      expect(m.permissions).toContain(m.accessPermission);
    }
  });

  it("registers the eight modules from the spec", () => {
    expect(MODULES.map((m) => m.id).sort()).toEqual(
      [
        "admin",
        "my-info",
        "patient-trackers",
        "recruitment",
        "referrals",
        "schedule",
        "triage",
        "volunteers",
      ].sort()
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/platform/modules/registry.test.ts`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 4: Write `src/platform/modules/registry.ts`**

```ts
import {
  CalendarDays,
  ClipboardList,
  HeartHandshake,
  MessagesSquare,
  Send,
  Settings,
  UserRoundPen,
  Users,
} from "lucide-react";
import type { ModuleManifest } from "./types";

/** The single wiring point for modules (spec §8). Hub tiles render from this. */
export const MODULES: ModuleManifest[] = [
  {
    id: "schedule",
    title: "Clinic Schedule",
    description: "Build and view department schedules, request swaps",
    icon: CalendarDays,
    accessPermission: "schedule.view",
    permissions: [
      "schedule.view",
      "schedule.edit_own_dept",
      "schedule.edit_all",
      "schedule.manage_requests",
    ],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "my-info",
    title: "My Info",
    description: "Update your contact info and HIPAA compliance",
    icon: UserRoundPen,
    accessPermission: "my-info.access",
    permissions: ["my-info.access"],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "volunteers",
    title: "Volunteer Management",
    description: "Compliance, rosters, offboarding, Epic requests, disciplinary",
    icon: Users,
    accessPermission: "volunteers.view",
    permissions: [
      "volunteers.view",
      "volunteers.manage_compliance",
      "volunteers.manage_offboarding",
      "volunteers.manage_epic",
      "volunteers.issue_disciplinary",
    ],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "admin",
    title: "Admin",
    description: "People, terms, roles, sync health, audit log",
    icon: Settings,
    accessPermission: "admin.access",
    permissions: [
      "admin.access",
      "admin.manage_people",
      "admin.manage_terms",
      "admin.manage_roles",
      "admin.view_audit",
      "admin.manage_sync",
    ],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "recruitment",
    title: "Recruitment",
    description: "Run recruitment cycles and applications",
    icon: ClipboardList,
    accessPermission: "recruitment.access",
    permissions: ["recruitment.access"],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "triage",
    title: "Triage",
    description: "Patient case coordination across departments",
    icon: MessagesSquare,
    accessPermission: "triage.access",
    permissions: ["triage.access"],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "referrals",
    title: "Referrals",
    description: "Track outgoing patient referrals",
    icon: Send,
    accessPermission: "referrals.access",
    permissions: ["referrals.access"],
    status: "coming-soon",
    nav: [],
  },
  {
    id: "patient-trackers",
    title: "Patient Trackers",
    description: "Department patient tracking workflows",
    icon: HeartHandshake,
    accessPermission: "patient-trackers.access",
    permissions: ["patient-trackers.access"],
    status: "coming-soon",
    nav: [],
  },
];

export function getModule(id: string): ModuleManifest | undefined {
  return MODULES.find((m) => m.id === id);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/platform/modules/registry.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/platform/modules/
git commit -m "feat: module manifest contract and registry with all eight modules"
```

---

### Task 11: App shell and hub page

**Files:**
- Create: `src/platform/ui/app-shell.tsx`, `src/app/hub/page.tsx`

- [ ] **Step 1: Write `src/platform/ui/app-shell.tsx`**

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/platform/auth/auth";

export function AppShell({
  userName,
  children,
}: {
  userName: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/hub" className="text-lg font-semibold">
            HAVENHub
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-600">{userName}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="text-sm text-slate-500 underline-offset-4 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
```

- [ ] **Step 2: Write `src/app/hub/page.tsx`**

```tsx
import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { MODULES } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";

export default async function HubPage() {
  const person = await requirePersonSession();
  const permissions = await getEffectivePermissions(person.personId);
  const hasAll = permissions.has("*");

  const visible = MODULES.filter(
    (m) =>
      m.status === "coming-soon" || // roadmap is visible to everyone (spec §8)
      hasAll ||
      permissions.has(m.accessPermission)
  );

  return (
    <AppShell userName={person.name}>
      <h1 className="text-2xl font-semibold">Welcome{person.name ? `, ${person.name}` : ""}</h1>
      <p className="mt-1 text-sm text-slate-500">HAVEN Free Clinic</p>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((m) => {
          const Icon = m.icon;
          const card = (
            <div
              className={`rounded-2xl border p-5 transition ${
                m.status === "active"
                  ? "border-slate-200 bg-white shadow-sm hover:border-blue-300 hover:shadow"
                  : "border-dashed border-slate-200 bg-slate-50 opacity-60"
              }`}
            >
              <Icon className="h-6 w-6 text-blue-700" />
              <div className="mt-3 flex items-center gap-2">
                <h2 className="font-medium">{m.title}</h2>
                {m.status === "coming-soon" && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-500">{m.description}</p>
            </div>
          );
          return m.status === "active" ? (
            <Link key={m.id} href={`/${m.id}`}>
              {card}
            </Link>
          ) : (
            <div key={m.id}>{card}</div>
          );
        })}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`
- Dev sign in as `j.carney@yale.edu` → hub shows your name and all eight tiles (all greyed "coming soon").
- Sign out → back to `/login`.
- Dev sign in as `dev.volunteer@yale.edu` → hub renders (coming-soon tiles visible to everyone for now; permission filtering becomes observable when modules flip to `active`).
Expected: as described. Stop the server.

- [ ] **Step 4: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/platform/ui/ src/app/hub/
git commit -m "feat: app shell and permission-gated hub page"
```

---

### Task 12: Health endpoint

**Files:**
- Create: `src/app/api/health/route.ts`
- Test: `src/app/api/health/route.test.ts`

- [ ] **Step 1: Write the failing test** — `src/app/api/health/route.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("reports ok with a reachable database", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/api/health/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write `src/app/api/health/route.ts`**

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/platform/db";

export async function GET() {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    // fall through — db stays false
  }
  return NextResponse.json(
    { ok: db, db },
    { status: db ? 200 : 503 }
  );
}
```

(Worker heartbeat and outbox depth are added in Plan 2 when those exist.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/api/health/route.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/health/
git commit -m "feat: health endpoint (db check)"
```

---

### Task 13: Module boundary lint rules

**Files:**
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Add boundary zones to `eslint.config.mjs`** — full new content:

```js
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

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
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**"] },
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
  // Platform must not depend on any module's internals (registry imports manifests
  // is the one sanctioned exception — manifests live in platform once modules exist;
  // until then, nothing to except).
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
];

export default eslintConfig;
```

- [ ] **Step 2: Prove the rule fires** — create a deliberate violation:

```bash
mkdir -p src/modules/schedule src/modules/my-info
echo 'export const x = 1;' > src/modules/my-info/internal.ts
echo 'import { x } from "@/modules/my-info/internal"; export const y = x;' > src/modules/schedule/bad.ts
npm run lint
```
Expected: lint ERROR on `src/modules/schedule/bad.ts` with the boundary message.

- [ ] **Step 3: Remove the violation, keep the structure**

```bash
rm src/modules/schedule/bad.ts src/modules/my-info/internal.ts
echo '// Module code lands here in its own plan. See docs/superpowers/plans/.' > src/modules/.gitkeep
npm run lint
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs src/modules/
git commit -m "chore: lint-enforced module boundaries"
```

---

### Task 14: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: haven
          POSTGRES_PASSWORD: haven_dev
          POSTGRES_DB: havenhub_test
        ports:
          - 5433:5432
        options: >-
          --health-cmd "pg_isready -U haven"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://haven:haven_dev@localhost:5433/havenhub_test
      TEST_DATABASE_URL: postgresql://haven:haven_dev@localhost:5433/havenhub_test
      AUTH_SECRET: ci-only-secret
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx prisma migrate deploy
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Commit** (verification happens on first push once a GitHub remote exists — creating the remote repo is a deliberate user action, not part of this plan)

```bash
git add .github/
git commit -m "ci: lint, typecheck, tests against postgres service"
```

---

### Task 15: Playwright smoke test

**Files:**
- Create: `playwright.config.ts`, `e2e/login.spec.ts`

- [ ] **Step 1: Install the browser**

Run: `npx playwright install chromium`
Expected: Chromium downloads.

- [ ] **Step 2: Write `playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
```

- [ ] **Step 3: Write `e2e/login.spec.ts`**

```ts
import { expect, test } from "@playwright/test";

test("dev login reaches the permission-gated hub", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "j.carney@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL("**/hub");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  await expect(page.getByText("Clinic Schedule")).toBeVisible();
  await expect(page.getByText("Volunteer Management")).toBeVisible();
});

test("unknown email cannot dev-sign-in", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "stranger@yale.edu");
  await page.click('button:has-text("Dev sign in")');
  await expect(page).not.toHaveURL(/\/hub/);
});
```

- [ ] **Step 4: Run it** (requires the dev DB up and seeded: `npm run db:up && npm run db:seed`)

Run: `npm run e2e`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e/
git commit -m "test: e2e smoke — dev login to hub"
```

---

### Task 16: Final verification

- [ ] **Step 1: Full local gauntlet**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: everything green; `next build` completes with standalone output.

- [ ] **Step 2: Fresh-clone sanity** (proves the README-free onboarding path works)

Run, from a temp dir:
```bash
git clone /Users/jcarney/Documents/Code-Projects/HAVENHub /tmp/havenhub-fresh && cd /tmp/havenhub-fresh
cp .env.example .env  # set AUTH_SECRET
npm install && npm run db:up && npx prisma migrate dev && npm run db:seed && npm run test:prepare && npm test
```
Expected: passes end to end. (Uses the same compose Postgres — stop the original first if ports clash.) Clean up: `rm -rf /tmp/havenhub-fresh`.

- [ ] **Step 3: Commit any stragglers; tag the milestone**

```bash
git add -A && git status   # should be clean or trivial
git commit -m "chore: plan 1 complete — platform foundation" --allow-empty
```

---

## Deferred to later plans (deliberately, not forgotten)

- **Plan 2:** Airtable importer + outbox/mirror worker (pg-boss), sync health in `/api/health`, worker container in compose
- **Plan 3:** Admin module (flips `admin` to `active`; term lifecycle UI, RBAC editor, audit viewer)
- **Plans 4–6:** My Info, Volunteers, Schedule modules
- **Entra verification:** first real "Sign in with Yale" against the app registration (needs `AZURE_AD_*` values; verify the `oid`/`preferred_username` claims match `profileFromEntra`'s expectations and adjust if Yale's tenant differs)
- **Deployment:** app/worker Dockerfiles, GHCR publish, SpinUp compose — its own plan once SpinUp is provisioned
