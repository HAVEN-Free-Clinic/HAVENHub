import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalTestDatabase, UnsafeDatabaseTargetError } from "./db-target";

/**
 * Deliberately imports only db-target.ts, never db.ts: db.ts constructs a
 * PrismaClient at import, which loads .env and would put the real DATABASE_URL
 * into process.env for the rest of the worker. This file must be able to prove
 * the guard works without any database, and without that side effect.
 */

/**
 * A managed-Postgres URL with the same SHAPE as the one truncated on
 * 2026-09-04. The host is synthetic on purpose: the real production hostname
 * is not a credential, but it is not something to commit to the repo either,
 * and hardcoding it here once already tripped GitHub secret scanning. What the
 * guard actually keys on is "not loopback", which this exercises just as well.
 */
const REMOTE_NEON_URL =
  "postgresql://neondb_owner:placeholder@ep-example-0000-pooler.region.aws.neon.tech/appdb?sslmode=require";

const TEMPLATE_URL = "postgresql://haven:haven_dev@localhost:5434/havenhub_test";
const WORKER_URL = "postgresql://haven:haven_dev@localhost:5434/havenhub_test_w3?connection_limit=5";

describe("assertLocalTestDatabase", () => {
  describe("accepts the databases the suite actually uses", () => {
    it("accepts the local template database", () => {
      expect(() => assertLocalTestDatabase(TEMPLATE_URL)).not.toThrow();
    });

    it("accepts a per-worker clone, connection_limit and all", () => {
      expect(() => assertLocalTestDatabase(WORKER_URL)).not.toThrow();
    });

    it("accepts the CI database, which is the template URL", () => {
      // .github/workflows/ci.yml sets exactly this for the unit job.
      expect(() =>
        assertLocalTestDatabase("postgresql://haven:haven_dev@localhost:5434/havenhub_test"),
      ).not.toThrow();
    });

    it("accepts loopback spelled as an address rather than a name", () => {
      expect(() =>
        assertLocalTestDatabase("postgresql://haven:haven_dev@127.0.0.1:5434/havenhub_test"),
      ).not.toThrow();
      expect(() =>
        assertLocalTestDatabase("postgresql://haven:haven_dev@[::1]:5434/havenhub_test"),
      ).not.toThrow();
    });

    it("accepts a per-worktree database name, which still carries the marker", () => {
      expect(() =>
        assertLocalTestDatabase("postgresql://haven:haven_dev@localhost:5434/havenhub_test_uicohesion"),
      ).not.toThrow();
    });
  });

  describe("refuses the incident", () => {
    it("refuses a remote managed-Postgres URL, the shape truncated on 2026-09-04", () => {
      expect(() => assertLocalTestDatabase(REMOTE_NEON_URL)).toThrow(UnsafeDatabaseTargetError);
    });

    it("names the offending host, so the failure is diagnosable from the message alone", () => {
      expect(() => assertLocalTestDatabase(REMOTE_NEON_URL)).toThrow(
        /ep-example-0000-pooler\.region\.aws\.neon\.tech/,
      );
    });

    it("explains the cause, since the reader is mid-incident", () => {
      expect(() => assertLocalTestDatabase(REMOTE_NEON_URL)).toThrow(/vitest\.setup\.ts/);
    });
  });

  describe("refuses everything else that is not a local test database", () => {
    it("refuses a remote host even when the database name says test", () => {
      expect(() =>
        assertLocalTestDatabase("postgresql://u:p@db.example.com:5432/havenhub_test"),
      ).toThrow(UnsafeDatabaseTargetError);
    });

    it("refuses a local database whose name does not mark it as a test database", () => {
      // The e2e job's `havenhub` on localhost: local, but real data.
      expect(() =>
        assertLocalTestDatabase("postgresql://haven:haven_dev@localhost:5434/havenhub"),
      ).toThrow(/does not mark it as a test database/);
    });

    it("refuses an empty DATABASE_URL rather than assuming it is safe", () => {
      expect(() => assertLocalTestDatabase("")).toThrow(/DATABASE_URL is not set/);
    });

    it("refuses when DATABASE_URL is absent from the environment entirely", () => {
      // Note `undefined` cannot be passed explicitly here: that selects the
      // default parameter, which reads the ambient value. The unset case only
      // exists when the env var itself is gone.
      const previous = process.env.DATABASE_URL;
      try {
        delete process.env.DATABASE_URL;
        expect(() => assertLocalTestDatabase()).toThrow(/DATABASE_URL is not set/);
      } finally {
        if (previous !== undefined) process.env.DATABASE_URL = previous;
      }
    });

    it("refuses a URL it cannot parse, rather than proceeding unverified", () => {
      expect(() => assertLocalTestDatabase("not a url")).toThrow(/not a parseable URL/);
    });
  });

  describe("is actually wired into resetDb", () => {
    /**
     * Read as source rather than imported on purpose. Importing db.ts constructs
     * a PrismaClient, and the whole point of this guard is that a stray import
     * in a misconfigured run is how production got truncated. A source assertion
     * proves the wiring with no client, no .env load, and no connection.
     */
    const source = readFileSync(path.join(__dirname, "db.ts"), "utf8");

    it("imports the guard", () => {
      expect(source).toMatch(/import \{ assertLocalTestDatabase \} from/);
    });

    it("calls the guard before issuing the TRUNCATE", () => {
      const guardAt = source.indexOf("assertLocalTestDatabase()");
      const truncateAt = source.indexOf("TRUNCATE");
      expect(guardAt).toBeGreaterThan(-1);
      expect(truncateAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(truncateAt);
    });

    it("calls the guard inside resetDb, not merely at module scope", () => {
      const body = source.slice(source.indexOf("export async function resetDb"));
      expect(body).toContain("assertLocalTestDatabase()");
    });
  });

  describe("reads process.env.DATABASE_URL when given no argument", () => {
    it("uses the ambient value, which is what Prisma connected with", () => {
      const previous = process.env.DATABASE_URL;
      try {
        process.env.DATABASE_URL = REMOTE_NEON_URL;
        expect(() => assertLocalTestDatabase()).toThrow(UnsafeDatabaseTargetError);

        process.env.DATABASE_URL = WORKER_URL;
        expect(() => assertLocalTestDatabase()).not.toThrow();
      } finally {
        if (previous === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous;
      }
    });
  });
});
