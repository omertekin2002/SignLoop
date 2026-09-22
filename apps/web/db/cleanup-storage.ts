import { flushStorageDeletions } from "../lib/storage-cleanup";

while ((await flushStorageDeletions(100)).claimed === 100) {
  /* failed items back off; continue eligible work */
}
