// A polite pause per host: turn(host, gapMs) resolves when at least gapMs have passed since the previous
// turn for that host. Turns of one host are served in order. The clock and the sleep are injectable, so
// tests need no real waiting. One gate per process: the public servers' limit is per address, so run one
// instance behind one address.
export function createGate({ now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const last = new Map();
  const chain = new Map();
  return {
    turn(host, gapMs) {
      if (!(gapMs > 0)) return Promise.resolve();
      const prev = chain.get(host) || Promise.resolve();
      const mine = prev.then(async () => {
        const wait = (last.get(host) ?? -Infinity) + gapMs - now();
        if (wait > 0) await sleep(wait);
        last.set(host, now());
      });
      chain.set(host, mine.catch(() => {}));
      return mine;
    },
  };
}
export const defaultGate = createGate();
