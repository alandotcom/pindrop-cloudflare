// Framework-agnostic drop-in for live, multiplayer Pindrop comments.
//
// Wires pindrop.js (the on-page comment overlay) to a PartyServer room over a
// PartySocket, so every reviewer on the same preview shares one live board.
// pindrop.js and partysocket are loaded from a CDN by default, so nothing has
// to be bundled into the host site. Pass `pindropUrl` / `partySocketUrl` to
// pin different versions, or a same-origin path to self-host.
//
//   import { initPindropComments } from ".../client/pindrop-comments.js";
//   initPindropComments({ host: "pindrop-comments.you.workers.dev", room: branch });
//
// Returns a handle: { pindrop, socket, destroy() }.

const PINDROP_VERSION = "0.1.28";
const PARTYSOCKET_VERSION = "1.1.19";

const DEFAULTS = {
  party: "comments", // kebab-case of the "Comments" Durable Object binding
  theme: "auto",
  injectStyles: true,
  pindropUrl: `https://esm.sh/pindrop.js@${PINDROP_VERSION}`,
  partySocketUrl: `https://esm.sh/partysocket@${PARTYSOCKET_VERSION}`,
  styleUrl: `https://unpkg.com/pindrop.js@${PINDROP_VERSION}/dist/style.css`,
};

/**
 * @param {object} options
 * @param {string} options.host   Deployed comments Worker host (no protocol).
 * @param {string} options.room   Board id shared by reviewers, e.g. the branch.
 * @param {string} [options.party]       DO binding, kebab-cased. Default "comments".
 * @param {{name: string}} [options.user] Identity for attributed pins (setUser).
 * @param {string} [options.storageKey]   pindrop local cache key. Default per-room.
 * @param {"auto"|"light"|"dark"} [options.theme]
 * @param {boolean} [options.injectStyles] Inject pindrop's stylesheet. Default true.
 * @param {string} [options.pindropUrl]
 * @param {string} [options.partySocketUrl]
 * @param {string} [options.styleUrl]
 */
export async function initPindropComments(options) {
  const config = { ...DEFAULTS, ...options };
  const { host, room, party, user, theme, injectStyles } = config;

  if (!host) throw new Error("initPindropComments: `host` is required");
  if (!room) throw new Error("initPindropComments: `room` is required");

  const storageKey = config.storageKey ?? `pindrop:${room}`;

  if (injectStyles) ensureStylesheet(config.styleUrl);

  const [pindropModule, partySocketModule] = await Promise.all([
    import(config.pindropUrl),
    import(config.partySocketUrl),
  ]);
  const Pindrop = pindropModule.Pindrop ?? pindropModule.default;
  const PartySocket = partySocketModule.default ?? partySocketModule.PartySocket;

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
  let resolveFirstInit;
  const firstInit = new Promise((resolve) => {
    resolveFirstInit = resolve;
  });

  const pindrop = Pindrop.init({
    storageKey,
    theme,
    adapter: {
      load: () => firstInit,
      save: (pins) => {
        if (applyingRemote) return;
        socket.send(JSON.stringify({ pins }));
      },
    },
  });

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
