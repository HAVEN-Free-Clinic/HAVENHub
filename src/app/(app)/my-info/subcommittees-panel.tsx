import Link from "next/link";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";

/** The person's subcommittees on My Info, with the way in to the sign-up page. */
export function MySubcommitteesPanel({
  subcommittees,
  signupOpen,
}: {
  subcommittees: Array<{ id: string; name: string; role: "LEAD" | "MEMBER" }>;
  signupOpen: boolean;
}) {
  return (
    <Card className="space-y-3">
      {subcommittees.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {subcommittees.map((s) => (
            <li key={s.id}>
              <Badge tone={s.role === "LEAD" ? "brand" : "default"}>
                {s.name}
                {s.role === "LEAD" ? " (lead)" : ""}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-foreground-soft">
          You are not on a subcommittee yet. Subcommittees help run HAVEN beyond clinic shifts.
        </p>
      )}
      <Link href="/my-info/subcommittees" className={buttonClasses(signupOpen ? "primary" : "outline", "sm")}>
        {signupOpen ? "Browse and join subcommittees" : "View subcommittees"}
      </Link>
    </Card>
  );
}
