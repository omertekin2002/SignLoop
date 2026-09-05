import { deleteObject } from "@/lib/object-storage";
import { completeStorageDeletion, listPendingStorageDeletions } from "@/lib/server-db";

/** Failed objects stay in the outbox for the next delete request or cleanup command. */
export async function flushStorageDeletions(): Promise<number> {
  const pending = await listPendingStorageDeletions();
  let completed = 0;
  for (const item of pending) {
    try {
      await deleteObject(item.storageKey);
      await completeStorageDeletion(item.id);
      completed += 1;
    } catch (error) {
      console.error("Storage cleanup deferred", { id: item.id, error });
    }
  }
  return completed;
}
