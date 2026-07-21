import type { ContractLayout } from "../layout";

// PLACEHOLDER: this is a minimal stand-in so the defaults module compiles and
// its tests run. Task 11 replaces this wholesale with the real director
// layout (full department block list + shared prose bodies). Do not build on
// this content; it exists only to keep the two-tier contract and the
// defaults/index.test.ts assertions satisfied until Task 11 lands.
export const DIRECTOR_LAYOUT: ContractLayout = {
  blocks: [
    { kind: "section", id: "intro", title: "Placeholder section", body: "Placeholder section body." },
    { kind: "system_field", systemKey: "name" },
    { kind: "system_field", systemKey: "email" },
    { kind: "system_field", systemKey: "netId" },
    { kind: "system_field", systemKey: "phone" },
    { kind: "system_field", systemKey: "dob" },
    { kind: "system_field", systemKey: "dietary" },
    { kind: "system_field", systemKey: "yaleAffiliation" },
    { kind: "system_field", systemKey: "gradYear" },
    { kind: "agreement", id: "agreement", title: "Volunteer agreement", body: "Placeholder agreement body.", signatureLabel: "type your full name" },
    { kind: "agreement", id: "professionalism", title: "Professionalism policy", body: "Placeholder agreement body.", signatureLabel: "type your full name" },
    { kind: "agreement", id: "data_privacy", title: "Data privacy acknowledgement", body: "Placeholder agreement body.", signatureLabel: "type your full name" },
    { kind: "agreement", id: "training", title: "Training acknowledgement", body: "Placeholder agreement body.", signatureLabel: "type your full name" },
    { kind: "system_field", systemKey: "initials" },
    { kind: "system_field", systemKey: "epic" },
    { kind: "system_field", systemKey: "licensedRN" },
    { kind: "system_field", systemKey: "hipaa" },
  ],
};
