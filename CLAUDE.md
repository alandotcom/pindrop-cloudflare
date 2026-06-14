# Pindrop hosted comments (notes for Claude)

Reusable Cloudflare project that adds durable, multiplayer Pindrop comments to
preview deploys. A PartyServer Worker holds one Durable Object room per preview
branch; a framework-agnostic client module wires pindrop.js to that room over a
PartySocket. See README.md for setup and the user-facing story; this file
captures what isn't obvious from reading the code.

## Layout

- `src/index.ts`: the Worker. DO class `Comments` (one room per branch),
  exported origin gate (`isAllowedOrigin` / `parseAllowedOrigins`), a 14-day
  idle alarm, and a 512 KiB frame cap.
- `client/pindrop-comments.js`: vanilla ESM `initPindropComments(options)`.
  Loads pindrop.js + partysocket from esm.sh. Owns the hydration handshake, echo
  suppression, and the room-from-hostname default.
- `client/pindrop-comments.d.ts`: generated from the module's JSDoc and
  committed (consumers importing the raw file need it present). Regenerate with
  `bun run types:client` after editing the JSDoc; do not hand-edit.
- pindrop.js + partysocket are type-only devDependencies. The module loads them
  from a CDN at runtime, but the dynamic `import(url)` is `any`, so the casts to
  `typeof import("pindrop.js")` / `typeof import("partysocket").default` give the
  implementation real types. `bun run typecheck:client` enforces it (checkJs).
  The public d.ts deliberately keeps the handle's `pindrop`/`socket` as `any` so
  it stays self-contained (no package types leak to consumers).
- `bin/pindrop-comments.mjs`: zero-dependency CLI to read and respond to a
  board from a terminal or agent (`read` / `reply` / `comment` / `resolve`).
  Wired as the package `bin`; agents run it via `npx github:alandotcom/pindrop-cloudflare`.
  Pure helpers are exported and unit-tested; `main()` runs only when invoked directly.
- `skills/pindrop-comments/SKILL.md`: thin Claude Code skill that points an
  agent at the CLI and defers all flag detail to `--help`. Keep it lightweight;
  the CLI's `--help` is the source of truth, not the skill.
- `examples/demo.html`: local manual demo; exposes `window.pindropComments`.
- `test/comments.test.ts`: worker tests (vitest-pool-workers, run in workerd).
- `test/client/*.test.mjs`: client tests (`node --test`) with stub
  pindrop/partysocket injected via the module's own URL options;
  `test/client/cli.test.mjs` covers the CLI's pure helpers and write shapes.

## Commands

- `bun run dev` / `bun run deploy` / `bun run build` (dry-run bundle)
- `bun run types` regenerates `worker-configuration.d.ts`. Rerun it after any
  edit to wrangler.jsonc.
- `bun run typecheck` is `tsc --noEmit`.
- `bun run test` (worker) and `bun run test:client` (client). `bun run test:all`
  runs both.
- `bun run smoke` runs an over-the-wire WebSocket check against a running
  `bun run dev`.
- `bun run comments -- <args>` runs the CLI locally (same as the `bin`).

## Releasing

- Consumers import the client over jsDelivr pinned to a git tag, so a release is
  just an annotated tag on `main` (`git tag -a v0.0.2 -m v0.0.2 && git push
  origin v0.0.2`), plus bumping the `@v…` in the README's CDN URLs. The first
  release is `v0.0.1`.
- Pin docs/examples to an exact tag, never `@main`. A tagged jsDelivr URL is
  immutable and cached ~1 year; `@main` is cached 12h and mutates on every push;
  a range (`@0.0`/`@latest`) is cached 7d and auto-rolls consumers onto new
  (possibly breaking, since `0.x`) releases. See README "Releasing".

## Gotchas, read before editing

- **Generated types.** `worker-configuration.d.ts` is gitignored, so a fresh
  clone has to run `bun run types` before typecheck passes. That file defines
  the global `Env`, where `ALLOWED_ORIGINS` is a string *literal* type.
- **Why there is no hand-written `interface Env`.** partyserver constrains
  `Env extends Cloudflare.Env`. A local interface typing `ALLOWED_ORIGINS` as
  `string` is wider than the generated literal and fails the constraint. Rely on
  the generated ambient `Env` instead.
- **Test-tooling versions are coupled.** `@cloudflare/vitest-pool-workers` 0.16+
  needs vitest 4 and uses the `cloudflareTest()` plugin in `vitest.config.ts`
  (the older `defineWorkersConfig` / `poolOptions.workers` API is gone). The
  `cloudflare:test` ambient types moved to the `/types` subpath (see
  tsconfig `types`). partyserver reads `this.ctx.id.name`, so the pool's bundled
  workerd has to be recent enough to expose it; an older one throws "Cannot
  determine the name for Comments".
