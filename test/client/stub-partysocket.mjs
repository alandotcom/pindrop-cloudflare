// Stand-in for partysocket, injected via the `partySocketUrl` option. Records
// sent frames and lets a test drive inbound messages via _emit().
export const sockets = [];

export function reset() {
  sockets.length = 0;
}

export default class PartySocket {
  constructor(opts) {
    this.opts = opts;
    this.sent = [];
    this.closed = false;
    this._listeners = new Map();
    sockets.push(this);
  }

  addEventListener(type, fn) {
    const list = this._listeners.get(type) ?? [];
    list.push(fn);
    this._listeners.set(type, list);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  /** Test helper: deliver an inbound frame to registered listeners. */
  _emit(type, event) {
    for (const fn of this._listeners.get(type) ?? []) fn(event);
  }

  /** Test helper: deliver a JSON message frame. */
  _message(obj) {
    this._emit("message", { data: JSON.stringify(obj) });
  }
}
