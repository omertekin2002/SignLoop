"use client";

import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Loader2, PenLine, RefreshCw } from "lucide-react";
import type { ClarifyChecklist } from "@/lib/analysis-clarify";
import {
  CLARIFY_DECISION_LABEL_MAX_CHARACTERS,
  CLARIFY_DECISION_REASON_MAX_CHARACTERS,
  CLARIFY_DECISION_STATES,
  type ClarifyDecisionState,
} from "@/lib/clarify-decisions";
import {
  analysisSourceRevision,
  clarifyChecklistKeys,
  matchClarifyDecisions,
  type ClarifyChecklistKeys,
} from "@/lib/clarify-keys";
import type { AnalysisResult } from "@/lib/schemas";
import { invalidateAfterWrite } from "@/lib/invalidate-after-write";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The owner's own decisions on "Before you sign" items (`/api/contracts/:id/decisions`). They are
 * stored apart from every analysis and are never sent to a model: nothing here changes the
 * checklist, its order, its severities or its Ask links. A decision shows on its item only when
 * `matchClarifyDecisions` attaches it (same source revision, one unambiguous item); every other one
 * is listed under "Decisions from earlier analyses", never re-attached by guessing.
 */

/** A decision as `GET /api/contracts/:id/decisions` returns it (`ClarifyDecisionRecord`). */
export type StoredClarifyDecision = {
  id: string;
  contractId: string;
  analysisId: string | null;
  itemKey: string;
  sourceRevision: string;
  state: ClarifyDecisionState;
  reason: string;
  itemLabel: string;
  createdAt: string;
  updatedAt: string;
};

export type ClarifyDecisionGroup = keyof ClarifyChecklistKeys;

/** What the checklist needs to name one keyed item. */
export type ClarifyDecisionItem = {
  group: ClarifyDecisionGroup;
  index: number;
  /** The item's visible wording, saved with the decision so it can be shown once the item is gone. */
  label: string;
  /** A short name for accessible labels ("finding: Auto-renewal", "question 1"). */
  name: string;
};

export type ClarifyDecisionsView = {
  /** The item's decision control, a line saying why it has none, or null. */
  control: (item: ClarifyDecisionItem) => ReactNode;
  /** Loading, load-failure and no-revision messages, shown once above the checklist. */
  notice: ReactNode;
  /** "Decisions from earlier analyses", or null when there are none. */
  earlier: ReactNode;
};

export const CLARIFY_DECISION_STATE_LABELS: Record<ClarifyDecisionState, string> = {
  resolved: "Resolved",
  accepted: "Accepted",
  open: "Still open",
};

export const AMBIGUOUS_ITEM_LINE =
  "Appears more than once in this analysis, so a decision can't be attached.";
export const NO_REVISION_HINT =
  "This analysis was saved before quotations were checked, so decisions can't be attached to its items. Re-run the analysis to record them.";
const LOAD_ERROR = "Your decisions could not be loaded. They have not been lost.";
const SAVE_ERROR = "Your decision could not be saved. Your text is still here, so try again.";
const REMOVE_ERROR = "Your decision could not be removed. Try again.";
const SESSION_ENDED = "Your session has ended. Sign in again to change your decisions.";
const STALE_ITEM =
  "This item is no longer on the analysis shown, perhaps because it was re-run in another tab. The page has been refreshed.";
// The character count appears once a reason reaches 80% of its limit.
const COUNT_FROM = Math.floor(CLARIFY_DECISION_REASON_MAX_CHARACTERS * 0.8);

export const decisionsKey = (contractId: string) => ["clarify-decisions", contractId] as const;

/** Length in Unicode code points, as the API and migration 025 count it. */
function codePoints(value: string): number {
  return [...value].length;
}

/** The item's wording as a label the API accepts: no NUL, trimmed, at most the label limit. */
export function decisionItemLabel(label: string, fallback: string): string {
  const clean = label.replaceAll("\u0000", "").replace(/\s+/g, " ").trim() || fallback;
  return [...clean].slice(0, CLARIFY_DECISION_LABEL_MAX_CHARACTERS).join("").trim();
}

class DecisionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DecisionRequestError";
  }
}

async function fetchDecisions(
  contractId: string,
  signal: AbortSignal,
): Promise<StoredClarifyDecision[]> {
  const response = await fetch(`/api/contracts/${contractId}/decisions`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new DecisionRequestError(LOAD_ERROR, response.status);
  const payload = (await response.json()) as { decisions?: StoredClarifyDecision[] };
  return Array.isArray(payload.decisions) ? payload.decisions : [];
}

type WriteResult =
  | { status: "saved"; decision: StoredClarifyDecision }
  | { status: "removed" }
  /** Another tab changed it first; `decision` is what is stored now, or null when it is gone. */
  | { status: "conflict"; decision: StoredClarifyDecision | null }
  /** The key no longer names an item of that analysis (422). */
  | { status: "stale"; message: string };

async function conflictOrStale(response: Response): Promise<WriteResult | null> {
  if (response.status !== 409 && response.status !== 422) return null;
  const payload = (await response.json().catch(() => null)) as {
    decision?: StoredClarifyDecision | null;
  } | null;
  if (response.status === 409) return { status: "conflict", decision: payload?.decision ?? null };
  return { status: "stale", message: STALE_ITEM };
}

async function putDecision(
  contractId: string,
  body: {
    analysisId: string;
    itemKey: string;
    state: ClarifyDecisionState;
    reason: string;
    itemLabel: string;
    expectedUpdatedAt: string | null;
  },
): Promise<WriteResult> {
  const response = await fetch(`/api/contracts/${contractId}/decisions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const special = await conflictOrStale(response);
  if (special) return special;
  if (!response.ok) {
    throw new DecisionRequestError(response.status === 401 ? SESSION_ENDED : SAVE_ERROR, response.status);
  }
  return { status: "saved", decision: (await response.json()) as StoredClarifyDecision };
}

async function deleteDecision(
  contractId: string,
  decision: StoredClarifyDecision,
): Promise<WriteResult> {
  const response = await fetch(`/api/contracts/${contractId}/decisions/${decision.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: decision.updatedAt }),
  });
  // Already gone: removing it again would change nothing.
  if (response.status === 404) return { status: "removed" };
  const special = await conflictOrStale(response);
  if (special) return special;
  if (!response.ok) {
    throw new DecisionRequestError(response.status === 401 ? SESSION_ENDED : REMOVE_ERROR, response.status);
  }
  return { status: "removed" };
}

/** Puts `decision` in the cached list in place of the stored row with its id, or adds it. */
function storeInCache(queryClient: QueryClient, contractId: string, decision: StoredClarifyDecision) {
  queryClient.setQueryData<StoredClarifyDecision[]>(decisionsKey(contractId), (list) => {
    if (!list) return list;
    return list.some((each) => each.id === decision.id)
      ? list.map((each) => (each.id === decision.id ? decision : each))
      : [...list, decision];
  });
}

function dropFromCache(queryClient: QueryClient, contractId: string, id: string) {
  queryClient.setQueryData<StoredClarifyDecision[]>(decisionsKey(contractId), (list) =>
    list?.filter((each) => each.id !== id),
  );
}

/** Applies a write's outcome to the cached list; a conflict's stored row only on "Reload". */
function useDecisionWrites(contractId: string) {
  const queryClient = useQueryClient();
  /**
   * Applies `change` to the cached list. A list read still in flight (say, another item's reload)
   * started before this write and would land over it, so it is cancelled first and the list is
   * fetched again afterwards; `refetch` fetches again in any case.
   */
  const writeThrough = async (change: () => void, refetch: boolean) => {
    const key = decisionsKey(contractId);
    const inFlight = queryClient.isFetching({ queryKey: key, exact: true }) > 0;
    if (inFlight) await queryClient.cancelQueries({ queryKey: key, exact: true });
    change();
    if (inFlight || refetch) await invalidateAfterWrite(queryClient, key);
  };
  const apply = async (result: WriteResult, removedId?: string) => {
    if (result.status === "saved") {
      await writeThrough(() => storeInCache(queryClient, contractId, result.decision), false);
    } else if (result.status === "removed" && removedId) {
      await writeThrough(() => dropFromCache(queryClient, contractId, removedId), false);
    } else if (result.status === "stale") {
      // The analysis shown was replaced elsewhere: reload it and the decisions.
      await invalidateAfterWrite(queryClient, decisionsKey(contractId), ["contract", contractId]);
    }
  };
  /** Shows what a 409 returned as stored, then refetches the whole list. */
  const reload = (stored: StoredClarifyDecision | null, replacedId: string | null) =>
    void writeThrough(() => {
      if (stored) storeInCache(queryClient, contractId, stored);
      else if (replacedId) dropFromCache(queryClient, contractId, replacedId);
    }, true);
  return { apply, reload };
}

