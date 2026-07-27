import { redirect } from "next/navigation";

// The Clinic nav links to the module root (/clinic). After Visit Summary
// is currently the only clinic tool, so send the root straight to it.
export default function ClinicPage() {
  redirect("/clinic/avs");
}
