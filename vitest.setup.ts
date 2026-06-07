// Tests run against a dedicated test database, never the dev one.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://haven:haven_dev@localhost:5434/havenhub_test";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret";
// NODE_ENV intentionally omitted — vitest sets NODE_ENV=test automatically.

// Upload directory: use a stable temp path so certificate service tests do not
// write into the project tree. Set BEFORE any config import.
process.env.UPLOAD_DIR = "/tmp/havenhub-test-uploads";
