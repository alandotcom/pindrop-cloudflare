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
  Loads pindrop.js + partysocket from esm.sh. Owns the hydration handshake and
  echo suppression.
- `integrations/astro/PindropFeedback.astro`: build-time-gated wrapper that
  dynamic-imports the client; emits nothing on the prod build.
- `examples/demo.html`: local manual demo; exposes `window.pindropComments`.
- `test/comments.test.ts`: worker tests (vitest-pool-workers, run in workerd).
- `test/client/*.test.mjs`: client tests (`node --test`) with stub
  pindrop/partysocket injected via the module's own URL options.

## Commands

- `bun run dev` / `bun run deploy` / `bun run build` (dry-run bundle)
- `bun run types` regenerates `worker-configuration.d.ts`. Rerun it after any
  edit to wrangler.jsonc.
- `bun run typecheck` is `tsc --noEmit`.
- `bun run test` (worker) and `bun run test:client` (client). `bun run test:all`
  runs both.
- `bun run smoke` runs an over-the-wire WebSocket check against a running
  `bun run dev`.

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
- **Access model is origin-only by design.** The user chose an Origin-suffix
  check over tokens or per-user auth. Don't add auth as a "fix"; if asked,
  extend `onBeforeConnect` in src/index.ts (the room and request are both
  available there).
- **Demo query params.** The static server strips the query string off the
  `.html` form on redirect, so the demo's `?room=`/`?host=` overrides only work
  on the extensionless `/examples/demo` URL.

## External APIs (verified against installed versions)

- pindrop.js@0.1.28: `Pindrop.init({ storageKey, theme, adapter: { load, save } })`,
  `applyRemoteComments`, `setComments`, `setUser`, `addComment({ selector | x/y, body })`,
  `getComments`, `destroy`.
- partyserver 0.5.7: `routePartykitRequest(req, env, { onBeforeConnect(req, lobby) })`;
  reject by returning a `Response`. Routes a room to its DO via `idFromName(<room>)`.
  `broadcast(msg, without[])`. Hibernation via `static options = { hibernate: true }`.
- partysocket: default export, `{ host, party, room }`, buffers outbound frames
  while reconnecting.
