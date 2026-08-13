import { Fragment } from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
// ../services/service-record-format, not ../services/service-record: this
// component renders through a "use client" card, so a runtime import from the
// service module would pull prisma and the notification sender into the browser
// bundle. Only `next build` catches that; typecheck and vitest pass.
import { formatShiftsAndHours, formatServiceDates, trackLabel, type ServiceRecord } from "../services/service-record-format";
// ./catalog, not "@/platform/languages": this component is reached from a
// "use client" card (service-record-card), and the index module imports prisma
// and notify. Importing it here pulls the whole server graph into the browser
// bundle, which typecheck and vitest both pass but `next build` rejects.
import { languageLabel } from "@/platform/languages/catalog";

const INK = "#1c2b2d";
const MUTED = "#5c7073";
const RULE = "#d8e0e1";

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
    // One line per verified language. Absent on credentials issued before
    // languages were generalized, which reads the same as none.
    ...(record.capabilities.verifiedLanguages ?? []).map(
      (code) => `${languageLabel(code)} (verified by the interpreting department)`,
    ),
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
            // Department is part of the key: a member in two departments in one
            // term produces two rows with the same source and term code.
            <Fragment key={`${row.source}-${row.termCode}-${row.departmentName}`}>
              <View style={styles.row}>
                <View style={styles.cTerm}>
                  <Text>{row.termName}</Text>
                  {row.source === "RECRUITMENT" ? (
                    <Text style={styles.provenance}>Joined via recruitment</Text>
                  ) : null}
                  {/* Dates hang under the term, where the column is widest.
                      Reuses the provenance style: same role, a quiet secondary
                      line. Empty string when unknown, so nothing renders. */}
                  {formatServiceDates(row.dates) ? (
                    <Text style={styles.provenance}>{formatServiceDates(row.dates)}</Text>
                  ) : null}
                </View>
                <Text style={styles.cDept}>{row.departmentName}</Text>
                <Text style={styles.cRole}>{trackLabel(row.track)}</Text>
                <Text style={styles.cShifts}>{formatShiftsAndHours(row.shifts, row.hours)}</Text>
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
