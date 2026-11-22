import Dashboard from "@/components/dashboard";
import { isUuid } from "@/lib/utils";

type DashboardPageProps = {
  searchParams?: Promise<{
    contract?: string | string[];
  }>;
};

/** Only the contract's id travels in the URL; the page loads its title from the user's own data. */
function normalizeFocusContractId(
  value: string | string[] | undefined,
): string | undefined {
  const id = Array.isArray(value) ? value[0] : value;
  return isUuid(id) ? id.toLowerCase() : undefined;
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = await searchParams;
  return (
    <Dashboard focusContractId={normalizeFocusContractId(params?.contract)} />
  );
}
