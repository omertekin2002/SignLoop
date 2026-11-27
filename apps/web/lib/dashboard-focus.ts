import { isClarifyItemKey, type ClarifyItemKey } from "@/lib/clarify-ask";
import { isUuid } from "@/lib/utils";

type SearchParam = string | string[] | undefined;

export type DashboardFocusParams = {
  thread?: SearchParam;
  contract?: SearchParam;
  analysis?: SearchParam;
  ask?: SearchParam;
};

export type DashboardFocus = {
  /** Open this saved chat (from a contract page's list of its chats). */
  focusThreadId?: string;
  /** Open a new saved chat about this contract. */
  focusContractId?: string;
  /** Draft that chat's question from one "Before you sign" item of this analysis. */
  focusAsk?: { analysisId: string; itemKey: ClarifyItemKey };
};

function first(value: SearchParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * What the dashboard's URL may ask for: only ids and a structural item key travel in it, and the
 * page loads everything else from the user's own data. A saved thread's id wins over the rest; a
 * malformed one is dropped. A malformed contract id drops the contract, analysis and key; a
 * malformed analysis id or item key drops both of those, leaving the plain chat about the
 * contract.
 */
export function dashboardFocusFromSearchParams(
  params: DashboardFocusParams | undefined,
): DashboardFocus {
  const thread = first(params?.thread);
  if (isUuid(thread)) return { focusThreadId: thread.toLowerCase() };
  const contract = first(params?.contract);
  if (!isUuid(contract)) return {};
  const focusContractId = contract.toLowerCase();
  const analysis = first(params?.analysis);
  const ask = first(params?.ask);
  return isUuid(analysis) && isClarifyItemKey(ask)
    ? {
        focusContractId,
        focusAsk: { analysisId: analysis.toLowerCase(), itemKey: ask },
      }
    : { focusContractId };
}
