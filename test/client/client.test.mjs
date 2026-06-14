// Deterministic tests for client/pindrop-comments.js, run under node's built-in
// test runner (`node --test`). pindrop.js and partysocket are replaced with
// local stub modules via the module's own `pindropUrl` / `partySocketUrl`
// options, so no browser or network is involved. Kept out of the vitest run
// (which executes in workerd) by the *.test.mjs extension.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { initPindropComments } from "../../client/pindrop-comments.js";

const pindropUrl = new URL("./stub-pindrop.mjs", import.meta.url).href;
const partySocketUrl = new URL("./stub-partysocket.mjs", import.meta.url).href;

// Lets queued microtasks (deferred sync application) run before asserting.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The client imports the stubs by these exact URLs, so the ESM cache hands the
// test and the client the same module instances (and the same shared state).
const pindropStub = await import(pindropUrl);
const partySocketStub = await import(partySocketUrl);

async function setup(extra = {}) {
  pindropStub.reset();
  partySocketStub.reset();
  const handle = await initPindropComments({
    host: "comments.example",
    room: "branch-x",
    injectStyles: false, // avoid touching `document`
    pindropUrl,
    partySocketUrl,
    ...extra,
  });
  return { handle, state: pindropStub.state, socket: partySocketStub.sockets[0] };
}

test("opens a PartySocket with the room, party, and host", async () => {
  const { socket } = await setup();
  assert.equal(socket.opts.host, "comments.example");
  assert.equal(socket.opts.room, "branch-x");
  assert.equal(socket.opts.party, "comments");
});

test("hydrates pindrop from the room's init frame", async () => {
  const { state, socket } = await setup();
  const pins = [{ id: "a", body: "hello" }];
  socket._message({ type: "init", pins });
  assert.deepEqual(await state.loadPromise, pins);
  assert.deepEqual(state.loadResult, pins);
});

test("forwards a local edit as a {pins} frame", async () => {
  const { state, socket } = await setup();
  socket._message({ type: "init", pins: [] });
  await state.loadPromise;

  const pins = [{ id: "a" }, { id: "b" }];
  state.adapter.save(pins);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { pins });
});

test("applies a remote sync without echoing it back out", async () => {
  const { state, socket } = await setup();
  socket._message({ type: "init", pins: [] });
  await state.loadPromise;
  const sentBefore = socket.sent.length;

  const pins = [{ id: "remote" }];
  socket._message({ type: "sync", pins });
  await flush();

  assert.deepEqual(state.applied.at(-1), pins);
  // applyRemoteComments re-saves internally; that must not become an outbound
  // frame, or two clients would ping-pong forever.
  assert.equal(socket.sent.length, sentBefore);
});

test("defers a sync that arrives before the first init", async () => {
  const { state, socket } = await setup();

  // A sync racing ahead of init must not be applied against an unhydrated board.
  socket._message({ type: "sync", pins: [{ id: "early" }] });
  await flush();
  assert.equal(state.applied.length, 0);

  // Once init hydrates, the deferred sync applies, and it is not clobbered.
  socket._message({ type: "init", pins: [] });
  await state.loadPromise;
  await flush();
  assert.deepEqual(state.applied.at(-1), [{ id: "early" }]);
});

test("reconciles against a fresh init after a reconnect", async () => {
  const { state, socket } = await setup();
  socket._message({ type: "init", pins: [] }); // first init hydrates
  await state.loadPromise;
  assert.equal(state.applied.length, 0);

  const pins = [{ id: "reconnected" }];
  socket._message({ type: "init", pins }); // a later init reconciles
  assert.deepEqual(state.applied.at(-1), pins);
});

test("sets the user when an identity is provided", async () => {
  const { state } = await setup({ user: { name: "Alan" } });
  assert.deepEqual(state.user, { name: "Alan" });
});

test("ignores malformed and non-pin frames", async () => {
  const { state, socket } = await setup();
  socket._emit("message", { data: "not json" });
  socket._message({ type: "sync" }); // no pins array
  socket._message({ type: "sync", pins: "nope" });
  assert.equal(state.applied.length, 0);
});

test("requires host, and room when no hostname is available", async () => {
  // In Node there is no globalThis.location, so room has no fallback here.
  await assert.rejects(() => initPindropComments({ room: "x", injectStyles: false, pindropUrl, partySocketUrl }), /host/);
  await assert.rejects(() => initPindropComments({ host: "x", injectStyles: false, pindropUrl, partySocketUrl }), /room/);
});

test("defaults room to location.hostname when omitted", async () => {
  const original = globalThis.location;
  globalThis.location = { hostname: "pr-7.acme.pages.dev" };
  try {
    pindropStub.reset();
    partySocketStub.reset();
    await initPindropComments({ host: "comments.example", injectStyles: false, pindropUrl, partySocketUrl });
    assert.equal(partySocketStub.sockets[0].opts.room, "pr-7.acme.pages.dev");
  } finally {
    if (original === undefined) delete globalThis.location;
    else globalThis.location = original;
  }
});

test("destroy() closes the socket and tears down pindrop", async () => {
  const { handle, state, socket } = await setup();
  handle.destroy();
  assert.equal(socket.closed, true);
  assert.equal(state.destroyed, true);
});
