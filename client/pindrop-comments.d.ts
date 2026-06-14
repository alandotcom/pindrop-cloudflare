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
export function initPindropComments(options: PindropCommentsOptions): Promise<PindropCommentsHandle>;
export type PindropCommentsOptions = {
    /**
     * Deployed comments Worker host (no protocol).
     */
    host: string;
    /**
     * Board id shared by reviewers. Defaults to the page's
     * location.hostname (one board per preview URL).
     */
    room?: string;
    /**
     * Durable Object binding, kebab-cased. Default "comments".
     */
    party?: string;
    /**
     * Identity for attributed pins (setUser).
     */
    user?: {
        name: string;
    };
    /**
     * pindrop local cache key. Default `pindrop:<room>`.
     */
    storageKey?: string;
    theme?: "auto" | "light" | "dark";
    /**
     * Inject pindrop's stylesheet. Default true.
     */
    injectStyles?: boolean;
    /**
     * Hide pindrop's built-in "Load"/"Share"
     * (import/export) toolbar buttons. Default true: the DO is the live source of
     * truth, so they're redundant, and importing a file would broadcast over
     * everyone's board.
     */
    hideExportImport?: boolean;
    /**
     * Override the pindrop.js module URL.
     */
    pindropUrl?: string;
    /**
     * Override the partysocket module URL.
     */
    partySocketUrl?: string;
    /**
     * Override the pindrop stylesheet URL.
     */
    styleUrl?: string;
};
export type PindropCommentsHandle = {
    /**
     * The pindrop layer instance (see pindrop.js).
     */
    pindrop: any;
    /**
     * The underlying PartySocket.
     */
    socket: any;
    /**
     * Close the socket and tear down pindrop.
     */
    destroy: () => void;
};
