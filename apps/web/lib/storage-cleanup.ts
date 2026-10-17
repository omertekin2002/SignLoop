import { deleteObject } from "@/lib/object-storage";
import {
  completeStorageDeletion,
  claimStorageDeletions,
  deferStorageDeletion,
} from "@/lib/server-db";

/** Failed objects stay in the outbox for the next delete request or cleanup command. */
export async function flushStorageDeletions(
  limit = 20,
  options: { deadline?: number; signal?: AbortSignal } = {},
): Promise<{ claimed: number; completed: number }> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const abortForDeadline = () =>
    controller.abort(
      new DOMException("Storage cleanup deadline reached", "TimeoutError"),
    );
  const deadlineReached = () => {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      abortForDeadline();
    }
    return signal.aborted;
  };
  if (deadlineReached()) return { claimed: 0, completed: 0 };

  const timer =
    options.deadline === undefined
      ? undefined
      : setTimeout(
          abortForDeadline,
          Math.max(0, options.deadline - Date.now()),
        );
  try {
    const pending = await claimStorageDeletions(limit);
    let completed = 0;
    let cursor = 0;
    const errors: unknown[] = [];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        for (;;) {
          const item = pending[cursor++];
          if (!item) break;
          try {
            // Claims and acknowledgements cannot be cancelled. Even if claiming took us
            // past the deadline, settle every token instead of abandoning its lease.
            if (deadlineReached()) {
              await deferStorageDeletion(item.id, item.token);
              continue;
            }
            try {
              await deleteObject(item.storageKey, signal);
              await completeStorageDeletion(item.id, item.token);
              completed += 1;
            } catch (error) {
              await deferStorageDeletion(item.id, item.token);
              console.error("Storage cleanup deferred", { id: item.id, error });
            }
          } catch (error) {
            // A failed acknowledgement must not prevent settling the other claims.
            errors.push(error);
          }
        }
      }),
    );
    if (errors.length) {
      throw new AggregateError(errors, "Storage cleanup settlement failed");
    }
    return { claimed: pending.length, completed };
  } finally {
    clearTimeout(timer);
  }
}
