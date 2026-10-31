"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { MAX_CONTRACT_SEARCH_LENGTH } from "@/lib/contract-search";
import { useWorkspaceList } from "@/lib/use-workspace-list";

export const CONTRACT_SEARCH_DEBOUNCE_MS = 300;

export type SearchableContract = {
  id: string;
  title: string;
  projectId?: string | null;
  /** The project a contract is filed in; only title searches return contracts in projects. */
  projectTitle?: string | null;
};

/** The search box's text, and the trimmed term it settles on after typing pauses. Clearing is immediate. */
export function useContractSearch(delay = CONTRACT_SEARCH_DEBOUNCE_MS) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const next = input.trim();
    if (next === search) return;
    const timer = setTimeout(() => setSearch(next), delay);
    return () => clearTimeout(timer);
  }, [delay, input, search]);

  const clear = useCallback(() => {
    setInput("");
    setSearch("");
  }, []);

  return { input, setInput, search, clear };
}

export function ContractSearchField({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const id = useId();

  return (
    <div className="mb-6 max-w-md">
      <Label htmlFor={id}>Search contracts</Label>
      <div className="relative mt-2">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={id}
          type="search"
          value={value}
          maxLength={MAX_CONTRACT_SEARCH_LENGTH}
          placeholder="Search by title, including contracts in projects"
          autoComplete="off"
          className="pl-10 pr-10 [&::-webkit-search-cancel-button]:hidden"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value) {
              event.preventDefault();
              onClear();
            }
          }}
        />
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground"
            aria-label="Clear search"
            onClick={onClear}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Title-search results across every contract the owner has, with their own empty and error states. */
export function ContractSearchResults<T extends SearchableContract>({
  search,
  enabled,
  onClear,
  renderContracts,
  renderLoadError,
}: {
  search: string;
  enabled: boolean;
  onClear: () => void;
  renderContracts: (contracts: T[]) => ReactNode;
  renderLoadError: (retry: () => void) => ReactNode;
}) {
  const list = useWorkspaceList<T>(
    "contracts",
    "/contracts?standalone=true",
    enabled,
    search,
  );
  const contracts = list.data ?? [];
  const total = list.total ?? contracts.length;

  if (list.isLoadingError) return renderLoadError(() => void list.refetch());

  if (list.isLoading) {
    return (
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-44 w-full" />
        ))}
      </div>
    );
  }

  if (contracts.length === 0) {
    return (
      <div className="flex min-h-[400px] max-w-xl flex-col items-start justify-center">
        <p className="app-eyebrow flex items-center gap-2">
          <Search className="h-4 w-4" />
          No results
        </p>
        <h3 className="mt-4 break-words text-heading-xs md:text-subheading">
          No contracts match &ldquo;{search}&rdquo;
        </h3>
        <p className="app-lede mt-4 max-w-md">
          Search looks at contract titles, including contracts inside projects.
          Try a shorter or different word.
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-8"
          onClick={onClear}
        >
          Clear search
        </Button>
      </div>
    );
  }

  return (
    <>
      <p role="status" className="mb-6 text-sm text-muted-foreground">
        {total === 1 ? "1 contract matches" : `${total} contracts match`}{" "}
        &ldquo;{search}&rdquo;
      </p>
      {renderContracts(contracts)}
      {list.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-6"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </>
  );
}
