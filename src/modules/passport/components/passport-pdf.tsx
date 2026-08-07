import { Fragment } from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ServiceRecord, ServiceTermRow } from "../services/service-record";

const INK = "#1c2b2d";
const MUTED = "#5c7073";
const RULE = "#d8e0e1";

/**
 * A term with no shift records must never read as a zero. "Not recorded" says
 * the clinic was not counting; "0 scheduled" says the member held no shifts.
 * Collapsing the two would understate a long-serving member on a document that
 * goes to residency programs.
 */
export function formatShifts(shifts: number | null): string {
  return shifts === null ? "Not recorded" : `${shifts} scheduled`;
}

function trackLabel(track: ServiceTermRow["track"]): string {
  return track === "DIRECTOR" ? "Director" : "Volunteer";
}

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, color: INK, fontFamily: "Helvetica" },
  org: { fontSize: 9, letterSpacing: 1, color: MUTED, textTransform: "uppercase" },
  title: { fontSize: 20, marginTop: 6, marginBottom: 2 },
  name: { fontSize: 15, marginTop: 14 },
  since: { fontSize: 10, color: MUTED, marginTop: 2 },
  sectionHeading: { fontSize: 9, letterSpacing: 1, color: MUTED, textTransform: "uppercase", marginTop: 24, marginBottom: 6 },
  headRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 4 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: RULE, paddingVertical: 6 },
  cTerm: { width: "34%" },
  cDept: { width: "30%" },
  cRole: { width: "18%" },
  cShifts: { width: "18%", textAlign: "right" },
  provenance: { fontSize: 8, color: MUTED },
  note: { fontSize: 8, color: MUTED, marginTop: 16, lineHeight: 1.5 },
  footer: { position: "absolute", bottom: 36, left: 48, right: 48, fontSize: 8, color: MUTED },
});

export function PassportDocument({
  record,
  orgName,
  brandColor,
  credentialUrl,
}: {
  record: ServiceRecord;
  orgName: string;
  brandColor: string;
  credentialUrl: string | null;
}) {
  const issued = new Date(record.generatedAt).toISOString().slice(0, 10);
  const capabilities = [
    record.capabilities.spanishVerified ? "Spanish (verified by the interpreting department)" : null,
    record.capabilities.licensedRN ? "Licensed RN (self-reported)" : null,
  ].filter((c): c is string => Boolean(c));

  return (
    <Document title={`Service record for ${record.name}`}>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.org}>{orgName}</Text>
        <Text style={{ ...styles.title, color: brandColor }}>Record of Service</Text>

        <Text style={styles.name}>{record.name}</Text>
        {record.memberSince ? (
          <Text style={styles.since}>Member since {record.memberSince.label}</Text>
        ) : null}

        <Text style={styles.sectionHeading}>Service history</Text>
        <View style={styles.headRow}>
          <Text style={styles.cTerm}>Term</Text>
          <Text style={styles.cDept}>Department</Text>
          <Text style={styles.cRole}>Role</Text>
          <Text style={styles.cShifts}>Clinic shifts</Text>
        </View>
        {record.terms.length === 0 ? (
          <View style={styles.row}>
            <Text style={styles.provenance}>No service recorded.</Text>
          </View>
        ) : (
          record.terms.map((row) => (
            <Fragment key={`${row.source}-${row.termCode}`}>
              <View style={styles.row}>
                <View style={styles.cTerm}>
                  <Text>{row.termName}</Text>
                  {row.source === "RECRUITMENT" ? (
                    <Text style={styles.provenance}>Joined via recruitment</Text>
                  ) : null}
                </View>
                <Text style={styles.cDept}>{row.departmentName}</Text>
                <Text style={styles.cRole}>{trackLabel(row.track)}</Text>
                <Text style={styles.cShifts}>{formatShifts(row.shifts)}</Text>
              </View>
            </Fragment>
          ))
        )}

        {capabilities.length > 0 ? (
          <Fragment>
            <Text style={styles.sectionHeading}>Verified capabilities</Text>
            {capabilities.map((c) => (
              <Text key={c}>{c}</Text>
            ))}
          </Fragment>
        ) : null}

        <Text style={styles.note}>
          Clinic shift counts reflect published schedule assignments, not attendance. Terms marked
          &quot;Not recorded&quot; predate {orgName}&apos;s scheduling records and carry no shift count;
          this reflects the clinic&apos;s record-keeping history, not the member&apos;s service.
        </Text>

        <Text style={styles.footer} fixed>
          Issued {issued} by {orgName}.
          {credentialUrl ? ` Verify at ${credentialUrl}` : ""}
        </Text>
      </Page>
    </Document>
  );
}
