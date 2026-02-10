// src/live.js
async function startLiveCapture({
  canvas,
  exporter,
  fps = 30,
  concurrency = 2,
  maxQueue = 8,
  policy = "drop",
  // "drop" | "block"
  onProgress,
  signal
} = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError("canvas must be an HTMLCanvasElement");
  }
  if (!exporter || typeof exporter.write !== "function" || typeof exporter.finalize !== "function") {
    throw new TypeError("exporter must have write() and finalize()");
  }
  if (!Number.isFinite(fps) || fps <= 0)
    throw new TypeError("fps must be positive");
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new TypeError("concurrency must be >= 1");
  if (!Number.isInteger(maxQueue) || maxQueue < 0)
    throw new TypeError("maxQueue must be >= 0");
  if (policy !== "drop" && policy !== "block")
    throw new TypeError('policy must be "drop" or "block"');
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module"
  });
  await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      var _a, _b;
      if (((_a = ev.data) == null ? void 0 : _a.type) === "ready") {
        worker.removeEventListener("message", onMsg);
        resolve();
      } else if (((_b = ev.data) == null ? void 0 : _b.type) === "error") {
        worker.removeEventListener("message", onMsg);
        reject(new Error(ev.data.message || "Worker error"));
      }
    };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", reject);
  });
  const stats = {
    captured: 0,
    encoded: 0,
    written: 0,
    dropped: 0,
    queueMax: 0,
    inFlightMax: 0,
    lastBitmapMs: 0,
    bitmapMsAvg: 0,
    lastEncodeMs: 0,
    encodeMsAvg: 0,
    lastWriteMs: 0,
    writeMsAvg: 0
  };
  let stopped = false;
  let rafId = null;
  let inFlight = 0;
  const queue = [];
  const waiters = [];
  const ack = /* @__PURE__ */ new Map();
  function throwIfAborted() {
    if (signal == null ? void 0 : signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  }
  function wakeOneWaiter() {
    const w = waiters.shift();
    if (w) w();
  }
  async function enqueueFrame(item) {
    if (policy === "drop") {
      if (queue.length >= maxQueue) {
        stats.dropped++;
        if (typeof item.bitmap.close === "function") item.bitmap.close();
        onProgress == null ? void 0 : onProgress({ ...stats });
        return false;
      }
      queue.push(item);
      stats.queueMax = Math.max(stats.queueMax, queue.length);
      return true;
    }
    while (queue.length >= maxQueue) {
      await new Promise((r) => waiters.push(r));
      throwIfAborted();
      if (stopped) return false;
    }
    queue.push(item);
    stats.queueMax = Math.max(stats.queueMax, queue.length);
    return true;
  }
  function dispatchIfPossible() {
    while (!stopped && inFlight < concurrency && queue.length > 0) {
      const item = queue.shift();
      wakeOneWaiter();
      inFlight++;
      stats.inFlightMax = Math.max(stats.inFlightMax, inFlight);
      const { seq: seq2, bitmap, w, h } = item;
      const p = new Promise(
        (resolve, reject) => ack.set(seq2, { resolve, reject })
      );
      worker.postMessage(
        { type: "encode", frameIndex: seq2, bitmap, width: w, height: h },
        [bitmap]
      );
      p.catch(() => {
      });
    }
  }
  worker.addEventListener("message", async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "frame") {
      const { frameIndex: seq2, blob, encodeMs } = msg;
      stats.encoded++;
      if (typeof encodeMs === "number") {
        stats.lastEncodeMs = encodeMs;
        stats.encodeMsAvg = stats.encodeMsAvg ? stats.encodeMsAvg * 0.9 + encodeMs * 0.1 : encodeMs;
      }
      try {
        const w0 = performance.now();
        await exporter.write(seq2, blob);
        const w1 = performance.now();
        stats.written++;
        const writeMs = w1 - w0;
        stats.lastWriteMs = writeMs;
        stats.writeMsAvg = stats.writeMsAvg ? stats.writeMsAvg * 0.9 + writeMs * 0.1 : writeMs;
        const entry = ack.get(seq2);
        if (entry) entry.resolve();
      } catch (err) {
        const entry = ack.get(seq2);
        if (entry) entry.reject(err);
      } finally {
        ack.delete(seq2);
        inFlight--;
        dispatchIfPossible();
        onProgress == null ? void 0 : onProgress({ ...stats });
      }
    } else if (msg.type === "error") {
      console.error("Worker error:", msg.message);
    }
  });
  const frameIntervalMs = 1e3 / fps;
  let accMs = 0;
  let lastTickMs = null;
  let seq = 0;
  function tick(ts) {
    if (stopped) return;
    try {
      throwIfAborted();
    } catch {
      stop().catch(() => {
      });
      return;
    }
    if (lastTickMs == null) lastTickMs = ts;
    const dt = ts - lastTickMs;
    lastTickMs = ts;
    accMs += dt;
    while (accMs >= frameIntervalMs) {
      accMs -= frameIntervalMs;
      const b0 = performance.now();
      createImageBitmap(canvas).then(async (bitmap) => {
        const b1 = performance.now();
        const bitmapMs = b1 - b0;
        stats.lastBitmapMs = bitmapMs;
        stats.bitmapMsAvg = stats.bitmapMsAvg ? stats.bitmapMsAvg * 0.9 + bitmapMs * 0.1 : bitmapMs;
        if (stopped) {
          if (typeof bitmap.close === "function") bitmap.close();
          return;
        }
        stats.captured++;
        const ok = await enqueueFrame({
          seq: seq++,
          bitmap,
          w: canvas.width,
          h: canvas.height
        });
        if (ok) dispatchIfPossible();
        onProgress == null ? void 0 : onProgress({ ...stats });
      }).catch((e) => console.error("createImageBitmap failed:", e));
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (rafId != null) cancelAnimationFrame(rafId);
    while (waiters.length) wakeOneWaiter();
    for (const item of queue.splice(0, queue.length)) {
      if (typeof item.bitmap.close === "function") item.bitmap.close();
    }
    while (inFlight > 0 || ack.size > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await exporter.finalize();
    worker.terminate();
  }
  return { stop, stats };
}

// src/virtual_time.js
function installVirtualTime({
  fps = 60,
  hookDateNow = true,
  hookPerformanceNow = true,
  hookTimers = true,
  maxTimerCallbacksPerStep = 1e4
} = {}) {
  var _a, _b, _c, _d, _e, _f;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new TypeError("installVirtualTime: fps must be a positive number");
  }
  const dtMs = 1e3 / fps;
  const orig = {
    requestAnimationFrame: (_a = window.requestAnimationFrame) == null ? void 0 : _a.bind(window),
    cancelAnimationFrame: (_b = window.cancelAnimationFrame) == null ? void 0 : _b.bind(window),
    setTimeout: (_c = window.setTimeout) == null ? void 0 : _c.bind(window),
    clearTimeout: (_d = window.clearTimeout) == null ? void 0 : _d.bind(window),
    setInterval: (_e = window.setInterval) == null ? void 0 : _e.bind(window),
    clearInterval: (_f = window.clearInterval) == null ? void 0 : _f.bind(window),
    dateNow: Date.now.bind(Date),
    perfNow: performance.now.bind(performance)
  };
  if (typeof orig.requestAnimationFrame !== "function") {
    throw new Error("installVirtualTime: requestAnimationFrame not available");
  }
  if (typeof orig.cancelAnimationFrame !== "function") {
    throw new Error("installVirtualTime: cancelAnimationFrame not available");
  }
  let running = true;
  let vNowMs = 0;
  let nextRafId = 1;
  const rafCallbacks = /* @__PURE__ */ new Map();
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
  let nextTimerId = 1;
  const timers = /* @__PURE__ */ new Map();
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
      fn: () => fn(...args)
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
      fn: () => fn(...args)
    });
    return id;
  }
  function hookedClearInterval(id) {
    if (!running) return orig.clearInterval(id);
    timers.delete(id);
  }
  window.requestAnimationFrame = hookedRAF;
  window.cancelAnimationFrame = hookedCancelRAF;
  if (hookTimers) {
    if (typeof orig.setTimeout !== "function" || typeof orig.clearTimeout !== "function") {
      throw new Error(
        "installVirtualTime: setTimeout/clearTimeout not available"
      );
    }
    if (typeof orig.setInterval !== "function" || typeof orig.clearInterval !== "function") {
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
    Date.now = function() {
      return running ? vNowMs : orig.dateNow();
    };
  }
  if (hookPerformanceNow) {
    performance.now = function() {
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
          if (next <= vNowMs) next = vNowMs;
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
    }
  };
}

