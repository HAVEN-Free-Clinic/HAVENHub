import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { LocalizedSummary, SummaryItem } from "./types";

/** Default brand color (Yale Blue) used when no resolved setting is threaded in. */
const DEFAULT_BRAND = "#00356b";
const INK = "#1c2b2d";
const MUTED = "#5c7073";

/**
 * Mix a `#rrggbb` hex toward white. `strength` is the share of the brand color
 * kept (0 = white, 1 = the color unchanged). @react-pdf has no color-mix(), so
 * the faint chip wash is computed here instead of in CSS.
 */
export function tint(hex: string, strength: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c: number) => Math.round(c * strength + 255 * (1 - strength));
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

/**
 * Build the AVS stylesheet from a resolved brand color. Every brand-dependent
 * surface (header rule, doc title, section headings, tag chips) derives from
 * `brand` so an admin's `branding.brandColor` change propagates to the PDF.
 */
export function createAvsStyles(brand: string) {
  return StyleSheet.create({
    page: { padding: 36, fontSize: 10, color: INK, fontFamily: "Helvetica", lineHeight: 1.5 },
    header: { borderBottomWidth: 2, borderBottomColor: brand, paddingBottom: 8, marginBottom: 14 },
    docTitle: { fontSize: 16, color: brand, fontFamily: "Helvetica-Bold" },
    headerName: { fontSize: 12, marginTop: 2 },
    headerDate: { fontSize: 10, color: MUTED, marginTop: 2 },
    block: { marginBottom: 14 },
    heading: {
      fontSize: 8,
      letterSpacing: 1,
      color: brand,
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
    tag: { backgroundColor: tint(brand, 0.12), color: brand, fontSize: 9, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4 },
    listItem: { flexDirection: "row", marginBottom: 2 },
    bullet: { width: 10, fontSize: 10 },
    medRow: { borderBottomWidth: 1, borderBottomColor: "#eef1f5", paddingBottom: 4, marginBottom: 4 },
    medName: { fontSize: 10, fontFamily: "Helvetica-Bold" },
    medDetail: { fontSize: 9, color: MUTED },
    footer: { marginTop: 18, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#dde8e9", fontSize: 8, color: MUTED },
  });
}

type AvsStyles = ReturnType<typeof createAvsStyles>;

function Item({ item, styles }: { item: SummaryItem; styles: AvsStyles }) {
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

export function AvsDocument({
  summary,
  brandColor = DEFAULT_BRAND,
}: {
  summary: LocalizedSummary;
  brandColor?: string;
}) {
  const styles = createAvsStyles(brandColor);
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
              <Item key={j} item={item} styles={styles} />
            ))}
          </View>
        ))}
        <Text style={styles.footer}>{summary.disclaimer}</Text>
      </Page>
    </Document>
  );
}
