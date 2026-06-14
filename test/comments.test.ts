import { SELF, env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { isAllowedOrigin, parseAllowedOrigins, type Comments } from "../src/index";

// A host that matches the test wrangler.jsonc ALLOWED_ORIGINS (".workers.dev").
const OK_ORIGIN = "https://feature-login.acme.workers.dev";

describe("isAllowedOrigin", () => {
  const allowed = parseAllowedOrigins(".workers.dev,localhost,127.0.0.1");

  it("matches a subdomain of a leading-dot suffix", () => {
    expect(isAllowedOrigin("https://pr-12.acme.workers.dev", allowed)).toBe(true);
  });

  it("matches a bare host exactly", () => {
    expect(isAllowedOrigin("http://localhost:3000", allowed)).toBe(true);
  });

  it("rejects a host that only ends with the bare suffix as a substring", () => {
    // "notlocalhost" must not match the bare "localhost" entry.
    expect(isAllowedOrigin("http://notlocalhost", allowed)).toBe(false);
  });

  it("rejects a lookalike that ends with the suffix without the dot boundary", () => {
    // "evilworkers.dev" ends with "workers.dev" but not with ".workers.dev".
    expect(isAllowedOrigin("https://evilworkers.dev", allowed)).toBe(false);
  });

  it("rejects an unrelated origin", () => {
    expect(isAllowedOrigin("https://evil.example.com", allowed)).toBe(false);
  });

  it("rejects a missing / unparseable origin", () => {
    expect(isAllowedOrigin("", allowed)).toBe(false);
    expect(isAllowedOrigin("not a url", allowed)).toBe(false);
  });
});

describe("parseAllowedOrigins", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseAllowedOrigins(" .workers.dev , localhost ,, ")).toEqual([
      ".workers.dev",
      "localhost",
    ]);
  });

  it("handles an undefined value", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});

type Frames = ReturnType<typeof frames>;

/**
 * Open a WebSocket to a room. The inbound-frame listener is attached *before*
 * accept() so no frame (notably the immediate "init") can slip past while the
 * test is awaiting something else.
 */
async function connect(
  room: string,
  origin: string = OK_ORIGIN,
): Promise<{ ws: WebSocket; frames: Frames }> {
  const res = await SELF.fetch(`https://comments.test/parties/comments/${room}`, {
    headers: { Upgrade: "websocket", Origin: origin },
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected a websocket upgrade, got ${res.status}`);
  }
  const ws = res.webSocket;
  const incoming = frames(ws);
  ws.accept();
  return { ws, frames: incoming };
}

/** Buffers inbound JSON frames so reads never race the socket. */
function frames(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data as string);
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
  });
  return {
    next(timeoutMs = 4000): Promise<any> {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    async expectSilence(ms = 250): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (queue.length) throw new Error(`expected silence, received ${JSON.stringify(queue[0])}`);
    },
  };
}

describe("Comments room", () => {
  it("rejects a connection from a disallowed origin", async () => {
    const res = await SELF.fetch("https://comments.test/parties/comments/blocked", {
      headers: { Upgrade: "websocket", Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("sends an empty init frame to a fresh board", async () => {
    const { ws, frames } = await connect("room-init");
    expect(await frames.next()).toEqual({ type: "init", pins: [] });
    ws.close();
  });

  it("broadcasts a write to other clients without echoing the sender", async () => {
    const room = "room-broadcast";
    const a = await connect(room);
    const b = await connect(room);

    // Drain both init frames first.
    expect(await a.frames.next()).toMatchObject({ type: "init" });
    expect(await b.frames.next()).toMatchObject({ type: "init" });

    const pins = [{ id: "p1", body: "first note" }];
    a.ws.send(JSON.stringify({ pins }));

    // B sees the sync; A does not get its own write echoed back.
    expect(await b.frames.next()).toEqual({ type: "sync", pins });
    await a.frames.expectSilence();

    a.ws.close();
    b.ws.close();
  });

  it("hydrates a later joiner with the persisted board", async () => {
    const room = "room-persist";
    const writer = await connect(room);
    expect(await writer.frames.next()).toMatchObject({ type: "init" });

    const pins = [{ id: "p1", body: "persisted" }];
    writer.ws.send(JSON.stringify({ pins }));
    await writer.frames.expectSilence(); // give the DO a moment to persist

    const joiner = await connect(room);
    expect(await joiner.frames.next()).toEqual({ type: "init", pins });

    writer.ws.close();
    joiner.ws.close();
  });

  it("keeps boards in separate rooms isolated", async () => {
    const a = await connect("room-a");
    const b = await connect("room-b");
    expect(await a.frames.next()).toMatchObject({ type: "init" });
    expect(await b.frames.next()).toMatchObject({ type: "init" });

    a.ws.send(JSON.stringify({ pins: [{ id: "only-in-a" }] }));
    await b.frames.expectSilence(); // room-b must not see room-a's write

    a.ws.close();
    b.ws.close();
  });

  it("ignores malformed frames", async () => {
    const { ws, frames } = await connect("room-malformed");
    expect(await frames.next()).toMatchObject({ type: "init" });

    ws.send("not json");
    ws.send(JSON.stringify({ pins: "not an array" }));
    await frames.expectSilence();
    ws.close();
  });

  it("ignores frames larger than the size cap", async () => {
    const room = "room-oversized";
    const a = await connect(room);
    const b = await connect(room);
    expect(await a.frames.next()).toMatchObject({ type: "init" });
    expect(await b.frames.next()).toMatchObject({ type: "init" });

    // A pin payload past the 512 KiB frame cap must be dropped, not fanned out.
    const huge = { id: "huge", body: "x".repeat(520 * 1024) };
    a.ws.send(JSON.stringify({ pins: [huge] }));
    await b.frames.expectSilence();

    a.ws.close();
    b.ws.close();
  });

  it("wipes the board when the idle alarm fires", async () => {
    const room = "room-alarm";
    const { ws, frames } = await connect(room);
    expect(await frames.next()).toMatchObject({ type: "init" });
    ws.send(JSON.stringify({ pins: [{ id: "doomed" }] }));
    await frames.expectSilence();
    ws.close();

    // partyserver routes a room to its DO via idFromName(<room>), so the same
    // mapping gives us a stub pointing at this board.
    const stub = env.Comments.get(env.Comments.idFromName(room));

    // Board is populated, then the alarm runs and clears storage.
    const before = await runInDurableObject(stub, (_instance: Comments, state) =>
      state.storage.get("pins"),
    );
    expect(before).toEqual([{ id: "doomed" }]);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const after = await runInDurableObject(stub, (_instance: Comments, state) =>
      state.storage.get("pins"),
    );
    expect(after).toBeUndefined();
  });
});
