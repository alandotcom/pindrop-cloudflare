# Pindrop live comments on Cloudflare

Durable, multiplayer [Pindrop](https://pindropjs.com) comment boards for site
preview deployments. Reviewers drop pins on a preview URL and see each other's
comments in real time. One Durable Object room per preview (keyed by branch),
WebSocket push, hibernation while idle, and a 14-day self-cleanup.

The backend is a single Cloudflare Worker. The client is one framework-agnostic
ES module you drop into any site. The README shows a plain-HTML snippet and an
Astro example, but nothing here is tied to a particular framework.

## How it works

- **Room = preview.** The client connects to `/parties/comments/<room>`. The
  room defaults to the page's hostname, so everyone on the same preview URL
  shares a board with no build-time wiring; pass `room` explicitly for a stable
  per-branch board. PartyServer routes each room to its own Durable Object, so
  boards never collide across previews.
- **Last write wins.** Pindrop hands the client its entire comment array on every
  change. The client sends that array up; the Worker persists it and rebroadcasts
  it to the other connected sockets. Fine for the handful of reviewers a preview
  attracts.
- **Echo-suppressed merge.** Inbound state is applied with
  `applyRemoteComments`, guarded so it never bounces back out as a fresh write.
- **Cheap while idle.** Hibernation evicts the idle DO from memory while keeping
  sockets attached. An idle alarm reclaims a board 14 days after the last time
  anyone connected or wrote to it; opening the preview counts, so a board lives
  as long as the preview is still being reviewed.
- **Resilient.** PartySocket reconnects with backoff and buffers writes while
  offline. On reconnect the room replays its `init` frame and the client
  reconciles.

## Repo layout

```
src/index.ts                               the comments Worker (PartyServer + DO)
client/pindrop-comments.js                 framework-agnostic drop-in (initPindropComments)
client/pindrop-comments.d.ts               generated types (bun run types:client)
examples/demo.html                         local two-window multiplayer demo
test/comments.test.ts                      worker tests (vitest-pool-workers, run in workerd)
test/client/                               client-wiring tests + injected stubs (node --test)
scripts/smoke.mjs                          over-the-wire smoke test vs. `wrangler dev`
```

## 1. Deploy the comments Worker

```bash
bun install
bun run types      # generates worker-configuration.d.ts from wrangler.jsonc
bun run deploy
```

Note the deployed host from the output, e.g.
`pindrop-comments.YOUR_SUBDOMAIN.workers.dev`.

Then lock down who can open a board. The only access gate is an `Origin` check,
configured by the `ALLOWED_ORIGINS` var in `wrangler.jsonc`, a comma-separated
list of host suffixes. Set it to wherever your preview site is hosted, which can
be any platform (the comments Worker runs on Cloudflare; the site it comments on
need not):

```jsonc
"vars": {
  // A leading dot matches subdomains of that host; a bare host matches exactly.
  // Examples by platform: Cloudflare .pages.dev / .workers.dev,
  // Vercel .vercel.app, Netlify .netlify.app.
  "ALLOWED_ORIGINS": ".vercel.app,localhost,127.0.0.1"
}
```

Trim this to your exact preview host(s) before relying on it. Rerun
`bun run deploy` after changing it. See [Access model](#access-model) for the
limits of an origin-only gate.

## 2. Add the client to your site

The client loads `pindrop.js` and `partysocket` from a CDN, so nothing has to be
bundled. Host `client/pindrop-comments.js` somewhere your site can import it:
self-host a copy, or reference this repo through a CDN such as
`https://cdn.jsdelivr.net/gh/YOUR_ORG/pindrop-hosted@main/client/pindrop-comments.js`.

### Any site (plain HTML / any framework)

Drop this in. `host` is the only value you must supply; `room` defaults to the
page's hostname, so reviewers on the same preview URL share a board:

```html
<script type="module">
  import { initPindropComments } from "/path/to/pindrop-comments.js";

  initPindropComments({
    host: "pindrop-comments.YOUR_SUBDOMAIN.workers.dev",
    user: { name: "Alan" },           // optional: attributes pins
    // room: "my-feature-branch",     // optional: stable board per branch
  });
</script>
```

To keep comments off your production site, either include this only on preview
builds, or guard it at runtime, e.g.
`if (location.hostname !== "yoursite.com") initPindropComments({ host });`.

`initPindropComments` returns `{ pindrop, socket, destroy() }` if you need to
tear it down.

### Types

A generated `client/pindrop-comments.d.ts` ships next to the module. Copy both
files into your project and import by path, and TypeScript resolves the types
with no extra config:

```ts
import { initPindropComments, type PindropCommentsOptions } from "./lib/pindrop-comments.js";
```

Importing from a CDN by URL is untyped by default. Map the URL to the local
declaration in a project `.d.ts`:

```ts
declare module "https://cdn.jsdelivr.net/gh/YOUR_ORG/pindrop-hosted@main/client/pindrop-comments.js" {
  export * from "./types/pindrop-comments";
}
```

The module is plain JS with JSDoc, so the declaration is generated from it.
Regenerate after editing the JSDoc with `bun run types:client`.

### Astro

There's no component to install, and no build-time env var to wire up (the room
defaults to the preview hostname). Use the snippet as an `is:inline` script in
your base layout, guarded so it doesn't run on your production host. `is:inline`
matters: it stops Astro's bundler from rewriting the runtime `import()`.

In your base layout (e.g. `src/layouts/Base.astro`), just before `</body>`:

```astro
<script is:inline define:vars={{
  prodHost: "yoursite.com",
  host: "pindrop-comments.YOUR_SUBDOMAIN.workers.dev",
  clientUrl: "https://cdn.jsdelivr.net/gh/YOUR_ORG/pindrop-hosted@main/client/pindrop-comments.js",
}}>
  {`if (location.hostname !== prodHost) {
    import(clientUrl)
      .then(({ initPindropComments }) => initPindropComments({ host }))
      .catch((err) => console.error("[pindrop] init failed:", err));
  }`}
</script>
```

Press `c` on a preview URL to drop a pin, `v` to return to view mode. To strip
the script from the production build entirely instead of no-op'ing at runtime,
wrap it in a conditional gated on a preview flag your CI exposes, such as
`WORKERS_CI_BRANCH` on Cloudflare or `VERCEL_GIT_COMMIT_REF` on Vercel.

## Local development & testing

Run the worker and the demo page, then open the demo in two windows:

```bash
bun run dev          # worker on http://localhost:8787
bun run serve:demo   # static server on http://localhost:3000
# open http://localhost:3000/examples/demo in two windows
```

Both windows share the `demo` room by default. Drop a pin in one and it appears
in the other. Override the target with `?host=…&room=…` (use the extensionless
`/examples/demo` URL; the static server strips the query string off the
`.html` form on redirect).

Checks:

```bash
bun run typecheck        # worker: tsc --noEmit
bun run typecheck:client # client module: checkJs against the real pindrop/partysocket types
bun run test             # worker: origin gate, init, broadcast, isolation, alarm (vitest-pool-workers)
bun run test:client      # client wiring: hydrate, echo suppression, reconnect, validation (node --test)
bun run test:all         # both test suites
bun run build            # wrangler dry-run bundle
```

There's also an over-the-wire smoke test against a running `bun run dev`, which
connects real WebSockets and checks the origin gate, the init frame, and a
cross-client broadcast:

```bash
bun run smoke
```

## Access model

The preview site is public, so the `Origin` gate is the only thing between a
stranger and a board. It stops a page on an unlisted host from connecting, but
anyone who can load a matching preview can read and write its board. That's the
right trade-off for trusted internal previews. If you need more, like a shared
token or per-user auth with attributed access, add it in `onBeforeConnect` in
`src/index.ts`; the room and request are both available there.

## Cleanup

The idle alarm reclaims a board 14 days after it was last opened or written to
(`IDLE_TTL_MS` in `src/index.ts`). For deterministic teardown when a PR closes, add a
`pull_request: closed` webhook that opens the room and clears the pins, or point
it at an HTTP route on the Worker that calls `storage.deleteAll()`.