function StateLabel({ state }: { state: ClarifyDecisionState }) {
  return (
    <span className="rounded-tag border border-input px-2 py-0.5 text-xs text-foreground">
      {CLARIFY_DECISION_STATE_LABELS[state]}
    </span>
  );
}

/** A stored decision's state, reason and save time, marked as the person's own words. */
function DecisionSummary({ decision }: { decision: StoredClarifyDecision }) {
  return (
    <>
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Your decision:</span>
        <StateLabel state={decision.state} />
        <span className="text-caption text-muted-foreground">
          Saved {formatDate(decision.updatedAt, "MMM d, HH:mm")}
        </span>
      </p>
      {decision.reason ? (
        <p className="whitespace-pre-wrap break-words text-foreground">{decision.reason}</p>
      ) : null}
    </>
  );
}

/** The box a 409 shows: the decision as stored now (or that it is gone), and a way to reload it. */
function ConflictBox({
  stored,
  verb,
  onReload,
}: {
  stored: StoredClarifyDecision | null;
  verb: "saved" | "removed";
  onReload: () => void;
}) {
  return (
    <div className="space-y-2 rounded-card border border-input px-3 py-2">
      <p className="text-foreground">This decision was changed elsewhere</p>
      <p className="text-muted-foreground">
        {stored
          ? `It was changed, perhaps in another tab, so yours was not ${verb}. The saved decision is below.`
          : `It was removed, perhaps in another tab, so yours was not ${verb}.`}{" "}
        Nothing is overwritten until you reload it.
      </p>
      {stored ? <DecisionSummary decision={stored} /> : null}
      <Button type="button" variant="outline" size="sm" onClick={onReload}>
        Reload the saved decision
      </Button>
    </div>
  );
}

type Draft = {
  state: ClarifyDecisionState | null;
  reason: string;
  /**
   * The stored decision the draft started from, or null for a new one. Its `updatedAt` is the
   * revision every write from this editor sends, so a refetch that brings in another tab's change
   * cannot turn a stale draft into an accepted overwrite: the write gets a 409 instead.
   */
  base: StoredClarifyDecision | null;
};

type Conflict = { stored: StoredClarifyDecision | null; verb: "saved" | "removed" };
type EditorState = { draft: Draft | null; conflict: Conflict | null };

/**
 * An item's open editor and unresolved conflict. The contract page remounts the report when an
 * analysis finishes or another one is shown, and the person's unsaved draft must survive that, as
 * the notes card's does, so every change is also written to the query cache, keyed by the contract,
 * the source revision and the item: it returns only on the same item of the same text. Component
 * state stays the source while mounted, because a cache update reaches observers a tick later and
 * a controlled input would first snap back. A write that finishes after an unmount still updates
 * the cached copy.
 */
function useEditorState(contractId: string, sourceRevision: string, itemKey: string) {
  const queryClient = useQueryClient();
  const key = ["clarify-decisions", contractId, "editor", sourceRevision, itemKey] as const;
  const [state, setState] = useState<EditorState | null>(
    () => queryClient.getQueryData<EditorState | null>(key) ?? null,
  );
  const update = (change: Partial<EditorState>) => {
    const next = (previous: EditorState | null | undefined): EditorState | null => {
      const merged = { draft: null, conflict: null, ...previous, ...change };
      return merged.draft || merged.conflict ? merged : null;
    };
    setState(next);
    // Nothing fetches or observes these entries, and they must outlive the default five-minute
    // collection, so they are created with no collection at all.
    queryClient.setQueryDefaults(["clarify-decisions", contractId, "editor"], { gcTime: Infinity });
    queryClient.setQueryData<EditorState | null>(key, next);
  };
  return { state, update };
}

