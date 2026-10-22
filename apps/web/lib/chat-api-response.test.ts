import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_STREAM_UPDATE_MS,
  readChatApiResponse,
  type ChatApiStreamSnapshot,
} from "./chat-api-response";

const encoder = new TextEncoder();
const delta = (text: string) => ({ type: "delta", text });
const done = (message = "authoritative answer") => ({ type: "done", message });
const activity = {
  id: "search",
  tool: "search_web",
  query: "sources",
  status: "running",
};
const tool = (status = "running") => ({
  type: "tool",
  activity: { ...activity, status },
});
const line = (event: unknown) => JSON.stringify(event) + "\n";
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function source(
  options: { contentType?: string; cancel?: () => Promise<void> } = {},
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(options.cancel);
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const getReader = stream.getReader.bind(stream);
  let activeReads = 0;
  let maxReads = 0;
  let readCount = 0;
  vi.spyOn(stream, "getReader").mockImplementation(() => {
    const reader = getReader();
    const read = reader.read.bind(reader);
    vi.spyOn(reader, "read").mockImplementation(() => {
      readCount++;
      maxReads = Math.max(maxReads, ++activeReads);
      return read().then(
        (value) => {
          activeReads--;
          return value;
        },
        (error: unknown) => {
          activeReads--;
          throw error;
        },
      );
    });
    return reader;
  });
  return {
    response: new Response(stream, {
      headers: {
        "Content-Type": options.contentType ?? "application/x-ndjson",
      },
    }),
    stream,
    cancel,
    send: (...events: unknown[]) =>
      controller.enqueue(encoder.encode(events.map(line).join(""))),
    bytes: (bytes: Uint8Array) => controller.enqueue(bytes),
    close: () => controller.close(),
    error: () => controller.error(new Error("connection lost")),
    get reads() {
      return { active: activeReads, max: maxReads, count: readCount };
    },
  };
}
function collect(iterator: AsyncGenerator<ChatApiStreamSnapshot>) {
  const snapshots: ChatApiStreamSnapshot[] = [];
  // Observe failures immediately, avoiding unhandled rejections before a later assertion.
  const completed = (async () => {
    try {
      for await (const value of iterator) snapshots.push(value);
      return null;
    } catch (error) {
      return error;
    }
  })();
  return { snapshots, completed };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("production chat response coalescing", () => {
  it("paints first useful text immediately, even after tools and whitespace", async () => {
    const input = source();
    const run = collect(readChatApiResponse(input.response));
    input.send(tool(), delta("  "));
    await settle();
    expect(run.snapshots).toHaveLength(1);
    expect(run.snapshots[0]?.toolActivity).toEqual([activity]);
    input.send(delta("first"));
    await settle();
    expect(run.snapshots.map((s) => s.message)).toEqual(["", "  first"]);
    expect(vi.getTimerCount()).toBe(0);
    input.send(done());
    expect(await run.completed).toBeNull();
    expect(input.cancel).toHaveBeenCalledTimes(1);
    expect(input.stream.locked).toBe(false);
  });
  it("reduces 101 delta events to first text + one timer paint + terminal", async () => {
    const input = source();
    const run = collect(readChatApiResponse(input.response));
    input.send(delta("0"));
    await settle();
    input.send(...Array.from({ length: 100 }, () => delta("x")));
    await settle();
    expect(run.snapshots).toHaveLength(1);
    expect(input.reads).toMatchObject({ active: 1, max: 1 });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_UPDATE_MS - 1);
    expect(run.snapshots).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.snapshots.map((s) => s.message)).toEqual([
      "0",
      "0" + "x".repeat(100),
    ]);
    expect(input.reads).toMatchObject({ active: 1, max: 1 });
    input.send(done("0" + "x".repeat(100) + " suffix"));
    expect(await run.completed).toBeNull();
    expect(run.snapshots).toHaveLength(3);
    expect(run.snapshots.at(-1)?.done).toBe(true);
  });
  it("flushes on each 40ms deadline with no additional source chunks", async () => {
    const input = source();
    const run = collect(readChatApiResponse(input.response));
    input.send(delta("a"), delta("b"));
    await settle();
    const reads = input.reads.count;
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_UPDATE_MS);
    expect(run.snapshots.map((s) => s.message)).toEqual(["a", "ab"]);
    await vi.advanceTimersByTimeAsync(10 * CHAT_STREAM_UPDATE_MS);
    expect(run.snapshots).toHaveLength(2);
    expect(input.reads.count).toBe(reads);
    input.send(delta("c"));
    await settle();
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_UPDATE_MS);
    expect(run.snapshots.at(-1)?.message).toBe("abc");
    input.send(done("abc"));
    expect(await run.completed).toBeNull();
    expect(input.reads.max).toBe(1);
  });
  it("bypasses a pending deadline for exact authoritative text and all terminal metadata", async () => {
    const input = source();
    const run = collect(readChatApiResponse(input.response));
    input.send(delta("first"), delta(" pending"));
    await settle();
    await vi.advanceTimersByTimeAsync(7);
    const metadata = {
      provider: "mock-provider",
      model: "mock-model",
      persisted: false,
      toolActivity: [{ ...activity, status: "complete" }],
      storedMessages: [
        {
          id: "message",
          position: 1,
          role: "assistant",
          content: "saved text",
          createdAt: "2026-10-22T00:00:00Z",
        },
      ],
      agentMessages: [{ role: "assistant", content: "tool replay" }],
      webSources: [
        {
          number: 3,
          title: "Source",
          url: "https://example.com/source",
          snippet: "evidence",
        },
      ],
      quota: {
        limit: 30,
        used: 1,
        remaining: 29,
        resetAt: "2026-10-22T12:00:00Z",
        concurrency: { limit: 2, inUse: 1 },
      },
    };
    input.send(
      { ...done("  replaced authoritative answer with suffix\n"), ...metadata },
      delta("forbidden"),
      done("duplicate"),
    );
    expect(await run.completed).toBeNull();
    expect(run.snapshots).toHaveLength(2);
    expect(run.snapshots.at(-1)).toEqual({
      type: "done",
      message: "  replaced authoritative answer with suffix\n",
      done: true,
      ...metadata,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.snapshots).toHaveLength(2);
    expect(input.cancel).toHaveBeenCalledTimes(1);
    expect(input.stream.locked).toBe(false);
  });
  it("handles a whole response in one chunk without timer delay or duplicate terminal", async () => {
    const input = source();
    input.send(
      delta("a"),
      delta("b"),
      delta("c"),
      done("abc"),
      done("ignored"),
    );
    const run = collect(readChatApiResponse(input.response));
    expect(await run.completed).toBeNull();
    expect(run.snapshots.map((s) => [s.message, s.done])).toEqual([
      ["a", false],
      ["abc", true],
    ]);
  });
  it("allows done without deltas and without a final newline", async () => {
    const input = source();
    input.bytes(encoder.encode(JSON.stringify(done("complete"))));
    input.close();
    const run = collect(readChatApiResponse(input.response));
    expect(await run.completed).toBeNull();
    expect(run.snapshots.map((s) => [s.message, s.done])).toEqual([
      ["complete", true],
    ]);
    expect(input.stream.locked).toBe(false);
  });
  it("surfaces changed tool status promptly, flushing text and sharing unchanged metadata", async () => {
    const input = source();
    const run = collect(readChatApiResponse(input.response));
    input.send(
      tool(),
      delta("a"),
      delta("b"),
      tool("complete"),
      tool("complete"),
    );
    await settle();
    expect(run.snapshots.map((s) => s.message)).toEqual(["", "a", "ab"]);
    expect(run.snapshots[1]?.toolActivity).toBe(run.snapshots[0]?.toolActivity);
    expect(run.snapshots[2]?.toolActivity).not.toBe(
      run.snapshots[1]?.toolActivity,
    );
    expect(vi.getTimerCount()).toBe(0);
    input.send(delta("c"));
    await settle();
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_UPDATE_MS);
    expect(run.snapshots[3]?.toolActivity).toBe(run.snapshots[2]?.toolActivity);
    input.send(done("abc"));
    expect(await run.completed).toBeNull();
  });
  it("decodes UTF-8 split at every byte and tolerates split comments/keepalives", async () => {
    const input = source();
    const run = collect(readChatApiResponse(input.response));
    const text = "İstanbul 🧑🏽‍💻 日本語";
    const bytes = encoder.encode(
      ": keepalive\n\nnot JSON\n" + line(delta(text)) + line(done(text)),
    );
    for (const byte of bytes) {
      input.bytes(Uint8Array.of(byte));
      await settle();
    }
    expect(await run.completed).toBeNull();
    expect(run.snapshots.map((s) => s.message)).toEqual([text, text]);
    expect(input.reads.max).toBe(1);
  });
  it.each([
    "error event",
    "invalid event",
    "unknown event",
    "invalid tool",
    "empty done",
    "EOF",
    "read rejection",
  ])(
    "flushes buffered partial text before %s, never fabricating completion",
    async (failure) => {
      const input = source();
      const run = collect(readChatApiResponse(input.response));
      input.send(delta("useful"), delta(" partial"));
      await settle();
      if (failure === "error event")
        input.send({ type: "error", error: "provider unavailable" });
      else if (failure === "invalid event")
        input.send({ message: "missing type" });
      else if (failure === "unknown event") input.send({ type: "unsupported" });
      else if (failure === "invalid tool")
        input.send({ type: "tool", activity: {} });
      else if (failure === "empty done") input.send(done("  "));
      else if (failure === "EOF") input.close();
      else input.error();
      expect(await run.completed).toBeInstanceOf(Error);
      expect(run.snapshots.map((s) => s.message)).toEqual([
        "useful",
        "useful partial",
      ]);
      expect(run.snapshots.every((s) => !s.done)).toBe(true);
      expect(input.stream.locked).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(run.snapshots).toHaveLength(2);
    },
  );
  it.each([false, true])(
    "aborts a paused read with pending timer=%s, without late text",
    async (pendingText) => {
      const input = source();
      const abort = new AbortController();
      const add = vi.spyOn(abort.signal, "addEventListener");
      const remove = vi.spyOn(abort.signal, "removeEventListener");
      const run = collect(readChatApiResponse(input.response, abort.signal));
      input.send(delta("first"));
      if (pendingText) input.send(delta("abandoned"));
      await settle();
      expect(input.reads.active).toBe(1);
      abort.abort(new DOMException("Stopped", "AbortError"));
      expect(input.cancel).toHaveBeenCalledTimes(1);
      expect(input.stream.locked).toBe(false);
      expect(await run.completed).toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(100);
      expect(run.snapshots.map((s) => s.message)).toEqual(["first"]);
      expect(add.mock.calls[0]?.[1]).toBe(remove.mock.calls[0]?.[1]);
    },
  );
  it("clears listeners when aborted while suspended at a yield", async () => {
    const input = source();
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const iterator = readChatApiResponse(input.response, abort.signal);
    input.send(delta("a"), delta("b"));
    await iterator.next();
    const pending = iterator.next();
    await settle();
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_UPDATE_MS);
    expect((await pending).value?.message).toBe("ab");
    abort.abort();
    expect(input.stream.locked).toBe(false);
    expect(remove).toHaveBeenCalled();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each([false, true])(
    "early return wakes an in-flight next() with pending timer=%s",
    async (pendingText) => {
      const input = source();
      const iterator = readChatApiResponse(input.response);
      input.send(delta("first"));
      await iterator.next();
      const pending = iterator.next().catch((error: unknown) => error);
      if (pendingText) input.send(delta("discard"));
      await settle();
      const returned = iterator.return(undefined);
      expect(await pending).toMatchObject({ name: "AbortError" });
      expect(await returned).toEqual({ value: undefined, done: true });
      expect(input.cancel).toHaveBeenCalledTimes(1);
      expect(input.stream.locked).toBe(false);
      expect(input.reads.active).toBe(0);
    },
  );
  it("cancels on a for-await break, before-first-next return, and iterator.throw", async () => {
    for (const mode of ["break", "unstarted", "throw"]) {
      const input = source();
      const iterator = readChatApiResponse(input.response);
      input.send(delta("first"), delta("unread"));
      if (mode === "break") {
        for await (const snapshot of iterator) {
          expect(snapshot.message).toBe("first");
          break;
        }
      } else if (mode === "unstarted") await iterator.return(undefined);
      else {
        await iterator.next();
        await expect(
          iterator.throw(new Error("consumer failed")),
        ).rejects.toThrow();
      }
      expect(input.cancel).toHaveBeenCalledTimes(1);
      expect(input.stream.locked).toBe(false);
    }
  });
  it.each(["pending", "rejecting"])(
    "does not delay completion or leak a lock for %s cancel hook",
    async (mode) => {
      const input = source({
        cancel: () =>
          mode === "pending"
            ? new Promise(() => {})
            : Promise.reject(new Error("cancel failed")),
      });
      input.send(delta("first"), delta("pending"), done("complete"));
      const run = collect(readChatApiResponse(input.response));
      expect(await run.completed).toBeNull();
      expect(run.snapshots.at(-1)?.message).toBe("complete");
      expect(input.stream.locked).toBe(false);
      await settle();
    },
  );
  it("handles a pre-aborted signal without reading or yielding", async () => {
    const input = source();
    const abort = new AbortController();
    abort.abort();
    const run = collect(readChatApiResponse(input.response, abort.signal));
    expect(await run.completed).toMatchObject({ name: "AbortError" });
    expect(run.snapshots).toEqual([]);
    expect(input.reads.count).toBe(0);
    expect(input.cancel).toHaveBeenCalledTimes(1);
    expect(input.stream.locked).toBe(false);
  });
  it("keeps completion successful when the client aborts after receiving done", async () => {
    const input = source();
    const abort = new AbortController();
    input.send(done());
    const iterator = readChatApiResponse(input.response, abort.signal);
    expect((await iterator.next()).value?.done).toBe(true);
    abort.abort();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });
  it("preserves JSON fallback and rejects malformed/HTTP error payloads", async () => {
    const success = collect(
      readChatApiResponse(
        Response.json({
          message: " json answer ",
          persisted: false,
          model: "json-model",
        }),
      ),
    );
    expect(await success.completed).toBeNull();
    expect(success.snapshots).toMatchObject([
      {
        message: " json answer ",
        done: true,
        persisted: false,
        model: "json-model",
      },
    ]);
    for (const response of [
      Response.json({ error: "upstream failed" }, { status: 503 }),
      Response.json({}),
      new Response(null),
    ]) {
      const failed = collect(readChatApiResponse(response));
      expect(await failed.completed).toBeInstanceOf(Error);
      expect(failed.snapshots).toEqual([]);
      expect(response.body?.locked ?? false).toBe(false);
    }
  });
  it("cancels paused JSON fallback reads as promptly as NDJSON", async () => {
    const input = source({ contentType: "application/json" });
    const abort = new AbortController();
    const run = collect(readChatApiResponse(input.response, abort.signal));
    input.bytes(encoder.encode('{"message":"unfinished'));
    await settle();
    abort.abort();
    expect(await run.completed).toMatchObject({ name: "AbortError" });
    expect(run.snapshots).toEqual([]);
    expect(input.stream.locked).toBe(false);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });
});
