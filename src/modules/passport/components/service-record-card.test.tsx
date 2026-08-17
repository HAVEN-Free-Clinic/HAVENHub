// @vitest-environment jsdom
/**
 * Guards what the card SHOWS after "Add to wallet", which is the half of the
 * publish flow the server cannot enforce.
 *
 * Adding a badge auto-publishes the member's credential so the QR resolves. The
 * card used to learn nothing about that, so it kept offering "Publish a
 * shareable link" and hid Unpublish until a full page reload: the member was
 * published to the public internet with no control in front of them to undo it
 * (audit 14).
 *
 * Bare createRoot + act(), following modal.test.tsx: this repo has no
 * @testing-library/react.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ServiceRecordCard } from "./service-record-card";
import type { IssuedCredential } from "../services/credential";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLDivElement; root: Root } | null = null;

type WalletResult = { googleSaveUrl: string; shareUrl: string; publicToken?: string | null };

function mount(opts: { initialToken: string | null; wallet: WalletResult | null }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ServiceRecordCard
        orgName="HAVEN Free Clinic"
        brandColor="#123456"
        baseUrl="https://hub.example.org"
        initialToken={opts.initialToken}
        issue={() => Promise.resolve({} as IssuedCredential)}
        publish={() => Promise.resolve("tok_manual")}
        unpublish={() => Promise.resolve()}
        walletEnabled
        issueWalletPass={() => Promise.resolve(opts.wallet)}
      />,
    ),
  );
  mounted = { container, root };
}

const buttonLabelled = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

afterEach(() => {
  if (mounted) {
    const { container, root } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe("ServiceRecordCard wallet badge", () => {
  it("shows the published link and the Unpublish control once the badge publishes", async () => {
    mount({
      initialToken: null,
      wallet: { googleSaveUrl: "https://g", shareUrl: "https://s", publicToken: "tok_auto" },
    });
    expect(buttonLabelled("Publish a shareable link")).toBeDefined();

    await act(async () => {
      buttonLabelled("Add to wallet")?.click();
    });

    // The member can see where they were published, and can take it down.
    expect(document.body.textContent).toContain("https://hub.example.org/credential/tok_auto");
    expect(buttonLabelled("Unpublish")).toBeDefined();
    expect(buttonLabelled("Publish a shareable link")).toBeUndefined();
  });

  it("leaves the publish state alone when the badge published nothing", async () => {
    // A member who previously unpublished gets a badge with no QR and stays
    // unpublished. Showing a link here would claim a public page that 404s.
    mount({
      initialToken: null,
      wallet: { googleSaveUrl: "https://g", shareUrl: "https://s", publicToken: null },
    });

    await act(async () => {
      buttonLabelled("Add to wallet")?.click();
    });

    expect(buttonLabelled("Publish a shareable link")).toBeDefined();
    expect(document.body.textContent).not.toContain("/credential/");
  });

  it("degrades calmly when the vendor is unavailable", async () => {
    mount({ initialToken: null, wallet: null });

    await act(async () => {
      buttonLabelled("Add to wallet")?.click();
    });

    expect(document.body.textContent).toContain("not available right now");
    expect(buttonLabelled("Publish a shareable link")).toBeDefined();
  });
});
