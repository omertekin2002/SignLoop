import Dashboard from "@/components/dashboard";
import {
  dashboardFocusFromSearchParams,
  type DashboardFocusParams,
} from "@/lib/dashboard-focus";

type DashboardPageProps = {
  searchParams?: Promise<DashboardFocusParams>;
};

/**
 * Only ids (and a "Before you sign" item's structural key) travel in the URL; the page loads the
 * thread, the contract's title and the item from the user's own data, and drops anything malformed.
 */
export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const { focusThreadId, focusContractId, focusAsk } =
    dashboardFocusFromSearchParams(await searchParams);
  return (
    <Dashboard
      focusThreadId={focusThreadId}
      focusContractId={focusContractId}
      focusAsk={focusAsk}
    />
  );
}
