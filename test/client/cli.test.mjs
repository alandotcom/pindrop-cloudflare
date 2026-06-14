// Unit tests for the pindrop-comments CLI's pure helpers. The CLI itself opens
// a WebSocket; these cover the parsing, URL building, targeting, and the
// read-modify-write mutations that have to match pindrop's Comment/Reply schema.
// node --test, like the other test/client/*.test.mjs files.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  buildWsUrl,
  resolveTarget,
  findCommentIndex,
  withReply,
  withResolve,
  withNewComment,
  formatComments,
  ago,
} from "../../bin/pindrop-comments.mjs";

const NOW = "2026-06-14T12:00:00.000Z";
const newId = () => "fixed-id";

function sampleComment(over = {}) {
  return {
    id: "c1",
    anchor: { selector: "h1", offsetX: 0, offsetY: 0, viewportX: 0, viewportY: 0 },
    author: "Reviewer",
    text: "header overlaps logo",
    createdAt: "2026-06-14T11:00:00.000Z",
    updatedAt: "2026-06-14T11:00:00.000Z",
    resolved: false,
    replies: [],
    ...over,
  };
}

test("parseArgs: command detection and defaults", () => {
  const cfg = parseArgs(["read", "https://abc.example", "--host", "h.example"]);
  assert.equal(cfg.command, "read");
  assert.equal(cfg.previewUrl, "https://abc.example");
  assert.equal(cfg.host, "h.example");
  assert.equal(cfg.party, "comments");
});

test("parseArgs: defaults to read when no command given", () => {
  const cfg = parseArgs(["https://abc.example"]);
  assert.equal(cfg.command, "read");
  assert.equal(cfg.previewUrl, "https://abc.example");
});

test("parseArgs: supports --key=value and short flags", () => {
  const cfg = parseArgs(["reply", "https://abc.example", "--comment=2", "-H", "h", "--text=hi", "-w"]);
  assert.equal(cfg.command, "reply");
  assert.equal(cfg.comment, "2");
  assert.equal(cfg.text, "hi");
  assert.equal(cfg.watch, true);
});

