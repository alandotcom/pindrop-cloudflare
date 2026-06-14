// Stand-in for pindrop.js, injected via the `pindropUrl` option so the client
// module can be tested without a browser or network. Mimics the one behaviour
// that matters for the wiring: applyRemoteComments re-persists through the
// adapter (which is exactly why the client needs echo suppression).
export const state = {
  adapter: null,
  storageKey: null,
  theme: null,
  loadPromise: null,
  loadResult: undefined,
  applied: [],
  user: null,
  destroyed: false,
};

export function reset() {
  Object.assign(state, {
    adapter: null,
    storageKey: null,
    theme: null,
    loadPromise: null,
    loadResult: undefined,
    applied: [],
    user: null,
    destroyed: false,
  });
}

export const Pindrop = {
  init(opts) {
    state.adapter = opts.adapter;
    state.storageKey = opts.storageKey;
    state.theme = opts.theme;
    // The real library calls load() during init; kick it off the same way.
    state.loadPromise = Promise.resolve(opts.adapter.load()).then((pins) => {
      state.loadResult = pins;
      return pins;
    });
    return {
      applyRemoteComments(pins) {
        state.applied.push(pins);
        // Real pindrop re-saves applied state; the client must suppress this.
        state.adapter.save(pins);
      },
      setUser(user) {
        state.user = user;
      },
      destroy() {
        state.destroyed = true;
      },
    };
  },
};