- **Two separate test environments.** Worker tests are `*.test.ts` and run in
  workerd; vitest `include` is scoped to `.ts` on purpose. Client tests are
  `*.test.mjs` and run in Node. Keep them apart.
- **WebSocket test race.** Attach the message listener before calling
  `accept()`, or the immediate `init` frame can slip past unobserved (this was a
  real flake; see `connect()` in test/comments.test.ts).
- **Client hydration model.** A single `firstInit` promise is both pindrop's
  `load()` value and the gate that `sync` frames await. This is deliberate: it
  makes "sync arrives before the first init" impossible to mis-apply. Don't
  reintroduce separate `resolveLoad` / buffered-pins variables.
- **Access model is origin-only by design.** The user chose an Origin check over
  tokens or per-user auth. Don't add auth as a "fix"; if asked, extend
  `onBeforeConnect` in src/index.ts (the room and request are both available
  there). `ALLOWED_ORIGINS` is a comma-separated list of host patterns matched in
  `isAllowedOrigin`: `*suffix` is a glob (host ends with everything after the
  `*`, e.g. `*-site.acme.workers.dev` for one worker's preview URLs, which
  excludes the bare `site.acme.workers.dev`), `.suffix` matches any subdomain, a
  bare `host` matches exactly, and a missing Origin is rejected. Configuring it
  shouldn't require reading src/index.ts; if it does, this note is stale.
- **ALLOWED_ORIGINS is set out-of-band, not committed.** `wrangler.jsonc` has
  `keep_vars: true`, so `wrangler deploy` never pushes the config `vars`; the
  committed `ALLOWED_ORIGINS` is only the dev/test default (generic platform
  examples that the worker tests rely on). Each deployment sets its own live
  value via the dashboard or a one-off `wrangler deploy --var
  ALLOWED_ORIGINS:'...'` (`--var` applies on that deploy; `keep_vars` preserves
  it afterward). Don't commit a real or private preview host into wrangler.jsonc,
  and don't drop `keep_vars` (a plain deploy would then clobber the live gate
  with the example list).
- **Platform-neutral by design.** Only the comments Worker requires Cloudflare;
  the site being commented on can run anywhere. The client module makes no
  platform assumption. `room` defaults to `globalThis.location?.hostname` (one
  board per preview URL), so no branch env var is needed. Cloudflare-flavored
  bits are confined to the examples and the `ALLOWED_ORIGINS` default; those are
  conveniences, not requirements. Don't reintroduce a hard dependency on
  `WORKERS_CI_BRANCH` or any single host.
- **Demo query params.** The static server strips the query string off the
  `.html` form on redirect, so the demo's `?room=`/`?host=` overrides only work
  on the extensionless `/examples/demo` URL.
- **CLI writes must match pindrop's schema, not just the worker's.** The worker
  stores the pin array opaquely, so a write is only correct if a reviewer's
  pindrop renders it. The CLI's write builders mirror `Comment`/`Reply` from
  pindrop's `core/types`, verified against the installed source: ids are
  `crypto.randomUUID()`; `unread` is never written (pindrop's adapter strips it
  on save and recomputes it per-client from a local read-ids set); a reply is
  appended to `replies[]` and does **not** bump the parent's `updatedAt`, since
  pindrop's `applyRemoteComments` merge unions replies by id but resolves the
  comment's own fields by newest `updatedAt` (bumping would clobber a concurrent
  human edit); `resolve` **does** bump `updatedAt` so that same merge keeps it.
  Agent-authored items carry `meta.source: "agent"`. If you bump the pindrop
  version, re-verify these against `node_modules/pindrop.js/dist`.
- **The origin gate does not stop a local agent, by design.** A non-browser
  client sets its own `Origin`, so the CLI passes `isAllowedOrigin` with the
  preview's own origin. That is intended (the gate stops stray browsers, not
  trusted tooling); it is the same access model as a reviewer's browser. Don't
  "fix" it by adding auth here without reading the Access model note above.

## External APIs (verified against installed versions)

- pindrop.js@0.1.28: `Pindrop.init({ storageKey, theme, adapter: { load, save } })`,
  `applyRemoteComments`, `setComments`, `setUser`, `addComment({ selector | x/y, body })`,
  `getComments`, `destroy`.
- partyserver 0.5.7: `routePartykitRequest(req, env, { onBeforeConnect(req, lobby) })`;
  reject by returning a `Response`. Routes a room to its DO via `idFromName(<room>)`.
  `broadcast(msg, without[])`. Hibernation via `static options = { hibernate: true }`.
- partysocket: default export, `{ host, party, room }`, buffers outbound frames
  while reconnecting.
