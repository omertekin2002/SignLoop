"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { capContractSearch } from "@/lib/contract-search";
import { cn } from "@/lib/utils";
import { useWorkspaceList } from "@/lib/use-workspace-list";

export const CONTRACT_SEARCH_DEBOUNCE_MS = 300;

export type SearchableContract = {
  id: string;
  title: string;
  projectId?: string | null;
  /** The project a contract is filed in; only title searches return contracts in projects. */
  projectTitle?: string | null;
};

export type SearchableProject = {
  id: string;
  title: string;
};

export type SearchableChatThread = {
  id: string;
  title: string;
};

/** The search box's text, and the trimmed term it settles on after typing pauses. Clearing is immediate. */
export function useWorkspaceSearch(delay = CONTRACT_SEARCH_DEBOUNCE_MS) {
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

export const useContractSearch = useWorkspaceSearch;

type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
};

/** A labelled search box, capped at the length the API accepts: Escape or the clear button empties it at once. */
export function WorkspaceSearchField({
  label,
  placeholder,
  value,
  onChange,
  onClear,
  compact = false,
}: SearchFieldProps & {
  label: string;
  placeholder: string;
  /** A smaller field for the sidebar, whose label is read by assistive technology only. */
  compact?: boolean;
}) {
  const id = useId();

  return (
    <div className={compact ? "py-1" : "mb-6 max-w-md"}>
      <Label htmlFor={id} className={cn(compact && "sr-only")}>
        {label}
      </Label>
      <div className={cn("relative", !compact && "mt-2")}>
        <Search
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
            compact ? "left-3 h-3.5 w-3.5" : "left-4 h-4 w-4",
          )}
        />
        <Input
          id={id}
          type="search"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          className={cn(
            "[&::-webkit-search-cancel-button]:hidden",
            compact ? "h-8 pl-8 pr-8 md:text-xs" : "pl-10 pr-10",
          )}
          // Capped here, in code points as the API counts; a native maxLength counts UTF-16 code units.
          onChange={(event) => onChange(capContractSearch(event.target.value))}
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
            className={cn(
              "absolute top-1/2 -translate-y-1/2 text-muted-foreground",
              compact ? "right-0.5 h-7 w-7" : "right-1 h-8 w-8",
            )}
            aria-label="Clear search"
            onClick={onClear}
          >
            <X className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ContractSearchField(props: SearchFieldProps) {
  return (
    <WorkspaceSearchField
      label="Search contracts"
      placeholder="Search by title, including contracts in projects"
      {...props}
    />
  );
}

export function ProjectSearchField(props: SearchFieldProps) {
  return (
    <WorkspaceSearchField
      label="Search projects"
      placeholder="Search by project name"
      {...props}
    />
  );
}

export function ChatSearchField(props: SearchFieldProps) {
  return (
    <WorkspaceSearchField
      label="Search chats"
      placeholder="Search chats by title"
      compact
      {...props}
    />
  );
}

type SearchResultsProps = {
  search: string;
  enabled: boolean;
  onClear: () => void;
  renderLoadError: (retry: () => void) => ReactNode;
};

/** Search results across every page of one workspace list, with their own empty and error states. */
export function WorkspaceSearchResults<T>({
  listKey,
  path,
  noun,
  emptyHint,
  search,
  enabled,
  onClear,
  renderItems,
  renderLoadError,
  compact = false,
}: SearchResultsProps & {
  /** The list's query-key prefix, so invalidating the list refreshes its searches too. */
  listKey: string;
  path: string;
  noun: { one: string; many: string };
  emptyHint: ReactNode;
  renderItems: (items: T[]) => ReactNode;
  /** Sidebar-sized states: one line each instead of a page section. */
  compact?: boolean;
}) {
  const list = useWorkspaceList<T>(listKey, path, enabled, search);
  const items = list.data ?? [];
  const total = list.total ?? items.length;

  if (list.isLoadingError) return renderLoadError(() => void list.refetch());

  if (compact) {
    if (list.isLoading) {
      return (
        <p role="status" className="px-3 py-1.5 text-xs text-muted-foreground">
          Searching {noun.many}…
        </p>
      );
    }

    if (items.length === 0) {
      return (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">
          <p role="status" className="break-words">
            No {noun.many} match &ldquo;{search}&rdquo;
          </p>
          <p className="mt-1">{emptyHint}</p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-1 h-auto p-0 text-xs"
            onClick={onClear}
          >
            Clear search
          </Button>
        </div>
      );
    }

    return (
      <>
        <p
          role="status"
          className="break-words px-3 py-1 text-[10px] text-muted-foreground"
        >
          {total === 1
            ? `1 ${noun.one} matches`
            : `${total} ${noun.many} match`}{" "}
          &ldquo;{search}&rdquo;
        </p>
        {renderItems(items)}
        {list.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </>
    );
  }

  if (list.isLoading) {
    return (
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-44 w-full" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[400px] max-w-xl flex-col items-start justify-center">
        <p className="app-eyebrow flex items-center gap-2">
          <Search className="h-4 w-4" />
          No results
        </p>
        <h3 className="mt-4 break-words text-heading-xs md:text-subheading">
          No {noun.many} match &ldquo;{search}&rdquo;
        </h3>
        <p className="app-lede mt-4 max-w-md">{emptyHint}</p>
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
        {total === 1 ? `1 ${noun.one} matches` : `${total} ${noun.many} match`}{" "}
        &ldquo;{search}&rdquo;
      </p>
      {renderItems(items)}
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

/** Title-search results across every contract the owner has, standalone or in a project. */
export function ContractSearchResults<T extends SearchableContract>({
  renderContracts,
  ...props
}: SearchResultsProps & { renderContracts: (contracts: T[]) => ReactNode }) {
  return (
    <WorkspaceSearchResults<T>
      {...props}
      listKey="contracts"
      path="/contracts?standalone=true"
      noun={{ one: "contract", many: "contracts" }}
      emptyHint={
        <>
          Search looks at contract titles, including contracts inside projects.
          Try a shorter or different word.
        </>
      }
      renderItems={renderContracts}
    />
  );
}

/** Name-search results across every page of the owner's projects. */
export function ProjectSearchResults<T extends SearchableProject>({
  renderProjects,
  ...props
}: SearchResultsProps & { renderProjects: (projects: T[]) => ReactNode }) {
  return (
    <WorkspaceSearchResults<T>
      {...props}
      listKey="projects"
      path="/projects"
      noun={{ one: "project", many: "projects" }}
      emptyHint="Search looks at project names. Try a shorter or different word."
      renderItems={renderProjects}
    />
  );
}

/** Title-search results across every page of the owner's saved chats, sized for the sidebar. */
export function ChatSearchResults<T extends SearchableChatThread>({
  renderThreads,
  ...props
}: SearchResultsProps & { renderThreads: (threads: T[]) => ReactNode }) {
  return (
    <WorkspaceSearchResults<T>
      {...props}
      listKey="chat-threads"
      path="/chat/threads"
      noun={{ one: "chat", many: "chats" }}
      emptyHint="Search looks at chat titles. Try a shorter or different word."
      renderItems={renderThreads}
      compact
    />
  );
}
