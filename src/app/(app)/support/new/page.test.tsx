/**
 * SubmitPage branches entirely on isIntercomConfigured(): configured, the
 * page's only job is opening the Messenger (no competing form link);
 * unconfigured, it renders the intake form exactly as it did before this
 * change -- the requirement that every page behave unchanged for CI, e2e,
 * preview, and demo, none of which set NEXT_PUBLIC_INTERCOM_APP_ID.
 *
 * SubmitButton (inside SubmitForm) reads useFormStatus(), which needs a real
 * form-action runtime that renderToStaticMarkup does not provide -- mocked
 * the same way ticket-detail.test.tsx and request-list.test.tsx mock their
 * client-hook subcomponents.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/platform/auth/session", () => ({
  requireModuleAccess: async () => ({ personId: "person-1" }),
}));

vi.mock("@/platform/ui/submit-button", () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));

const { default: SubmitPage } = await import("./page");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SubmitPage", () => {
  it("renders the intake form (unchanged) when Intercom is not configured", async () => {
    const html = renderToStaticMarkup(await SubmitPage());
    expect(html).toContain("Submit a request");
    expect(html).toContain("Submit request");
    expect(html).not.toContain("Ask in Messenger");
    expect(html).not.toContain("Get help");
  });

  it("renders only the Messenger CTA, no form, when Intercom is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_INTERCOM_APP_ID", "unyx5lb2");
    vi.stubEnv("INTERCOM_MESSENGER_SECRET", "messenger-secret");
    const html = renderToStaticMarkup(await SubmitPage());
    expect(html).toContain("Get help");
    expect(html).toContain("Ask in Messenger");
    expect(html).not.toContain("Submit a request");
    expect(html).not.toContain('name="subject"');
  });
});
