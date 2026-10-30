"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Loader2, NotebookPen, RefreshCw } from "lucide-react";
import { ApiRequestError } from "@/lib/api-client";
import {
  CONTRACT_NOTE_MAX_CHARACTERS,
  type ContractNotes as ContractNotesText,
} from "@/lib/contract-notes";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Notes as stored; `updatedAt` is null until the first save and is the next save's revision. */
type StoredNotes = ContractNotesText & { updatedAt: string | null };

type Editor = {
  /** The stored notes the draft started from. */
  base: StoredNotes;
  draft: ContractNotesText;
  /** Newer notes another save stored (a 409). The draft stays until the user picks a version. */
  conflict: StoredNotes | null;
};

type SaveResult = { status: "saved" | "conflict"; notes: StoredNotes };

const LOAD_ERROR = "Your notes could not be loaded. They have not been lost.";
const SAVE_ERROR = "Your notes could not be saved. Your text is still here, so try again.";
// The character count appears once a note reaches 80% of its limit.
const COUNT_FROM = Math.floor(CONTRACT_NOTE_MAX_CHARACTERS * 0.8);

const FIELDS = [
  { key: "acceptanceReasons", label: "Why I'd accept" },
  { key: "openQuestions", label: "Open questions" },
] as const;

const notesKey = (contractId: string) => ["contract-notes", contractId] as const;
const unsavedKey = (contractId: string) => ["contract-notes", contractId, "unsaved"] as const;

function toStored(value: StoredNotes): StoredNotes {
  return {
    acceptanceReasons: value.acceptanceReasons,
    openQuestions: value.openQuestions,
    updatedAt: value.updatedAt,
  };
}

function fresh(stored: StoredNotes): Editor {
  const { acceptanceReasons, openQuestions } = stored;
  return { base: stored, draft: { acceptanceReasons, openQuestions }, conflict: null };
}

function sameText(a: ContractNotesText, b: ContractNotesText): boolean {
  return a.acceptanceReasons === b.acceptanceReasons && a.openQuestions === b.openQuestions;
}

/** Length in Unicode code points, as the API and migration 022 count it. */
function noteLength(value: string): number {
  return [...value].length;
}

