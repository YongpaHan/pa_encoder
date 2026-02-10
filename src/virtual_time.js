// src/virtual_time.js
//
// Deterministic virtual time engine.
// - Hooks requestAnimationFrame
// - Optionally hooks Date.now / performance.now
// - Optionally hooks setTimeout / setInterval
// - Advances time via vt.step(frames)

export function installVirtualTime({
  fps = 60,
  hookDateNow = true,
  hookPerformanceNow = true,
  hookTimers = true,
  maxTimerCallbacksPerStep = 10000,
} = {}) {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new TypeError("installVirtualTime: fps must be a positive number");
  }

  const dtMs = 1000 / fps;

  const orig = {
    requestAnimationFrame: window.requestAnimationFrame?.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame?.bind(window),

    setTimeout: window.setTimeout?.bind(window),
    clearTimeout: window.clearTimeout?.bind(window),
    setInterval: window.setInterval?.bind(window),
    clearInterval: window.clearInterval?.bind(window),

    dateNow: Date.now.bind(Date),
    perfNow: performance.now.bind(performance),
  };

  if (typeof orig.requestAnimationFrame !== "function") {
    throw new Error("installVirtualTime: requestAnimationFrame not available");
  }
  if (typeof orig.cancelAnimationFrame !== "function") {
    throw new Error("installVirtualTime: cancelAnimationFrame not available");
  }

  let running = true;
  let vNowMs = 0;

  // rAF queue
  let nextRafId = 1;
  const rafCallbacks = new Map();
  const rafQueue = [];

  function hookedRAF(cb) {
    if (!running) return orig.requestAnimationFrame(cb);
    if (typeof cb !== "function") return orig.requestAnimationFrame(cb);

    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    rafQueue.push(id);
    return id;
  }

  function hookedCancelRAF(id) {
    if (!running) return orig.cancelAnimationFrame(id);
    rafCallbacks.delete(id);
  }

  // Timers
  let nextTimerId = 1;
  const timers = new Map(); // id -> {type, dueMs, intervalMs, fn}

  function normalizeDelay(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  }

  function hookedSetTimeout(fn, delay, ...args) {
    if (!running) return orig.setTimeout(fn, delay, ...args);
    if (typeof fn !== "function") return orig.setTimeout(fn, delay, ...args);

    const id = nextTimerId++;
    const d = normalizeDelay(delay);

    timers.set(id, {
      type: "timeout",
      dueMs: vNowMs + d,
      intervalMs: 0,
      fn: () => fn(...args),
    });
    return id;
  }

  function hookedClearTimeout(id) {
    if (!running) return orig.clearTimeout(id);
    timers.delete(id);
  }

  function hookedSetInterval(fn, delay, ...args) {
    if (!running) return orig.setInterval(fn, delay, ...args);
    if (typeof fn !== "function") return orig.setInterval(fn, delay, ...args);

    const id = nextTimerId++;
    const d = normalizeDelay(delay);

    timers.set(id, {
      type: "interval",
      dueMs: vNowMs + d,
      intervalMs: d,
      fn: () => fn(...args),
    });
    return id;
  }

  function hookedClearInterval(id) {
    if (!running) return orig.clearInterval(id);
    timers.delete(id);
  }

  // Install hooks
  window.requestAnimationFrame = hookedRAF;
  window.cancelAnimationFrame = hookedCancelRAF;

  if (hookTimers) {
    if (
      typeof orig.setTimeout !== "function" ||
      typeof orig.clearTimeout !== "function"
    ) {
      throw new Error(
        "installVirtualTime: setTimeout/clearTimeout not available"
      );
    }
    if (
      typeof orig.setInterval !== "function" ||
      typeof orig.clearInterval !== "function"
    ) {
      throw new Error(
        "installVirtualTime: setInterval/clearInterval not available"
      );
    }

    window.setTimeout = hookedSetTimeout;
    window.clearTimeout = hookedClearTimeout;
    window.setInterval = hookedSetInterval;
    window.clearInterval = hookedClearInterval;
  }

  if (hookDateNow) {
    Date.now = function () {
      return running ? vNowMs : orig.dateNow();
    };
  }
  if (hookPerformanceNow) {
    performance.now = function () {
      return running ? vNowMs : orig.perfNow();
    };
  }

  function flushDueTimers() {
    let executed = 0;

    while (true) {
      if (executed > maxTimerCallbacksPerStep) {
        throw new Error(
          `VirtualTime: too many timer callbacks in a single step (>${maxTimerCallbacksPerStep}).`
        );
      }

      let nextDue = Infinity;
      for (const t of timers.values()) {
        if (t.dueMs < nextDue) nextDue = t.dueMs;
      }
      if (!(nextDue <= vNowMs)) break;

      const due = [];
      for (const [id, t] of timers.entries()) {
        if (t.dueMs <= vNowMs) due.push([id, t]);
      }
      due.sort((a, b) => a[1].dueMs - b[1].dueMs || a[0] - b[0]);

      for (const [id, t] of due) {
        if (!timers.has(id)) continue;
        executed++;

        t.fn();

        if (t.type === "timeout") {
          timers.delete(id);
        } else {
          const interval = t.intervalMs;
          let next = t.dueMs + interval;
          if (next <= vNowMs) next = vNowMs; // prevent immediate same-timestamp re-fire
          t.dueMs = next;
          timers.set(id, t);
        }
      }
    }
  }

  function flushRAFFrame() {
    const ids = rafQueue.splice(0, rafQueue.length);
    for (const id of ids) {
      const cb = rafCallbacks.get(id);
      if (!cb) continue;
      rafCallbacks.delete(id);
      cb(vNowMs);
    }
  }

  function step(frames = 1) {
    if (!running) throw new Error("VirtualTime: not running");
    if (!Number.isInteger(frames) || frames < 1) {
      throw new TypeError("VirtualTime.step: frames must be an integer >= 1");
    }

    for (let i = 0; i < frames; i++) {
      vNowMs += dtMs;
      if (hookTimers) flushDueTimers();
      flushRAFFrame();
    }
  }

  function stopVirtualTime() {
    running = false;
  }

  function restore() {
    window.requestAnimationFrame = orig.requestAnimationFrame;
    window.cancelAnimationFrame = orig.cancelAnimationFrame;

    if (hookTimers) {
      window.setTimeout = orig.setTimeout;
      window.clearTimeout = orig.clearTimeout;
      window.setInterval = orig.setInterval;
      window.clearInterval = orig.clearInterval;
    }

    if (hookDateNow) Date.now = orig.dateNow;
    if (hookPerformanceNow) performance.now = orig.perfNow;

    running = false;
    rafCallbacks.clear();
    rafQueue.length = 0;
    timers.clear();
  }

  return {
    step,
    restore,
    stopVirtualTime,
    get nowMs() {
      return vNowMs;
    },
    get dtMs() {
      return dtMs;
    },
  };
}
