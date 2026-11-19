// Sliding-window failure counter keyed by string (e.g. client IP).
function createLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  let lastSweep = now();

  // Lazy purge (no timers): drop every key whose failures all expired.
  function sweep() {
    const t = now();
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    const cutoff = t - windowMs;
    for (const [k, list] of hits) {
      if (!list.some((x) => x > cutoff)) hits.delete(k);
    }
  }

  function recent(key) {
    const cutoff = now() - windowMs;
    const list = (hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    isBlocked(key) {
      return recent(key).length >= max;
    },
    fail(key) {
      sweep();
      const list = recent(key);
      list.push(now());
      hits.set(key, list);
    },
    size() {
      return hits.size;
    },
    reset(key) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
  };
}

module.exports = { createLimiter };
