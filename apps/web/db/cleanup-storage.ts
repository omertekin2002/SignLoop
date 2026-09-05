import { flushStorageDeletions } from "../lib/storage-cleanup";

while (await flushStorageDeletions() === 100) { /* drain full batches */ }
