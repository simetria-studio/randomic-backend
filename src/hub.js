// Internal event hub: decouples admin actions from the realtime layer.
const listeners = new Set();
let onlineCounter = null;

function emitRestricted(userId) {
  for (const fn of [...listeners]) {
    try {
      fn(userId);
    } catch (e) {
      console.error('[hub] onRestricted', e);
    }
  }
}

function onRestricted(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setOnlineCounter(fn) {
  onlineCounter = fn;
}

function onlineCount() {
  return onlineCounter ? onlineCounter() : 0;
}

module.exports = { emitRestricted, onRestricted, setOnlineCounter, onlineCount };
