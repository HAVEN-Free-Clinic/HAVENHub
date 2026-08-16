"use client";

import { useState } from "react";
import { Alert } from "@/platform/ui/alert";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import type { IssuedCredential } from "../services/credential";

type WalletPassLinks = { googleSaveUrl: string; shareUrl: string };

export function ServiceRecordCard({
  orgName,
  brandColor,
  baseUrl,
  initialToken,
  issue,
  publish,
  unpublish,
  walletEnabled,
  issueWalletPass,
}: {
  orgName: string;
  brandColor: string;
  baseUrl: string;
  /** The member's current publish token, or null if never published. */
  initialToken: string | null;
  /** Server action: freezes the record and returns the snapshot. */
  issue: () => Promise<IssuedCredential>;
  /** Server action: publishes (issuing first if needed) and returns the public token. */
  publish: () => Promise<string>;
  /** Server action: retracts the public link. */
  unpublish: () => Promise<void>;
  /** Resolved on the server: false when no vendor key is configured, in which case the section is not rendered at all. */
  walletEnabled: boolean;
  /** Server action: mints a wallet badge. Null is the normal, expected result when the vendor call fails, not an error. */
  issueWalletPass: () => Promise<WalletPassLinks | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(initialToken);
  const [publishBusy, setPublishBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletPass, setWalletPass] = useState<WalletPassLinks | null>(null);
  const [walletUnavailable, setWalletUnavailable] = useState(false);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const credential = await issue();
      const { pdf } = await import("@react-pdf/renderer");
      const { PassportDocument } = await import("./passport-pdf");
      const blob = await pdf(
        <PassportDocument
          record={credential.record}
          orgName={orgName}
          brandColor={brandColor}
          credentialUrl={token ? `${baseUrl}/credential/${token}` : null}
        />,
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Service-record-${credential.record.name.replace(/\s+/g, "-")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Deferred: revoking in the same tick as click() can invalidate the URL
      // before the browser starts the download (Firefox/Safari).
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError("Could not generate your service record. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function doPublish() {
    setPublishBusy(true);
    setError(null);
    try {
      setToken(await publish());
    } catch {
      setError("Could not publish your service record. Please try again.");
    } finally {
      setPublishBusy(false);
    }
  }

  async function doUnpublish() {
    setPublishBusy(true);
    setError(null);
    try {
      await unpublish();
      setToken(null);
    } catch {
      setError("Could not unpublish your service record. Please try again.");
    } finally {
      setPublishBusy(false);
    }
  }

  // A null result is the vendor being off or unreachable, which is expected and
  // must not read as an error: the certificate above still works either way.
  async function addToWallet() {
    setWalletBusy(true);
    setWalletUnavailable(false);
    try {
      const result = await issueWalletPass();
      if (result) {
        setWalletPass(result);
      } else {
        setWalletUnavailable(true);
      }
    } catch {
      setWalletUnavailable(true);
    } finally {
      setWalletBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Service record</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A dated certificate of your terms, departments, roles, and clinic shifts, suitable for
        residency and fellowship applications.
      </p>
      {error ? (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}
      <div className="mt-4">
        <Button onClick={download} disabled={busy}>
          {busy ? "Preparing..." : "Download certificate"}
        </Button>
      </div>

      <div className="mt-4 border-t border-border-subtle pt-4">
        {token ? (
          <>
            {/* ph-no-capture: this renders the member's live credential token,
                which stays valid until they unpublish. Autocapture reads element
                text and session replay records it, so without this the token
                reaches the analytics project from the page that displays it --
                the same reason the calendar feed URL field carries it (audit
                14). The scrubber covers /credential/<token> in a URL; this is
                the token as page content, which the scrubber never sees. */}
            <p className="ph-no-capture text-sm">
              Your record is published at{" "}
              <code className="break-all">{`${baseUrl}/credential/${token}`}</code>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Anyone with this link can see your name and service history. It is not listed in
              search engines.
            </p>
            <Button className="mt-3" variant="outline" onClick={doUnpublish} disabled={publishBusy}>
              {publishBusy ? "Working..." : "Unpublish"}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Publishing creates a shareable link that verifies this record. Off by default.
            </p>
            <Button className="mt-3" onClick={doPublish} disabled={publishBusy}>
              {publishBusy ? "Working..." : "Publish a shareable link"}
            </Button>
          </>
        )}
      </div>

      {walletEnabled ? (
        <div className="mt-4 border-t border-border-subtle pt-4">
          <h3 className="text-sm font-medium">Wallet badge</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a badge to your phone&apos;s wallet for quick ID at clinic. It expires
            automatically at the end of the term.
          </p>
          {/* Adding a badge publishes the shareable link, because the badge's QR
              code has to resolve to a page a scanner can actually read. Said
              plainly and BEFORE the button, not discovered afterwards: it puts
              this member's name and service history at a public URL. */}
          <p className="mt-1 text-sm text-muted-foreground">
            The badge carries a QR code, so adding one also publishes your shareable link
            if it is not already public. You can unpublish it above at any time, and it
            will not be republished.
          </p>
          {walletPass ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                className={buttonClasses("outline")}
                href={walletPass.googleSaveUrl}
                target="_blank"
                rel="noreferrer"
              >
                Add to Google Wallet
              </a>
              <a
                className={buttonClasses("outline")}
                href={walletPass.shareUrl}
                target="_blank"
                rel="noreferrer"
              >
                Add to Apple Wallet
              </a>
            </div>
          ) : (
            <>
              <Button className="mt-3" variant="outline" onClick={addToWallet} disabled={walletBusy}>
                {walletBusy ? "Working..." : "Add to wallet"}
              </Button>
              {walletUnavailable ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  The wallet badge is not available right now. Your certificate above is
                  unaffected.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}
