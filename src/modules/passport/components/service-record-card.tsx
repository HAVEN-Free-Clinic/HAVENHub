"use client";

import { useState } from "react";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import type { IssuedCredential } from "../services/credential";

export function ServiceRecordCard({
  orgName,
  brandColor,
  issue,
}: {
  orgName: string;
  brandColor: string;
  /** Server action: freezes the record and returns the snapshot. */
  issue: () => Promise<IssuedCredential>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          credentialUrl={null}
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
    </Card>
  );
}
