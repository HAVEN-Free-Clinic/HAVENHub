import { redirect } from "next/navigation";

/**
 * Subcommittees moved to /recruitment/subcommittees: they are recruitment setup
 * (applicants rank them, the cycle's Subcommittees tab assigns them), parked in
 * Admin. This route stays so bookmarks and old links keep working.
 */
export default function SubcommitteesMovedRedirect() {
  redirect("/recruitment/subcommittees");
}
