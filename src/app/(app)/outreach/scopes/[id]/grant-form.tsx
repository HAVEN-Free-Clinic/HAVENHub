"use client";

import { useState } from "react";
import { Button } from "@/platform/ui/button";
import { Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";

type Option = { id: string; name: string };

export function GrantForm({
  action,
  people,
  roles,
}: {
  action: (formData: FormData) => Promise<void>;
  people: Option[];
  roles: Option[];
}) {
  const [personId, setPersonId] = useState("");
  const [roleId, setRoleId] = useState("");

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <Field label="Grant to a person">
        <Select
          name="personId"
          value={personId}
          onChange={(e) => {
            setPersonId(e.target.value);
            if (e.target.value) setRoleId("");
          }}
        >
          <option value="">None</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="or a role">
        <Select
          name="roleId"
          value={roleId}
          onChange={(e) => {
            setRoleId(e.target.value);
            if (e.target.value) setPersonId("");
          }}
        >
          <option value="">None</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={!personId && !roleId}>Grant</Button>
    </form>
  );
}
