import { DashboardShell } from "./dashboard-shell";

/**
 * Server-component layout that opts all dashboard routes out of static
 * prerendering.  The actual chrome lives in the client-side DashboardShell.
 */
export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardShell>{children}</DashboardShell>;
}
