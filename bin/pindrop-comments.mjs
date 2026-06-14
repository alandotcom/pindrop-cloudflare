#!/usr/bin/env node
// Read and respond to the Pindrop review comments on a deployed preview, from a
// terminal or an agent. The comments live in one Durable Object room per
// preview, reached only over a WebSocket; this connects to that room exactly the
// way the browser client does.
//
// Zero dependencies. Node's built-in WebSocket (Node >= 22) is used, and unlike
// a browser it lets a non-browser client set the Origin header, which is what
// the worker's ALLOWED_ORIGINS gate checks. The room and Origin are derived from
// the preview URL: its hostname is the room, its origin is sent as Origin.
//
//   npx pindrop-comments read    https://abc-site.acme.workers.dev
//   npx pindrop-comments reply   https://abc-site.acme.workers.dev --comment 1 --text "fixed in 9e16fe8"
//   npx pindrop-comments resolve https://abc-site.acme.workers.dev --comment 1
//   npx pindrop-comments comment https://abc-site.acme.workers.dev --selector "header .logo" --text "moved this"
//
// Writes are read-modify-write of the whole pin array (the worker stores it
// opaque and rebroadcasts; last write wins), and are shaped to match pindrop's
// Comment/Reply schema so a reviewer's browser renders them. Agent-authored
// items are tagged meta.source="agent". The pure helpers below are exported so
// they can be unit-tested; main() only runs when the file is invoked directly.

import { pathToFileURL } from "node:url";

class UsageError extends Error {}

const COMMANDS = new Set(["read", "reply", "comment", "resolve"]);
const DEFAULT_AUTHOR = "Agent";

const USAGE = `Read and respond to Pindrop comments on a deployed preview.

Usage:
  pindrop-comments <command> <preview-url> [options]

Commands:
  read     Print the comments on the preview (default if omitted).
  reply    Append a reply to a comment.            (needs --comment, --text)
  comment  Add a new comment anchored to a selector.(needs --selector, --text)
  resolve  Mark a comment resolved.                 (needs --comment)

Arguments:
  <preview-url>      The preview, e.g. https://abc-site.acme.workers.dev
                     Its hostname becomes the room and its origin is sent as the
                     Origin header (checked against the worker's ALLOWED_ORIGINS).

Common options:
  -H, --host <host>  Comments Worker host, e.g. pindrop-comments.acme.workers.dev.
                     Required, or set PINDROP_HOST. A ws://, wss://, http:// or
                     https:// prefix is accepted and picks the protocol.
      --room <room>  Override the room. Default: the preview URL's hostname. Set
                     only if the site passes an explicit \`room\` to initPindropComments.
      --origin <url> Override the Origin header. Default: the preview URL's origin.
      --party <name> Durable Object party segment. Default: comments.
      --timeout <ms> How long to wait for the room. Default: 10000.
      --json         Emit raw JSON instead of a summary.
  -h, --help         Show this help.

read options:
  -w, --watch        Stay connected and reprint when the board changes.

write options (reply / comment / resolve):
  --comment <ref>    Target comment: its id, or its 1-based number from \`read\`
                     (e.g. 1 or #1).
  --text <text>      Body of the reply or new comment.
  --selector <css>   CSS selector to anchor a new comment to (comment only).
  --author <name>    Attribution. Default: PINDROP_AUTHOR or "${DEFAULT_AUTHOR}".
  --model <name>     Optional model tag stored on meta.model.

Examples:
  PINDROP_HOST=pindrop-comments.acme.workers.dev pindrop-comments read https://abc-site.acme.workers.dev
  pindrop-comments read https://abc-site.acme.workers.dev -H ... --json | jq '.[].text'
  pindrop-comments reply https://abc-site.acme.workers.dev -H ... --comment 1 --text "done"
`;

function tokenize(argv) {
  const tokens = [];
  for (const a of argv) {
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      tokens.push(a.slice(0, eq), a.slice(eq + 1));
    } else {
      tokens.push(a);
    }
  }
  return tokens;
}

