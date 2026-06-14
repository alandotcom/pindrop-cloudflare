// End-to-end smoke test against a running `wrangler dev` (default :8787).
// Exercises the real Worker over the wire: origin gate, init frame, and
// cross-connection broadcast. Run via `node scripts/smoke.mjs` after starting
// the dev server. Not part of the vitest suite; this is a manual wire check.
import WebSocket from "ws";

const BASE = process.env.SMOKE_HOST ?? "ws://127.0.0.1:8787";
const url = (room) => `${BASE}/parties/comments/${room}`;
const GOOD = "https://x.workers.dev";
const BAD = "https://evil.example.com";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open(room, origin) {
  const ws = new WebSocket(url(room), { headers: { Origin: origin } });
  const frames = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  return { ws, frames };
}

function onceOpenOrError(ws) {
  return new Promise((resolve) => {
    ws.on("open", () => resolve({ ok: true }));
    ws.on("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on("error", (err) => resolve({ ok: false, error: String(err) }));
  });
}

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!cond) failures++;
};

// 1. Disallowed origin is rejected at the handshake.
const bad = open("smoke", BAD);
const badResult = await onceOpenOrError(bad.ws);
check("rejects a disallowed origin", badResult.ok === false, JSON.stringify(badResult));
try { bad.ws.close(); } catch {}

// 2. Allowed origin connects and gets an init frame.
const a = open("smoke", GOOD);
const aResult = await onceOpenOrError(a.ws);
check("allowed origin connects", aResult.ok === true, JSON.stringify(aResult));
await wait(300);
check("first frame is init", a.frames[0]?.type === "init", JSON.stringify(a.frames[0]));

// 3. A second client in the same room receives the first client's write.
const b = open("smoke", GOOD);
await onceOpenOrError(b.ws);
await wait(300);
b.frames.length = 0; // drop b's own init
const pins = [{ id: "smoke-1", body: "hello over the wire" }];
a.ws.send(JSON.stringify({ pins }));
await wait(400);
check("peer receives broadcast", JSON.stringify(b.frames[0]) === JSON.stringify({ type: "sync", pins }), JSON.stringify(b.frames[0]));

a.ws.close();
b.ws.close();

await wait(200);
console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
