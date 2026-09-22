import { deleteObject } from "@/lib/object-storage";
import {
  completeStorageDeletion,
  claimStorageDeletions,
  deferStorageDeletion,
} from "@/lib/server-db";

/** Failed objects stay in the outbox for the next delete request or cleanup command. */
export async function flushStorageDeletions(
  limit = 20,
): Promise<{ claimed: number; completed: number }> {
  const pending = await claimStorageDeletions(limit);
  let completed = 0;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (;;) {
        const item = pending[cursor++];
        if (!item) break;
        try {
          await deleteObject(item.storageKey);
          await completeStorageDeletion(item.id, item.token);
          completed += 1;
        } catch (error) {
          await deferStorageDeletion(item.id, item.token);
          console.error("Storage cleanup deferred", { id: item.id, error });
        }
      }
    }),
  );
  return { claimed: pending.length, completed };
}
