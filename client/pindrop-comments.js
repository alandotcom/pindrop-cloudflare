// Framework-agnostic drop-in for live, multiplayer Pindrop comments.
//
// Wires pindrop.js (the on-page comment overlay) to a PartyServer room over a
// PartySocket, so every reviewer on the same preview shares one live board.
// pindrop.js and partysocket are loaded from a CDN by default, so nothing has
// to be bundled into the host site. Pass `pindropUrl` / `partySocketUrl` to
// pin different versions, or a same-origin path to self-host.
//
//   import { initPindropComments } from ".../client/pindrop-comments.js";
//   initPindropComments({ host: "pindrop-comments.you.workers.dev" });
//
// `host` is the only required value. `room` defaults to the page's hostname, so
// reviewers on the same preview URL share a board with no build-time branch
// variable; pass `room` explicitly for a stable per-branch board. Nothing here
// assumes a particular host platform.
//
// Returns a handle: { pindrop, socket, destroy() }.

const PINDROP_VERSION = "0.1.28";
const PARTYSOCKET_VERSION = "1.1.19";

const DEFAULTS = {
  party: "comments", // kebab-case of the "Comments" Durable Object binding
  theme: "auto",
  injectStyles: true,
  hideExportImport: true,
  pindropUrl: `https://esm.sh/pindrop.js@${PINDROP_VERSION}`,
  partySocketUrl: `https://esm.sh/partysocket@${PARTYSOCKET_VERSION}`,
  styleUrl: `https://unpkg.com/pindrop.js@${PINDROP_VERSION}/dist/style.css`,
};

/**
 * @typedef {Object} PindropCommentsOptions
 * @property {string} host  Deployed comments Worker host (no protocol).
 * @property {string} [room]  Board id shared by reviewers. Defaults to the page's
 *   location.hostname (one board per preview URL).
 * @property {string} [party]  Durable Object binding, kebab-cased. Default "comments".
 * @property {{ name: string }} [user]  Identity for attributed pins (setUser).
 * @property {string} [storageKey]  pindrop local cache key. Default `pindrop:<room>`.
 * @property {"auto" | "light" | "dark"} [theme]
 * @property {boolean} [injectStyles]  Inject pindrop's stylesheet. Default true.
 * @property {boolean} [hideExportImport]  Hide pindrop's built-in "Load"/"Share"
 *   (import/export) toolbar buttons. Default true: the DO is the live source of
 *   truth, so they're redundant, and importing a file would broadcast over
 *   everyone's board.
 * @property {string} [pindropUrl]  Override the pindrop.js module URL.
 * @property {string} [partySocketUrl]  Override the partysocket module URL.
 * @property {string} [styleUrl]  Override the pindrop stylesheet URL.
 */

/**
 * @typedef {Object} PindropCommentsHandle
 * @property {any} pindrop  The pindrop layer instance (see pindrop.js).
 * @property {any} socket  The underlying PartySocket.
 * @property {() => void} destroy  Close the socket and tear down pindrop.
 */

/**
 * Start live, multiplayer Pindrop comments on the current page.
 * @param {PindropCommentsOptions} options
 * @returns {Promise<PindropCommentsHandle>}
 */
