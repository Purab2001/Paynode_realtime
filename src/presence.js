/** Who is online. A person with two tabs open counts once. In memory, so it assumes a single server instance. */
export class Presence {
  #sockets = new Map(); // userId -> number of open sockets

  /** Returns true when this connection made the user come online. */
  add(userId) {
    const next = (this.#sockets.get(userId) ?? 0) + 1;
    this.#sockets.set(userId, next);
    return next === 1;
  }

  /** Returns true when this was the user's last connection. */
  remove(userId) {
    const next = (this.#sockets.get(userId) ?? 1) - 1;
    if (next <= 0) {
      this.#sockets.delete(userId);
      return true;
    }
    this.#sockets.set(userId, next);
    return false;
  }

  has = (userId) => this.#sockets.has(userId);
}
