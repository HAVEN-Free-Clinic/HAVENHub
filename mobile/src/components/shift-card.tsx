import { View } from "react-native";
import { Body, Card, Pill, Title } from "@/components/ui";
import type { Shift } from "@/lib/api";
import { formatClinicDateLong } from "@/lib/dates";

const ROLE_LABEL: Record<Shift["role"], string> = { VOLUNTEER: "Volunteer", SHADOW: "Shadow", DIRECTOR: "Director" };

export function ShiftCard({ shift }: { shift: Shift }) {
  return (
    <Card>
      <Title>{formatClinicDateLong(shift.date)}</Title>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Body>{shift.departmentName}</Body>
        <Pill>{ROLE_LABEL[shift.role]}</Pill>
        {shift.clinicClosed ? <Pill tone="warning">Clinic closed</Pill> : null}
      </View>
      {shift.clinicClosed && shift.closedNote ? <Body muted>{shift.closedNote}</Body> : null}
      {shift.attendings.length ? (
        <Body muted>
          Attending: {shift.attendings.map((a) => `${a.name} (${a.slotLabel})`).join(", ")}
        </Body>
      ) : !shift.clinicClosed ? (
        <Body muted>Attending not announced yet</Body>
      ) : null}
    </Card>
  );
}
