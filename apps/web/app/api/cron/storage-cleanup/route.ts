import { flushStorageDeletions } from "@/lib/storage-cleanup";

export const maxDuration = 300;

const BATCH_SIZE = 20;
const MAX_BATCHES = 100;
const WORK_DEADLINE_MS = 240_000;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  let claimed = 0;
  let completed = 0;
  let batches = 0;
  let moreMayRemain = true;
  const deadline = Date.now() + WORK_DEADLINE_MS;

  while (batches < MAX_BATCHES && Date.now() < deadline) {
    const batch = await flushStorageDeletions(BATCH_SIZE);
    claimed += batch.claimed;
    completed += batch.completed;
    batches += 1;
    if (batch.claimed < BATCH_SIZE) {
      moreMayRemain = false;
      break;
    }
  }

  return Response.json(
    { claimed, completed, batches, moreMayRemain },
    { headers: { "Cache-Control": "no-store" } },
  );
}