export async function initPindropComments(options) {
  const config = { ...DEFAULTS, ...options };
  const { host, party, user, theme, injectStyles } = config;

  // Reviewers on the same preview URL should land on the same board, so the room
  // defaults to this page's hostname. Pass `room` for a stable per-branch board
  // regardless of URL.
  const room = config.room ?? globalThis.location?.hostname;

  if (!host) throw new Error("initPindropComments: `host` is required");
  if (!room) {
    throw new Error(
      "initPindropComments: `room` is required here (it defaults to location.hostname, which is unavailable in this environment)",
    );
  }

  const storageKey = config.storageKey ?? `pindrop:${room}`;

  if (injectStyles) ensureStylesheet(config.styleUrl);

  const [pindropModule, partySocketModule] = await Promise.all([
    import(config.pindropUrl),
    import(config.partySocketUrl),
  ]);
  // These modules come from runtime URL strings, so TS infers them as `any`.
  // Cast to the package types (pulled in as type-only devDependencies; they
  // still load from the CDN at runtime) so the rest of the module is typed.
  const Pindrop = /** @type {typeof import("pindrop.js").Pindrop} */ (
    pindropModule.Pindrop ?? pindropModule.default
  );
  const PartySocket = /** @type {typeof import("partysocket").default} */ (
    partySocketModule.default ?? partySocketModule.PartySocket
  );

  // PartySocket reconnects with backoff and buffers outbound frames while the
  // socket is down, so `save()` below never has to care about connection state.
  const socket = new PartySocket({ host, party, room });

  // Guards the echo loop: while we apply a remote frame, pindrop's own save()
  // fires, so suppress it and an inbound merge never bounces back out.
  let applyingRemote = false;
  // The board hydrates from the room's first "init" frame. load() just returns
  // this promise, so it resolves correctly whether pindrop calls load() before
  // or after the frame arrives, since the promise *is* the buffer. `sync` frames
  // await it too, so a sync can never be applied (and then clobbered by the
  // first init) before the board has hydrated.
  let hydrated = false;
  /** @type {(pins: any) => void} */
  let resolveFirstInit;
  /** @type {Promise<any>} */
  const firstInit = new Promise((resolve) => {
    resolveFirstInit = resolve;
  });

  const pindrop = Pindrop.init({
    storageKey,
    theme: /** @type {"auto" | "light" | "dark"} */ (theme),
    adapter: {
      load: () => firstInit,
      save: (pins) => {
        if (applyingRemote) return;
        socket.send(JSON.stringify({ pins }));
      },
    },
  });

  // Must run after init: pindrop builds its toolbar (and shadow host) here.
  if (config.hideExportImport) hideExportImportButtons();

  if (user?.name) pindrop.setUser({ name: user.name });

  function applyRemote(pins) {
    applyingRemote = true;
    try {
      pindrop.applyRemoteComments(pins);
    } finally {
      applyingRemote = false;
    }
  }

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || !Array.isArray(msg.pins)) return;

    if (msg.type === "init") {
      if (hydrated) {
        applyRemote(msg.pins); // fresh init after a reconnect: reconcile
      } else {
        hydrated = true;
        resolveFirstInit(msg.pins);
      }
    } else if (msg.type === "sync") {
      firstInit.then(() => applyRemote(msg.pins));
    }
  });

  return {
    pindrop,
    socket,
    destroy() {
      socket.close();
      pindrop.destroy?.();
    },
  };
}

function ensureStylesheet(href) {
  if (document.querySelector("link[data-pindrop-style]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.pindropStyle = "";
  document.head.appendChild(link);
}

// pindrop renders its own "Load comments" (import) and "Share comments" (export)
// toolbar buttons. With the DO as the live source of truth they're redundant,
// and import is the dangerous one: it merges a chosen file and fires save(),
// which broadcasts over every reviewer's board. pindrop has no option to omit
// them, and it builds the toolbar inside a shadow root (host `#pindrop-web-root`,
// mode "open"), so a page-level stylesheet can't reach it; inject the hide rule
// into that shadow root instead. Selectors and the host id track pindrop
// internals for PINDROP_VERSION. No-op off the DOM (SSR, the node tests) or
// before the shadow host exists.
function hideExportImportButtons() {
  if (typeof document === "undefined") return;
  const shadow = document.getElementById("pindrop-web-root")?.shadowRoot;
  if (!shadow || shadow.querySelector("style[data-pindrop-hide-io]")) return;
  const style = document.createElement("style");
  style.dataset.pindropHideIo = "";
  style.textContent =
    '.pindrop-toolbar button[aria-label="Load comments"],' +
    '.pindrop-toolbar button[aria-label="Share comments"]{display:none}' +
    // and the now-dangling divider that preceded the Import button
    '.pindrop-toolbar .pindrop-toolbar-divider:has(+ button[aria-label="Load comments"]){display:none}';
  shadow.appendChild(style);
}
