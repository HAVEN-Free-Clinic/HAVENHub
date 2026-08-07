"use client";

import { useState } from "react";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import type { IssuedCredential } from "../services/credential";

export function ServiceRecordCard({
  orgName,
  brandColor,
  baseUrl,
  initialToken,
  issue,
  publish,
  unpublish,
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
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(initialToken);
  const [publishBusy, setPublishBusy] = useState(false);

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
            <p className="text-sm">
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
    </Card>
  );
}