/** The decision control on one keyed item: its saved decision, or a way to record one. */
function DecisionControl({
  contractId,
  analysisId,
  sourceRevision,
  itemKey,
  item,
  decision,
}: {
  contractId: string;
  analysisId: string;
  sourceRevision: string;
  itemKey: string;
  item: ClarifyDecisionItem;
  decision: StoredClarifyDecision | null;
}) {
  const fieldId = useId();
  const { apply, reload } = useDecisionWrites(contractId);
  const editor = useEditorState(contractId, sourceRevision, itemKey);
  const draft = editor.state?.draft ?? null;
  const conflict = editor.state?.conflict ?? null;
  const setDraft = (next: Draft | null) => editor.update({ draft: next });
  const setConflict = (next: Conflict | null) => editor.update({ conflict: next });
  const [message, setMessage] = useState<string | null>(null);
  const writeKey = ["clarify-decisions", contractId, "write", sourceRevision, itemKey];

  const write = useMutation({
    mutationKey: writeKey,
    mutationFn: (action: { kind: "save"; draft: Draft } | { kind: "remove"; decision: StoredClarifyDecision }) =>
      action.kind === "save"
        ? putDecision(contractId, {
            analysisId,
            itemKey,
            state: action.draft.state!,
            reason: action.draft.reason,
            itemLabel: decisionItemLabel(item.label, item.name),
            expectedUpdatedAt: action.draft.base?.updatedAt ?? null,
          })
        : deleteDecision(contractId, action.decision),
    onSuccess: async (result, action) => {
      // The stale case refetches in the background; the message shows at once.
      const applied = apply(result, action.kind === "remove" ? action.decision.id : undefined);
      if (result.status !== "stale") await applied;
      if (result.status === "conflict") {
        setConflict({ stored: result.decision, verb: action.kind === "save" ? "saved" : "removed" });
      } else if (result.status === "stale") {
        setDraft(null);
        setMessage(result.message);
      } else {
        setDraft(null);
        setMessage(null);
      }
    },
    onError: (error, action) => {
      // A network failure is a TypeError with the browser's wording; show ours instead.
      const fallback = action.kind === "save" ? SAVE_ERROR : REMOVE_ERROR;
      setMessage(error instanceof DecisionRequestError ? error.message : fallback);
    },
  });
  // Counts a write started before a remount too.
  const busy = useIsMutating({ mutationKey: writeKey }) > 0;

  const startEditing = () => {
    setMessage(null);
    editor.update({
      conflict: null,
      draft: decision
        ? { state: decision.state, reason: decision.reason, base: decision }
        : { state: null, reason: "", base: null },
    });
  };
  const cancel = () => {
    editor.update({ draft: null, conflict: null });
    setMessage(null);
    write.reset();
  };
  const reloadStored = () => {
    if (!conflict) return;
    reload(conflict.stored, (draft?.base ?? decision)?.id ?? null);
    cancel();
  };

  const reasonLength = draft ? codePoints(draft.reason) : 0;
  const tooLong = reasonLength > CLARIFY_DECISION_REASON_MAX_CHARACTERS;
  const showCount = reasonLength >= COUNT_FROM;
  const canSave = Boolean(draft?.state) && !tooLong && !busy && !conflict;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !canSave) return;
    setMessage(null);
    write.mutate({ kind: "save", draft });
  };
  const remove = () => {
    // From the editor, remove the decision the draft started from, at the revision it was read.
    const target = draft ? draft.base : decision;
    if (!target || busy) return;
    setMessage(null);
    write.mutate({ kind: "remove", decision: target });
  };

  const status = message ? (
    <p role="alert" className="text-caption text-destructive">
      {message}
    </p>
  ) : null;

  if (!draft) {
    if (conflict) {
      return (
        <div className="mt-2 space-y-2 text-sm">
          <ConflictBox stored={conflict.stored} verb={conflict.verb} onReload={reloadStored} />
        </div>
      );
    }
    if (!decision) {
      // Compact, beside the item's Ask link, so a long checklist stays short until it is used.
      return (
        <>
          <button
            type="button"
            onClick={startEditing}
            className="ml-2 inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PenLine className="h-3 w-3" aria-hidden="true" />
            Record decision{" "}<span className="sr-only">on {item.name}</span>
          </button>
          {status}
        </>
      );
    }
    return (
      <div className="mt-2 space-y-2 text-sm">
        <div className="space-y-2 rounded-card bg-secondary/40 px-3 py-2">
          <DecisionSummary decision={decision} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={startEditing} disabled={busy}>
              Edit decision{" "}<span className="sr-only">on {item.name}</span>
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Remove decision{" "}<span className="sr-only">on {item.name}</span>
            </Button>
          </div>
        </div>
        {status}
      </div>
    );
  }

  const reasonId = `${fieldId}-reason`;
  return (
    <form
      onSubmit={submit}
      className="mt-2 space-y-3 rounded-card bg-secondary/40 px-3 py-3 text-sm"
      aria-label={`Your decision on ${item.name}`}
    >
      <fieldset className="space-y-2">
        <legend className="mb-1 text-muted-foreground">
          Your decision{" "}<span className="sr-only">on {item.name}</span>
        </legend>
        <div className="flex flex-wrap gap-2">
          {CLARIFY_DECISION_STATES.map((state) => {
            const id = `${fieldId}-${state}`;
            return (
              <label
                key={state}
                htmlFor={id}
                className="inline-flex cursor-pointer items-center gap-2 rounded-button border border-input px-3 py-1 has-[:checked]:border-foreground/60 has-[:checked]:bg-foreground/[0.06] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <input
                  id={id}
                  type="radio"
                  name={`${fieldId}-state`}
                  value={state}
                  checked={draft.state === state}
                  disabled={busy}
                  onChange={() => setDraft({ ...draft, state })}
                  className="accent-primary"
                />
                {CLARIFY_DECISION_STATE_LABELS[state]}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor={reasonId}>
          Reason{" "}<span className="sr-only">for your decision on {item.name}</span>
        </Label>
        <Textarea
          id={reasonId}
          rows={3}
          value={draft.reason}
          disabled={busy}
          aria-invalid={tooLong || undefined}
          aria-describedby={showCount ? `${reasonId}-count` : undefined}
          onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
        />
        {showCount ? (
          <p
            id={`${reasonId}-count`}
            className={cn("text-caption", tooLong ? "text-destructive" : "text-muted-foreground")}
          >
            {reasonLength.toLocaleString("en-US")} of{" "}
            {CLARIFY_DECISION_REASON_MAX_CHARACTERS.toLocaleString("en-US")} characters
          </p>
        ) : null}
      </div>
      {conflict ? (
        <ConflictBox stored={conflict.stored} verb={conflict.verb} onReload={reloadStored} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" size="sm" disabled={!canSave}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Save decision{" "}<span className="sr-only">on {item.name}</span>
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          {draft.base ? (
            <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={busy}>
              Remove decision{" "}<span className="sr-only">on {item.name}</span>
            </Button>
          ) : null}
        </div>
      )}
      {status}
    </form>
  );
}

/** One decision under "Decisions from earlier analyses", with its Remove action. */
function EarlierDecision({
  contractId,
  decision,
}: {
  contractId: string;
  decision: StoredClarifyDecision;
}) {
  const { apply, reload } = useDecisionWrites(contractId);
  const [conflict, setConflict] = useState<StoredClarifyDecision | null | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => deleteDecision(contractId, decision),
    onSuccess: async (result) => {
      await apply(result, decision.id);
      if (result.status === "conflict") setConflict(result.decision);
      else setMessage(null);
    },
    onError: (error) =>
      setMessage(error instanceof DecisionRequestError ? error.message : REMOVE_ERROR),
  });

  return (
    <li className="space-y-2 rounded-card bg-secondary/40 px-3 py-2">
      <p className="font-medium">{decision.itemLabel}</p>
      {conflict !== undefined ? (
        <ConflictBox
          stored={conflict}
          verb="removed"
          onReload={() => {
            reload(conflict, decision.id);
            setConflict(undefined);
          }}
        />
      ) : (
        <>
          <DecisionSummary decision={decision} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-3"
            onClick={() => {
              setMessage(null);
              remove.mutate();
            }}
            disabled={remove.isPending}
          >
            {remove.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Remove{" "}<span className="sr-only">earlier decision on {decision.itemLabel}</span>
          </Button>
        </>
      )}
      {message ? (
        <p role="alert" className="text-caption text-destructive">
          {message}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Loads the contract's decisions and attaches them to `checklist` (which must be
 * `clarifyBeforeSigning` of `result`), then renders `children` with each item's control, the
 * notices and the earlier decisions. A failed load leaves the checklist without decisions and
 * offers a retry.
 */
export function ClarifyDecisions({
  contractId,
  analysisId,
  result,
  checklist,
  children,
}: {
  contractId: string;
  analysisId: string;
  result: Partial<AnalysisResult> | null;
  checklist: ClarifyChecklist;
  children: (view: ClarifyDecisionsView) => ReactNode;
}) {
  const keys = useMemo(
    () => clarifyChecklistKeys(checklist, { contractId, resultJson: result }),
    [checklist, contractId, result],
  );
  const revision = useMemo(() => analysisSourceRevision(contractId, result), [contractId, result]);

  const decisions = useQuery({
    queryKey: decisionsKey(contractId),
    queryFn: ({ signal }) => fetchDecisions(contractId, signal),
    // Saves update the list in place and a 409 shows what another tab stored, so a refetch on
    // focus would only replace what the person is looking at.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const match = useMemo(
    () => (decisions.data ? matchClarifyDecisions(decisions.data, keys, revision) : null),
    [decisions.data, keys, revision],
  );

  const control = (item: ClarifyDecisionItem): ReactNode => {
    const keyed = keys[item.group][item.index];
    if (!keyed || !revision || !match) return null;
    if (keyed.ambiguous) {
      return <p className="mt-1 text-caption text-muted-foreground">{AMBIGUOUS_ITEM_LINE}</p>;
    }
    return (
      <DecisionControl
        // Keyed by the item, so an open editor never moves to another item when the list changes.
        key={keyed.key}
        contractId={contractId}
        analysisId={analysisId}
        sourceRevision={revision}
        itemKey={keyed.key}
        item={item}
        decision={match.matched.get(keyed.key) ?? null}
      />
    );
  };

  let notice: ReactNode = null;
  if (decisions.isError && !decisions.data) {
    notice = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-caption text-destructive">
          {LOAD_ERROR}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void decisions.refetch()}
          disabled={decisions.isFetching}
        >
          <RefreshCw className={cn(decisions.isFetching && "animate-spin")} aria-hidden />
          Try again{" "}<span className="sr-only">to load your decisions</span>
        </Button>
      </div>
    );
  } else if (!revision) {
    notice = <p className="text-caption text-muted-foreground">{NO_REVISION_HINT}</p>;
  } else if (!decisions.data) {
    notice = (
      <p role="status" className="text-caption text-muted-foreground">
        Loading your decisions…
      </p>
    );
  }

  const earlier = match?.earlier.length ? (
    <details className="rounded-card border border-border px-4 py-3">
      <summary className="cursor-pointer rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Decisions from earlier analyses ({match.earlier.length})
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-caption text-muted-foreground">
          You recorded these on an earlier analysis or an earlier version of the contract&apos;s
          text. They aren&apos;t attached to any item above.
        </p>
        <ul className="space-y-2">
          {match.earlier.map((decision) => (
            <EarlierDecision key={decision.id} contractId={contractId} decision={decision} />
          ))}
        </ul>
      </div>
    </details>
  ) : null;

  return <>{children({ control, notice, earlier })}</>;
}
