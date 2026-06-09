import { getContractByToken } from "@/modules/recruitment/services/onboarding";
import { OnboardForm } from "./onboard-form";

export default async function OnboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const contract = await getContractByToken(token);
  if (!contract || contract.status !== "PENDING") {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">This onboarding form is not available</h1>
        <p className="mt-2 text-slate-500">The link may be invalid or already completed.</p>
      </main>
    );
  }
  const prefill = { firstName: contract.firstName, lastName: contract.lastName, email: contract.email, netId: contract.netId ?? "", phone: contract.phone ?? "" };
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">HAVEN onboarding</h1>
      <OnboardForm token={contract.token} prefill={prefill} />
    </main>
  );
}