async function fetchNotes(contractId: string, signal: AbortSignal): Promise<StoredNotes> {
  const response = await fetch(`/api/contracts/${contractId}/notes`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new ApiRequestError(LOAD_ERROR, response.status);
  return toStored(await response.json());
}

async function putNotes(
  contractId: string,
  draft: ContractNotesText,
  expectedUpdatedAt: string | null,
): Promise<SaveResult> {
  const response = await fetch(`/api/contracts/${contractId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      acceptanceReasons: draft.acceptanceReasons,
      openQuestions: draft.openQuestions,
      expectedUpdatedAt,
    }),
  });
  if (response.status === 409) {
    const payload = (await response.json().catch(() => null)) as { notes?: StoredNotes } | null;
    if (payload?.notes) return { status: "conflict", notes: toStored(payload.notes) };
  }
  if (!response.ok) {
    throw new ApiRequestError(
      response.status === 401 ? "Your session has ended. Sign in again to save your notes." : SAVE_ERROR,
      response.status,
    );
  }
  return { status: "saved", notes: toStored(await response.json()) };
}

/**
 * The owner's own decision notes for a contract: why they would accept it and what they still need
 * answered. They are stored apart from every analysis (`/api/contracts/:id/notes`), so the card is
 * styled and labelled as the user's writing rather than generated output or a source quotation.
 * Saving is explicit. A save that another tab overtook (409) shows the newer notes beside the
 * user's text and overwrites neither until the user chooses.
 */
export function ContractNotes({ contractId }: { contractId: string }) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const fieldId = useId();
  const statusId = useId();

  const notes = useQuery({
    queryKey: notesKey(contractId),
    queryFn: ({ signal }) => fetchNotes(contractId, signal),
    // The editor holds its own revision; refetching would only race the user's typing.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // The contract page remounts its content when the analysis on screen changes, so unsaved edits
  // are parked in this identity's query cache and restored here instead of being dropped.
  const [editorState, setEditorState] = useState<Editor | null>(
    () => queryClient.getQueryData<Editor>(unsavedKey(contractId)) ?? null,
  );
  const editor: Editor | null =
    editorState ?? (notes.data ? fresh(notes.data) : null);
  const dirty = editor ? !sameText(editor.draft, editor.base) : false;

  useEffect(() => {
    if (editorState && (editorState.conflict || !sameText(editorState.draft, editorState.base))) {
      // Nothing observes this entry, so the default five-minute garbage collection would drop a
      // draft left open that long. It is removed explicitly once saved or discarded.
      queryClient.setQueryDefaults(unsavedKey(contractId), { gcTime: Infinity });
      queryClient.setQueryData(unsavedKey(contractId), editorState);
    } else {
      queryClient.removeQueries({ queryKey: unsavedKey(contractId), exact: true });
    }
  }, [queryClient, contractId, editorState]);

  const updateEditor = (update: (current: Editor) => Editor) => {
    setEditorState((previous) => {
      const current = previous ?? editor;
      return current ? update(current) : previous;
    });
  };

  const save = useMutation({
    mutationFn: ({ draft, expectedUpdatedAt }: { draft: ContractNotesText; expectedUpdatedAt: string | null }) =>
      putNotes(contractId, draft, expectedUpdatedAt),
    onSuccess: (result) => {
      queryClient.setQueryData(notesKey(contractId), result.notes);
      updateEditor((current) =>
        // Text typed while the save was in flight stays in the draft.
        result.status === "saved" || sameText(result.notes, current.draft)
          ? { base: result.notes, draft: current.draft, conflict: null }
          : { ...current, conflict: result.notes },
      );
    },
  });

  const lengths = editor
    ? {
        acceptanceReasons: noteLength(editor.draft.acceptanceReasons),
        openQuestions: noteLength(editor.draft.openQuestions),
      }
    : null;
  const tooLong = lengths
    ? Object.values(lengths).some((length) => length > CONTRACT_NOTE_MAX_CHARACTERS)
    : false;
  const conflict = editor?.conflict ?? null;
  const canSave = Boolean(editor) && dirty && !tooLong && !conflict && !save.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!editor || !canSave) return;
    save.mutate({ draft: editor.draft, expectedUpdatedAt: editor.base.updatedAt });
  };
  const takeStoredVersion = () => {
    if (!conflict || save.isPending) return;
    save.reset();
    updateEditor(() => fresh(conflict));
  };
  const keepMyVersion = () => {
    if (!editor || !conflict || tooLong) return;
    save.mutate({ draft: editor.draft, expectedUpdatedAt: conflict.updatedAt });
  };

  let status: { text: string; tone: "muted" | "error" | "success" } | null = null;
  if (notes.isError && !editor) status = { text: LOAD_ERROR, tone: "error" };
  else if (!editor) status = { text: "Loading your notes…", tone: "muted" };
  else if (save.isPending) status = { text: "Saving…", tone: "muted" };
  else if (conflict) status = { text: "Not saved: these notes were changed elsewhere.", tone: "error" };
  else if (save.isError) {
    // A network failure is a TypeError with the browser's wording; show ours instead.
    const text = save.error instanceof ApiRequestError ? save.error.message : SAVE_ERROR;
    status = { text, tone: "error" };
  }
  else if (tooLong) {
    status = {
      text: `Not saved: each note can be at most ${CONTRACT_NOTE_MAX_CHARACTERS.toLocaleString("en-US")} characters.`,
      tone: "error",
    };
  } else if (dirty) status = { text: "Unsaved changes", tone: "muted" };
  else if (editor.base.updatedAt) {
    status = {
      text: `Saved ${formatDate(editor.base.updatedAt, "MMM d, HH:mm")}`,
      tone: "success",
    };
  }

  return (
    <Card role="region" aria-labelledby={titleId} className="bg-secondary/40">
      <CardHeader>
        <CardTitle id={titleId} className="flex items-center gap-2">
          <NotebookPen className="h-5 w-5 text-muted-foreground" aria-hidden />
          Your notes
        </CardTitle>
        <CardDescription>
          Your own reasons and open questions, kept separate from the analysis.
          Only you can see them, and they are not part of the analysis or the
          downloaded brief.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {notes.isError && !editor ? (
          <Button
            variant="outline"
            onClick={() => void notes.refetch()}
            disabled={notes.isFetching}
            aria-describedby={statusId}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", notes.isFetching && "animate-spin")}
              aria-hidden
            />
            Try again
          </Button>
        ) : (
          <form onSubmit={submit} className="space-y-4" aria-busy={!editor}>
            <div className="grid gap-6 md:grid-cols-2">
              {FIELDS.map(({ key, label }) => {
                const id = `${fieldId}-${key}`;
                const length = lengths?.[key] ?? 0;
                const showCount = length >= COUNT_FROM;
                return (
                  <div key={key} className="space-y-2">
                    <Label htmlFor={id}>{label}</Label>
                    <Textarea
                      id={id}
                      rows={6}
                      value={editor?.draft[key] ?? ""}
                      disabled={!editor}
                      aria-invalid={length > CONTRACT_NOTE_MAX_CHARACTERS || undefined}
                      aria-describedby={showCount ? `${id}-count` : undefined}
                      onChange={(event) => {
                        const value = event.target.value;
                        updateEditor((current) => ({
                          ...current,
                          draft: { ...current.draft, [key]: value },
                        }));
                      }}
                    />
                    {showCount ? (
                      <p
                        id={`${id}-count`}
                        className={cn(
                          "text-caption",
                          length > CONTRACT_NOTE_MAX_CHARACTERS
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {length.toLocaleString("en-US")} of{" "}
                        {CONTRACT_NOTE_MAX_CHARACTERS.toLocaleString("en-US")} characters
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {conflict ? (
              <div className="space-y-3 rounded-card border px-4 py-3">
                <p className="text-foreground">These notes were changed elsewhere</p>
                <p className="text-muted-foreground">
                  Newer notes were saved, perhaps in another tab. They are shown
                  below, and your text is still in the fields above, so you can
                  copy anything you want to keep. Nothing is overwritten until you
                  choose.
                </p>
                <dl className="grid gap-4 md:grid-cols-2">
                  {FIELDS.map(({ key, label }) => (
                    <div key={key} className="space-y-1">
                      <dt className="text-muted-foreground">Saved “{label}”</dt>
                      <dd className="whitespace-pre-wrap break-words">
                        {conflict[key] || (
                          <span className="text-muted-foreground">Empty</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="flex flex-wrap gap-2">
                  {/* Both choices wait for a replacement save, which would otherwise land under a
                      draft that no longer shows the text it stored. */}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={takeStoredVersion}
                    disabled={save.isPending}
                  >
                    Use the saved version
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={keepMyVersion}
                    disabled={save.isPending || tooLong}
                  >
                    Replace it with mine
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="submit" variant="outline" disabled={!canSave}>
                {save.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                Save notes
              </Button>
            )}
          </form>
        )}
        <p
          id={statusId}
          role="status"
          className={cn(
            "flex min-h-5 items-center gap-1.5 text-caption",
            status?.tone === "error" && "text-destructive",
            // Deep Verdant text is only 4.6:1 on white, too little on this tinted card: the icon
            // carries the colour.
            status?.tone === "success" && "text-foreground",
            (!status || status.tone === "muted") && "text-muted-foreground",
          )}
        >
          {status?.tone === "success" ? <CircleCheck className="h-3.5 w-3.5 text-success" aria-hidden /> : null}
          {status?.text}
        </p>
      </CardContent>
    </Card>
  );
}
