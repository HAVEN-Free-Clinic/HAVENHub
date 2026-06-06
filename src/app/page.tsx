import { redirect } from "next/navigation";
import { auth } from "@/platform/auth/auth";

export default async function Home() {
  const session = await auth();
  redirect(session?.personId ? "/hub" : "/login");
}