export function parseArgs(argv) {
  const cfg = {
    command: "read",
    previewUrl: null,
    host: process.env.PINDROP_HOST || null,
    room: null,
    origin: null,
    party: "comments",
    watch: false,
    json: false,
    timeout: 10000,
    comment: null,
    text: null,
    selector: null,
    author: process.env.PINDROP_AUTHOR || DEFAULT_AUTHOR,
    model: null,
    help: false,
  };
  const tokens = tokenize(argv);
  const rest = [];
  let i = 0;
  if (tokens[0] && COMMANDS.has(tokens[0])) {
    cfg.command = tokens[0];
    i = 1;
  }
  for (; i < tokens.length; i++) {
    const a = tokens[i];
    const value = () => {
      const v = tokens[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        cfg.help = true;
        break;
      case "-w":
      case "--watch":
        cfg.watch = true;
        break;
      case "--json":
        cfg.json = true;
        break;
      case "-H":
      case "--host":
        cfg.host = value();
        break;
      case "--room":
        cfg.room = value();
        break;
      case "--origin":
        cfg.origin = value();
        break;
      case "--party":
        cfg.party = value();
        break;
      case "--comment":
        cfg.comment = value();
        break;
      case "--text":
        cfg.text = value();
        break;
      case "--selector":
        cfg.selector = value();
        break;
      case "--author":
        cfg.author = value();
        break;
      case "--model":
        cfg.model = value();
        break;
      case "--timeout": {
        const ms = Number(value());
        if (!Number.isFinite(ms) || ms <= 0) throw new UsageError("--timeout must be a positive number");
        cfg.timeout = ms;
        break;
      }
      default:
        if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
        rest.push(a);
    }
  }
  if (rest.length > 1) throw new UsageError(`unexpected extra argument: ${rest[1]}`);
  cfg.previewUrl = rest[0] ?? null;
  return cfg;
}

export function buildWsUrl({ host, party, room }) {
  let scheme = null;
  let hostport = host;
  const m = /^([a-z]+):\/\/(.*)$/i.exec(host);
  if (m) {
    const s = m[1].toLowerCase();
    if (s === "wss" || s === "https") scheme = "wss";
    else if (s === "ws" || s === "http") scheme = "ws";
    hostport = m[2];
  }
  hostport = hostport.replace(/\/+$/, "");
  if (!scheme) {
    const bareHost = hostport.split(":")[0];
    scheme = bareHost === "localhost" || bareHost === "127.0.0.1" || bareHost === "0.0.0.0" ? "ws" : "wss";
  }
  return `${scheme}://${hostport}/parties/${encodeURIComponent(party)}/${encodeURIComponent(room)}`;
}

export function resolveTarget(cfg) {
  let { room, origin } = cfg;
  if (cfg.previewUrl) {
    let u;
    try {
      u = new URL(cfg.previewUrl);
    } catch {
      throw new UsageError(`could not parse preview URL: ${cfg.previewUrl}`);
    }
    room = room ?? u.hostname;
    origin = origin ?? u.origin;
  }
  if (!cfg.host) throw new UsageError("--host is required (or set PINDROP_HOST)");
  if (!room) throw new UsageError("room is required: pass a preview URL or --room");
  if (!origin) throw new UsageError("origin is required: pass a preview URL or --origin");
  return { wsUrl: buildWsUrl({ host: cfg.host, party: cfg.party, room }), origin, room };
}

export function ago(iso, nowMs) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso ?? "";
  const secs = Math.max(0, Math.round((nowMs - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Pins are owned by pindrop.js and opaque to the worker, so unknown shapes fall
// back to compact JSON rather than being dropped. --json always gives the raw truth.
export function formatComments(pins, { room, nowMs = Date.now() } = {}) {
  if (!Array.isArray(pins) || pins.length === 0) return `No comments yet on ${room}.`;

  const lines = [`${pins.length} comment${pins.length === 1 ? "" : "s"} on ${room}`];
  pins.forEach((c, i) => {
    lines.push("");
    if (!c || typeof c !== "object" || (c.text == null && c.author == null)) {
      lines.push(`[${i + 1}] ${JSON.stringify(c)}`);
      return;
    }
    const source = c.meta?.source ? ` (${c.meta.source}${c.meta.model ? `: ${c.meta.model}` : ""})` : "";
    const head = [`[${i + 1}]`, (c.author || "anonymous") + source, c.createdAt ? ago(c.createdAt, nowMs) : "", c.resolved ? "resolved" : "open"]
      .filter(Boolean)
      .join("  ·  ");
    lines.push(`${head}  id=${c.id ?? "?"}`);
    if (c.text) for (const ln of String(c.text).split("\n")) lines.push(`    ${ln}`);
    if (c.anchor?.selector) lines.push(`    @ ${c.anchor.selector}`);
    if (Array.isArray(c.replies)) for (const r of c.replies) lines.push(`    > ${r.author || "anonymous"}: ${r.text ?? ""}`);
  });
  return lines.join("\n");
}

// Resolve a --comment ref (a uuid or a 1-based number, "1" or "#1") to an index.
export function findCommentIndex(pins, ref) {
  if (ref == null) throw new UsageError("--comment is required (a comment id or its number from `read`)");
  const byId = pins.findIndex((c) => c && c.id === ref);
  if (byId >= 0) return byId;
  const n = Number(String(ref).replace(/^#/, ""));
  if (Number.isInteger(n) && n >= 1 && n <= pins.length) return n - 1;
  throw new UsageError(`no comment matches --comment ${ref} (have ${pins.length})`);
}

// Mutations return a new pin array, shaped to pindrop's schema. `now` and
// `newId` are injected for testability; main() passes the real clock and uuid.
// Replies union by id on the receiver's merge, so a reply needs no field bumping;
// resolve bumps updatedAt so the receiver's last-write-wins merge keeps it.

export function withReply(pins, ref, { text, author, now, newId, model }) {
  if (!text) throw new UsageError("--text is required");
  const idx = findCommentIndex(pins, ref);
  const target = pins[idx];
  const reply = { id: newId(), author, text, createdAt: now, updatedAt: now };
  if (model) reply.meta = { source: "agent", model };
  else reply.meta = { source: "agent" };
  const replies = Array.isArray(target.replies) ? target.replies : [];
  const updated = { ...target, replies: [...replies, reply] };
  const next = pins.slice();
  next[idx] = updated;
  return { pins: next, wrote: reply };
}

export function withResolve(pins, ref, { author, now }) {
  const idx = findCommentIndex(pins, ref);
  const updated = { ...pins[idx], resolved: true, resolvedBy: author, resolvedAt: now, updatedAt: now };
  const next = pins.slice();
  next[idx] = updated;
  return { pins: next, wrote: updated };
}

export function withNewComment(pins, { selector, text, author, now, newId, model }) {
  if (!selector) throw new UsageError("--selector is required to anchor a new comment");
  if (!text) throw new UsageError("--text is required");
  const comment = {
    id: newId(),
    anchor: { selector, offsetX: 0, offsetY: 0, viewportX: 0, viewportY: 0 },
    author,
    text,
    createdAt: now,
    updatedAt: now,
    resolved: false,
    replies: [],
    meta: model ? { source: "agent", model } : { source: "agent" },
  };
  return { pins: [...pins, comment], wrote: comment };
}

function applyMutation(cfg, pins) {
  const now = new Date().toISOString();
  const newId = () => crypto.randomUUID();
  const opts = { text: cfg.text, author: cfg.author, now, newId, model: cfg.model };
  if (cfg.command === "reply") return withReply(pins, cfg.comment, opts);
  if (cfg.command === "resolve") return withResolve(pins, cfg.comment, { author: cfg.author, now });
  if (cfg.command === "comment") return withNewComment(pins, { selector: cfg.selector, ...opts });
  throw new UsageError(`unknown command ${cfg.command}`);
}

// Connect and resolve with the first frame's pins (the room's init), or reject
// with a clear message on a rejected handshake or timeout.
function firstPins(ws, { wsUrl, origin, room, timeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out after ${timeout}ms waiting for ${room}.\nCheck --host is the comments Worker and that it is reachable.`));
    }, timeout);
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Could not connect to ${wsUrl}\nOrigin sent: ${origin}\n` +
            `A rejected handshake here usually means that Origin is not in the worker's ALLOWED_ORIGINS, or --host / --room is wrong.`,
        ),
      );
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (!msg || !Array.isArray(msg.pins)) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(msg.pins);
    });
  });
}

async function send(ws, data) {
  ws.send(data);
  // Let the frame flush before closing. The worker does not echo to the sender,
  // so there is nothing to await; drain the buffer, then a short grace period.
  const deadline = Date.now() + 2000;
  while (ws.bufferedAmount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
}

async function main(argv) {
  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (cfg.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (typeof WebSocket === "undefined") {
    process.stderr.write("This needs Node >= 22 (built-in WebSocket). Upgrade Node and retry.\n");
    process.exit(1);
  }

  let target;
  try {
    target = resolveTarget(cfg);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { wsUrl, origin, room } = target;
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin } });

  let pins;
  try {
    pins = await firstPins(ws, { wsUrl, origin, room, timeout: cfg.timeout });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    try {
      ws.close();
    } catch {}
    process.exit(1);
  }

  if (cfg.command === "read") {
    if (cfg.json && !cfg.watch) {
      process.stdout.write(`${JSON.stringify(pins, null, 2)}\n`);
      ws.close();
      process.exit(0);
    }
    if (!cfg.json) process.stdout.write(`${formatComments(pins, { room })}\n`);
    else process.stdout.write(`${JSON.stringify({ type: "init", pins })}\n`);
    if (!cfg.watch) {
      ws.close();
      process.exit(0);
    }
    if (!cfg.json) process.stdout.write(`\nWatching ${room} for changes. Press Ctrl-C to stop.\n`);
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (!msg || msg.type !== "sync" || !Array.isArray(msg.pins)) return;
      if (cfg.json) process.stdout.write(`${JSON.stringify(msg)}\n`);
      else process.stdout.write(`\n[update]\n${formatComments(msg.pins, { room })}\n`);
    });
    return; // stay open until Ctrl-C
  }

  // write commands
  let result;
  try {
    result = applyMutation(cfg, pins);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    ws.close();
    process.exit(err instanceof UsageError ? 2 : 1);
  }
  await send(ws, JSON.stringify({ pins: result.pins }));
  ws.close();
  if (cfg.json) process.stdout.write(`${JSON.stringify(result.wrote, null, 2)}\n`);
  else process.stdout.write(`${cfg.command} ok on ${room} (${result.pins.length} comment${result.pins.length === 1 ? "" : "s"} now).\n`);
  process.exit(0);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2));
