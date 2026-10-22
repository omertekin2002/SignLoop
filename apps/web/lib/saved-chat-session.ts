import { withAbort } from "@/lib/bounded-response";

/** Owns lazy thread creation for one mounted saved-chat composer. */
export function createSavedChatSession(discardThread: (id: string) => Promise<void>) {
  let threadId: string | null = null;
  let unclaimedThreadId: string | null = null;
  let active = false;
  let revision = 0;
  let pending: Promise<string> | null = null;
  const discard = (id: string) => {
    void Promise.resolve().then(() => discardThread(id)).catch(() => {});
  };
  const discardUnclaimed = () => {
    const id = unclaimedThreadId;
    unclaimedThreadId = null;
    if (id) discard(id);
  };

  return {
    select(nextThreadId: string | null, nextActive: boolean) {
      // Promoting this session's local draft to its saved ID keeps the same run alive.
      if (threadId !== nextThreadId || active !== nextActive) {
        discardUnclaimed();
        revision += 1;
        pending = null;
      }
      threadId = nextThreadId;
      active = nextActive;
      if (nextThreadId && nextActive) unclaimedThreadId = null;
    },
    invalidate() {
      discardUnclaimed();
      revision += 1;
      active = false;
      pending = null;
    },
    beginRun(signal: AbortSignal) {
      const runRevision = revision;
      const isSelected = () => active && revision === runRevision;
      const isCurrent = () => isSelected() && !signal.aborted;
      const assertCurrent = () => {
        if (!isCurrent()) {
          throw new DOMException("Chat selection changed.", "AbortError");
        }
      };

      return {
        isCurrent,
        assertCurrent,
        async resolveThread(create: () => Promise<string>): Promise<string> {
          assertCurrent();
          if (threadId) return threadId;
          if (!pending) {
            const request = create().then((createdId) => {
              if (!isSelected()) {
                discard(createdId);
                throw new DOMException("Chat selection changed.", "AbortError");
              }
              // A stopped run cannot select/send, but a known ID is reusable by the same draft.
              threadId = createdId;
              unclaimedThreadId = createdId;
              return createdId;
            });
            pending = request;
            // An older request must never clear a newer selection's in-flight creation.
            void request.finally(() => {
              if (pending === request) pending = null;
            }).catch(() => {});
          }
          const createdId = await withAbort(pending, signal);
          assertCurrent();
          return createdId;
        },
      };
    },
  };
}