// src/virtual_capture.js
function findElementDeep({
  doc,
  selector,
  includeShadow = true,
  maxIframeDepth = 8,
  _depth = 0
} = {}) {
  if (!doc || _depth > maxIframeDepth) return null;
  try {
    const el = doc.querySelector(selector);
    if (el) return { el, doc };
  } catch {
  }
  if (includeShadow) {
    let all = [];
    try {
      all = doc.querySelectorAll("*");
    } catch {
      all = [];
    }
    for (const host of all) {
      const sr = host.shadowRoot;
      if (!sr) continue;
      try {
        const el = sr.querySelector(selector);
        if (el) return { el, doc };
      } catch {
      }
    }
  }
  let iframes = [];
  try {
    iframes = doc.querySelectorAll("iframe");
  } catch {
    iframes = [];
  }
  for (const f of iframes) {
    let childDoc = null;
    try {
      childDoc = f.contentDocument;
    } catch {
      childDoc = null;
    }
    if (!childDoc) continue;
    const found = findElementDeep({
      doc: childDoc,
      selector,
      includeShadow,
      maxIframeDepth,
      _depth: _depth + 1
    });
    if (found) return found;
  }
  return null;
}
function debugSnapshot(tag = "snapshot") {
  const info = {
    tag,
    href: (() => {
      try {
        return location.href;
      } catch {
        return "(no location)";
      }
    })(),
    readyState: (() => {
      try {
        return document.readyState;
      } catch {
        return "(no document)";
      }
    })(),
    canvasCount: (() => {
      try {
        return document.querySelectorAll("canvas").length;
      } catch {
        return -1;
      }
    })(),
    iframeCount: (() => {
      try {
        return document.querySelectorAll("iframe").length;
      } catch {
        return -1;
      }
    })()
  };
  console.warn("[pa_encoder]", info);
}
function waitForCanvasLiveDeep({
  selector = "canvas",
  timeoutMs = 15e3,
  pollMs = 50,
  includeShadow = true
} = {}) {
  const immediate = findElementDeep({ doc: document, selector, includeShadow });
  if (immediate == null ? void 0 : immediate.el) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let done = false;
    let intervalId = null;
    const cleanup = (observer2) => {
      if (done) return;
      done = true;
      try {
        observer2 == null ? void 0 : observer2.disconnect();
      } catch {
      }
      if (intervalId) clearInterval(intervalId);
    };
    const check = (observer2) => {
      const found = findElementDeep({ doc: document, selector, includeShadow });
      if (found == null ? void 0 : found.el) {
        cleanup(observer2);
        resolve(found);
        return;
      }
      if (performance.now() - t0 > timeoutMs) {
        cleanup(observer2);
        debugSnapshot("waitForCanvasLiveDeep timeout");
        reject(new Error(`Timed out waiting for canvas selector: ${selector}`));
      }
    };
    const observer = new MutationObserver(() => check(observer));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    intervalId = setInterval(() => check(observer), pollMs);
  });
}
function resolveCanvasFromFound(found) {
  const el = found == null ? void 0 : found.el;
  if (el instanceof HTMLCanvasElement) return el;
  throw new Error("Found element is not a canvas");
}
async function resolveCanvasWithWaitDeep({
  vt,
  selector = "canvas",
  canvasWaitFrames = 240,
  includeShadow = true
} = {}) {
  const tryResolve = () => {
    const found = findElementDeep({ doc: document, selector, includeShadow });
    if (!(found == null ? void 0 : found.el)) throw new Error("No canvas found on the page");
    return resolveCanvasFromFound(found);
  };
  try {
    return tryResolve();
  } catch (e) {
    console.warn("[pa_encoder] resolveCanvas failed:", (e == null ? void 0 : e.message) ?? e);
  }
  for (let i = 0; i < canvasWaitFrames; i++) {
    vt.step(1);
    try {
      return tryResolve();
    } catch (e) {
      console.warn("[pa_encoder] resolveCanvas failed:", (e == null ? void 0 : e.message) ?? e);
    }
  }
  throw new Error("No canvas found on the page");
}
async function virtualTimeCapture({
  fps = 60,
  canvasSelector = "canvas",
  preWaitTimeoutMs = 15e3,
  includeShadow = true,
  canvasWaitFrames = 240,
  hookDateNow = true,
  hookPerformanceNow = true,
  hookTimers = true,
  frameCount = 60,
  onFrame = null
} = {}) {
  debugSnapshot("virtualTimeCapture start");
  const foundLive = await waitForCanvasLiveDeep({
    selector: canvasSelector || "canvas",
    timeoutMs: preWaitTimeoutMs,
    includeShadow
  });
  resolveCanvasFromFound(foundLive);
  const vt = installVirtualTime({
    fps,
    hookDateNow,
    hookPerformanceNow,
    hookTimers
  });
  try {
    let canvas = await resolveCanvasWithWaitDeep({
      vt,
      selector: canvasSelector || "canvas",
      canvasWaitFrames,
      includeShadow
    });
    for (let i = 0; i < frameCount; i++) {
      vt.step(1);
      if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) {
        canvas = await resolveCanvasWithWaitDeep({
          vt,
          selector: canvasSelector || "canvas",
          canvasWaitFrames: 30,
          includeShadow
        });
      }
      if (typeof onFrame === "function") {
        await onFrame(canvas, i);
      }
    }
    return { ok: true };
  } finally {
    vt.restore();
    debugSnapshot("virtualTimeCapture end");
  }
}
async function virtualTimeCaptureFromStart({
  fps = 60,
  // caller provides a start hook (e.g. import(entry))
  start = null,
  canvasSelector = "canvas",
  includeShadow = true,
  canvasWaitFrames = 600,
  hookDateNow = true,
  hookPerformanceNow = true,
  hookTimers = true,
  frameCount = 60,
  onFrame = null
} = {}) {
  debugSnapshot("virtualTimeCaptureFromStart begin");
  const vt = installVirtualTime({
    fps,
    hookDateNow,
    hookPerformanceNow,
    hookTimers
  });
  try {
    if (typeof start === "function") {
      await start();
    }
    let canvas = await resolveCanvasWithWaitDeep({
      vt,
      selector: canvasSelector || "canvas",
      canvasWaitFrames,
      includeShadow
    });
    for (let i = 0; i < frameCount; i++) {
      vt.step(1);
      if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) {
        canvas = await resolveCanvasWithWaitDeep({
          vt,
          selector: canvasSelector || "canvas",
          canvasWaitFrames: 30,
          includeShadow
        });
      }
      if (typeof onFrame === "function") {
        await onFrame(canvas, i);
      }
    }
    return { ok: true };
  } finally {
    vt.restore();
    debugSnapshot("virtualTimeCaptureFromStart end");
  }
}

