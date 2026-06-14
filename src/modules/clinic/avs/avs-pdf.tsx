import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { LocalizedSummary, SummaryItem } from "./types";

const BRAND = "#00356b";
const INK = "#1c2b2d";
const MUTED = "#5c7073";

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, color: INK, fontFamily: "Helvetica", lineHeight: 1.5 },
  header: { borderBottomWidth: 2, borderBottomColor: BRAND, paddingBottom: 8, marginBottom: 14 },
  docTitle: { fontSize: 16, color: BRAND, fontFamily: "Helvetica-Bold" },
  headerName: { fontSize: 12, marginTop: 2 },
  headerDate: { fontSize: 10, color: MUTED, marginTop: 2 },
  block: { marginBottom: 14 },
  heading: {
    fontSize: 8,
    letterSpacing: 1,
    color: BRAND,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    borderBottomWidth: 1,
    borderBottomColor: "#dde8e9",
    paddingBottom: 3,
    marginBottom: 6,
  },
  item: { marginBottom: 6 },
  label: { fontSize: 8, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 1 },
  value: { fontSize: 10 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  tag: { backgroundColor: "#e6f0f5", color: BRAND, fontSize: 9, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4 },
  listItem: { flexDirection: "row", marginBottom: 2 },
  bullet: { width: 10, fontSize: 10 },
  medRow: { borderBottomWidth: 1, borderBottomColor: "#eef1f5", paddingBottom: 4, marginBottom: 4 },
  medName: { fontSize: 10, fontFamily: "Helvetica-Bold" },
  medDetail: { fontSize: 9, color: MUTED },
  footer: { marginTop: 18, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#dde8e9", fontSize: 8, color: MUTED },
});

function Item({ item }: { item: SummaryItem }) {
  if (item.kind === "text") {
    return (
      <View style={styles.item}>
        <Text style={styles.label}>{item.label}</Text>
        <Text style={styles.value}>{item.value}</Text>
      </View>
    );
  }
  if (item.kind === "tags") {
    return (
      <View style={styles.item}>
        <Text style={styles.label}>{item.label}</Text>
        <View style={styles.tagRow}>
          {item.values.map((v, i) => (
            <Text key={i} style={styles.tag}>
              {v}
            </Text>
          ))}
        </View>
      </View>
    );
  }
  if (item.kind === "list") {
    return (
      <View style={styles.item}>
        <Text style={styles.label}>{item.label}</Text>
        {item.values.map((v, i) => (
          <View key={i} style={styles.listItem}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.value}>{v}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (item.kind === "meds") {
    return (
      <View style={styles.item}>
        {item.meds.map((m, i) => (
          <View key={i} style={styles.medRow}>
            <Text style={styles.medName}>{m.name}</Text>
            {m.dose.trim() ? <Text style={styles.medDetail}>{m.dose}</Text> : null}
            {m.costSource.trim() ? <Text style={styles.medDetail}>{m.costSource}</Text> : null}
          </View>
        ))}
      </View>
    );
  }
  const _exhaustive: never = item;
  return _exhaustive;
}

export function AvsDocument({ summary }: { summary: LocalizedSummary }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.docTitle}>{summary.docTitle}</Text>
          {summary.headerName ? <Text style={styles.headerName}>{summary.headerName}</Text> : null}
          {summary.visitDateValue ? (
            <Text style={styles.headerDate}>
              {summary.visitDateLabel}: {summary.visitDateValue}
            </Text>
          ) : null}
        </View>
        {summary.blocks.map((b, i) => (
          <View key={i} style={styles.block} wrap={false}>
            <Text style={styles.heading}>{b.heading}</Text>
            {b.items.map((item, j) => (
              <Item key={j} item={item} />
            ))}
          </View>
        ))}
        <Text style={styles.footer}>{summary.disclaimer}</Text>
      </Page>
    </Document>
  );
}
