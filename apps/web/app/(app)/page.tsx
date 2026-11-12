/**
 * Dashboard — redirects to accounts list (PHASE-10 P11.3).
 */

import { redirect } from "next/navigation";

export default function Page() {
  redirect("/app/accounts");
}
