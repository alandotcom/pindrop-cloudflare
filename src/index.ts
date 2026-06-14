import { routePartykitRequest, Server, type Connection } from "partyserver";

// One Comments room per board id (we use the preview branch name). PartyServer
// maps the URL's room segment to a dedicated Durable Object instance, so each
// preview gets an isolated board that never collides with another's.
//
// The `Env` type (the `Comments` DO binding and the `ALLOWED_ORIGINS` var from
// wrangler.jsonc) is generated into worker-configuration.d.ts by `wrangler
// types`. Rerun that after changing wrangler.jsonc.

// Pindrop hands the client its entire Comment[] array on every change. We
// persist and rebroadcast it as an opaque blob; the client owns the schema.
type Pins = unknown[];

// Reclaim a board this long after the last time anyone connected to or wrote to
// it. Opening the preview counts as activity, so a board lives as long as the
// preview is still being reviewed and is reclaimed once a closed PR's preview
// stops being opened. (A client stuck in a reconnect loop would keep its board
// alive; that's an acceptable edge for a preview-only tool.)
const IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Reject oversized frames so one reviewer can't wedge a board's storage. A
// whole preview's pin array is far smaller than this.
const MAX_FRAME_BYTES = 512 * 1024; // 512 KiB

const PINS_KEY = "pins";

// Exported for unit testing. True when `origin`'s host matches one of the
// allowed suffixes. Returns false for a missing or unparseable origin, so a
// non-browser client with no Origin header is rejected rather than allowed.
export function isAllowedOrigin(origin: string, allowed: string[]): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return allowed.some((suffix) =>
    suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix,
  );
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export class Comments extends Server<Env> {
  // Hibernation evicts the idle DO from memory while keeping its sockets
  // attached, so an idle review board incurs no duration billing.
  static override options = { hibernate: true };

  override async onConnect(connection: Connection) {
    const pins = (await this.ctx.storage.get<Pins>(PINS_KEY)) ?? [];
    connection.send(JSON.stringify({ type: "init", pins }));
    await this.bumpIdleAlarm();
  }

  override async onMessage(connection: Connection, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    if (message.length > MAX_FRAME_BYTES) return;

    let pins: unknown;
    try {
      ({ pins } = JSON.parse(message) as { pins?: unknown });
    } catch {
      return; // ignore malformed frames rather than tearing down the socket
    }
    if (!Array.isArray(pins)) return;

    await this.ctx.storage.put(PINS_KEY, pins);
    await this.bumpIdleAlarm();

    // Fan out to everyone except the sender. Last write wins, which is fine for
    // the handful of reviewers a single preview attracts.
    this.broadcast(JSON.stringify({ type: "sync", pins }), [connection.id]);
  }

  override async onAlarm() {
    await this.ctx.storage.deleteAll();
  }

  private bumpIdleAlarm() {
    return this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);

    const response = await routePartykitRequest(request, env, {
      // The preview site is public, so this Origin gate is the only thing
      // between a stranger and a board. Tighten ALLOWED_ORIGINS to your exact
      // preview host(s) in wrangler.jsonc before relying on it.
      onBeforeConnect(req) {
        const origin = req.headers.get("Origin") ?? "";
        if (!isAllowedOrigin(origin, allowed)) {
          return new Response("forbidden origin", { status: 403 });
        }
      },
    });

    return response ?? new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