test("parseArgs: rejects unknown options and bad timeout", () => {
  assert.throws(() => parseArgs(["read", "--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["read", "--timeout", "0"]), /positive number/);
});

test("buildWsUrl: wss by default, ws for localhost, scheme honored", () => {
  assert.equal(
    buildWsUrl({ host: "pindrop-comments.acme.workers.dev", party: "comments", room: "abc.example" }),
    "wss://pindrop-comments.acme.workers.dev/parties/comments/abc.example",
  );
  assert.equal(buildWsUrl({ host: "localhost:8787", party: "comments", room: "demo" }), "ws://localhost:8787/parties/comments/demo");
  assert.equal(buildWsUrl({ host: "http://127.0.0.1:8787", party: "comments", room: "demo" }), "ws://127.0.0.1:8787/parties/comments/demo");
  assert.equal(buildWsUrl({ host: "https://h/", party: "comments", room: "r" }), "wss://h/parties/comments/r");
});

test("resolveTarget: derives room and origin from the preview URL", () => {
  const t = resolveTarget(parseArgs(["read", "https://abc-site.acme.workers.dev/some/path", "--host", "h.example"]));
  assert.equal(t.room, "abc-site.acme.workers.dev");
  assert.equal(t.origin, "https://abc-site.acme.workers.dev");
  assert.equal(t.wsUrl, "wss://h.example/parties/comments/abc-site.acme.workers.dev");
});

test("resolveTarget: explicit room/origin win, missing host errors", () => {
  const t = resolveTarget(parseArgs(["read", "https://abc.example", "--host", "h", "--room", "feat-x", "--origin", "https://o.example"]));
  assert.equal(t.room, "feat-x");
  assert.equal(t.origin, "https://o.example");
  assert.throws(() => resolveTarget(parseArgs(["read", "https://abc.example"])), /--host is required/);
});

test("findCommentIndex: by id, by 1-based number, by #n", () => {
  const pins = [sampleComment({ id: "a" }), sampleComment({ id: "b" })];
  assert.equal(findCommentIndex(pins, "b"), 1);
  assert.equal(findCommentIndex(pins, "1"), 0);
  assert.equal(findCommentIndex(pins, "#2"), 1);
  assert.throws(() => findCommentIndex(pins, "9"), /no comment matches/);
  assert.throws(() => findCommentIndex(pins, null), /--comment is required/);
});

test("withReply: appends an agent-tagged reply without mutating input", () => {
  const pins = [sampleComment()];
  const { pins: next, wrote } = withReply(pins, "1", { text: "on it", author: "Agent", now: NOW, newId });
  assert.equal(pins[0].replies.length, 0, "original is untouched");
  assert.deepEqual(next[0].replies, [{ id: "fixed-id", author: "Agent", text: "on it", createdAt: NOW, updatedAt: NOW, meta: { source: "agent" } }]);
  assert.equal(wrote.text, "on it");
  // Reply does not bump the parent's updatedAt: replies union by id on merge,
  // so we avoid clobbering the comment's own scalar fields.
  assert.equal(next[0].updatedAt, pins[0].updatedAt);
});

test("withReply: requires text", () => {
  assert.throws(() => withReply([sampleComment()], "1", { author: "Agent", now: NOW, newId }), /--text is required/);
});

test("withResolve: sets resolved and bumps updatedAt so the merge keeps it", () => {
  const pins = [sampleComment()];
  const { pins: next } = withResolve(pins, "1", { author: "Agent", now: NOW });
  assert.equal(next[0].resolved, true);
  assert.equal(next[0].resolvedBy, "Agent");
  assert.equal(next[0].resolvedAt, NOW);
  assert.equal(next[0].updatedAt, NOW);
  assert.equal(pins[0].resolved, false, "original is untouched");
});

test("withNewComment: builds a selector-anchored, agent-tagged comment", () => {
  const { pins: next, wrote } = withNewComment([], { selector: "header .logo", text: "moved", author: "Agent", now: NOW, newId, model: "opus" });
  assert.equal(next.length, 1);
  assert.deepEqual(wrote.anchor, { selector: "header .logo", offsetX: 0, offsetY: 0, viewportX: 0, viewportY: 0 });
  assert.equal(wrote.resolved, false);
  assert.deepEqual(wrote.replies, []);
  assert.deepEqual(wrote.meta, { source: "agent", model: "opus" });
  assert.equal(wrote.id, "fixed-id");
  assert.equal("unread" in wrote, false, "unread is per-client, never written");
});

test("withNewComment: requires selector and text", () => {
  assert.throws(() => withNewComment([], { text: "x", author: "Agent", now: NOW, newId }), /--selector is required/);
  assert.throws(() => withNewComment([], { selector: "h1", author: "Agent", now: NOW, newId }), /--text is required/);
});

test("formatComments: empty and populated", () => {
  assert.equal(formatComments([], { room: "abc" }), "No comments yet on abc.");
  const out = formatComments([sampleComment({ replies: [{ author: "Sam", text: "ack" }] })], { room: "abc", nowMs: Date.parse(NOW) });
  assert.match(out, /1 comment on abc/);
  assert.match(out, /header overlaps logo/);
  assert.match(out, /@ h1/);
  assert.match(out, /> Sam: ack/);
});

test("ago: relative formatting", () => {
  const now = Date.parse(NOW);
  assert.equal(ago(NOW, now), "0s ago");
  assert.equal(ago("2026-06-14T11:59:00.000Z", now), "1m ago");
  assert.equal(ago("2026-06-14T10:00:00.000Z", now), "2h ago");
  assert.equal(ago("not-a-date", now), "not-a-date");
});
