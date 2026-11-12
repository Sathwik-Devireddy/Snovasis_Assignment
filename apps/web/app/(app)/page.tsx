/**
 * Dashboard — redirects to the accounts list (PHASE-11 P11.3).
 * Route groups add no URL segments: the real path is /accounts.
 */

import { redirect } from "next/navigation";

export default function Page() {
  redirect("/accounts");
}
