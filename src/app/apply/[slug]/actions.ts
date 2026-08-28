"use server";
import {
  submitApplication, CycleNotOpenError, DuplicateApplicationError, SubmissionValidationError,
  type UploadedFile,
} from "@/modules/recruitment/services/submissions";
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";
import { auth } from "@/platform/auth/auth";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { captureEvent } from "@/platform/posthog/capture";
import { termGroupForCycleSlug } from "@/platform/posthog/groups";

export type SubmitResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

export async function submitPublicApplication(slug: string, formData: FormData): Promise<SubmitResult> {
  const rawType = String(formData.get("__applicantType") ?? "NEW");
  const applicantType: ApplicantType = rawType === "RENEWAL" ? "RENEWAL" : rawType === "TRANSFER" ? "TRANSFER" : "NEW";
  const renewalDepartment = String(formData.get("__renewalDepartment") ?? "") || undefined;

  const answers: Record<string, unknown> = {};
  const files: Record<string, UploadedFile> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("__")) continue;
    if (value instanceof File) {
      if (value.size > 0) files[key] = { fileName: value.name, mimeType: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
    } else {
      if (key in answers) {
        const prev = answers[key];
        answers[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
      } else {
        answers[key] = value;
      }
    }
  }

  const session = await auth();
  const identity = await getApplicantIdentity();
  if (!identity) {
    // The apply page redirects unauthenticated visitors, but this server action is a
    // directly-callable endpoint, so we re-enforce the identity gate here. Without a
    // verified portal identity (Yale SSO or a magic-link cookie) we refuse the
    // submission rather than trust a client-supplied email (spoofing / dedup squatting).
    return { ok: false, message: "Please verify your email before submitting your application." };
  }

  try {
    await submitApplication(slug, {
      applicantType, renewalDepartment, answers, files,
      sessionPersonId: session?.personId ?? null,
      // Use the resolved portal identity's verified email, not the raw OAuth claim.
      // The member magic-link provider returns only { id: personId }, so
      // session.user.email is permanently undefined for every non-Yale member -- and
      // the returning-applicant path in submitApplication requires sessionEmail, so a
      // member the wizard told was eligible to renew hit "Please sign in with Yale"
      // (#55). identity.email is the address Person.contactEmail for magic-link, the
      // verified Entra claim otherwise, and is guaranteed present past the gate above.
      sessionEmail: session?.user?.email ?? identity.email,
      identityEmail: identity.email,
      // The raw Entra claims, kept separate from the two resolved addresses above:
      // they are what lets submitApplication recognize a returning member whose
      // Person the session refused to carry, and they must come from SSO rather
      // than the magic-link cookie. See resolveReturningPersonId.
      sso: session?.applicantEmail ? { upn: session.applicantUpn, email: session.applicantEmail } : null,
    });
    const distinctId = session?.personId ?? identity?.email ?? slug;
    await captureEvent({
      distinctId,
      event: "application_submitted",
      properties: {
        slug,
        applicant_type: applicantType,
        renewal_department: renewalDepartment ?? null,
      },
      groups: await termGroupForCycleSlug(slug),
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof SubmissionValidationError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof DuplicateApplicationError) return { ok: false, message: err.message };
    if (err instanceof CycleNotOpenError) return { ok: false, message: err.message };
    throw err;
  }
}