// src/exporters/fs.js
async function createFsExporter({
  dirNameHint = "frames",
  filename = (i) => `frame_${String(i).padStart(6, "0")}.png`
} = {}) {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("File System Access API is not supported in this browser.");
  }
  const dirHandle = await window.showDirectoryPicker({ id: dirNameHint });
  return {
    async write(frameIndex, blob) {
      const name = filename(frameIndex);
      const fileHandle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    },
    async finalize() {
    }
  };
}

// src/exporters/zip.js
import JSZip from "jszip";
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
async function createZipExporter({
  zipName = "frames.zip",
  filename = (i) => `frame_${String(i).padStart(6, "0")}.png`,
  compressionLevel = 6
  // 0..9
} = {}) {
  const zip = new JSZip();
  let count = 0;
  return {
    async write(frameIndex, blob) {
      const name = filename(frameIndex);
      const arr = await blob.arrayBuffer();
      zip.file(name, arr);
      count++;
    },
    async finalize() {
      const out = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: compressionLevel }
      });
      downloadBlob(zipName, out);
      return { files: count };
    }
  };
}

// src/exporters/best.js
async function createBestExporter({
  prefer = "fs",
  // "fs" | "zip"
  fs,
  zip
} = {}) {
  const canFS = typeof window !== "undefined" && window.isSecureContext === true && "showDirectoryPicker" in window;
  if (prefer === "fs" && canFS) {
    return await createFsExporter(fs);
  }
  if (prefer === "zip") {
    return await createZipExporter(zip);
  }
  return await createZipExporter(zip);
}
export {
  createBestExporter,
  createFsExporter,
  createZipExporter,
  startLiveCapture,
  virtualTimeCapture,
  virtualTimeCaptureFromStart
};
