// src/live.js
async function startLiveCapture({
  canvas,
  exporter,
  fps = 30,
  concurrency = 2,
  maxQueue = 8,
  maxPendingCaptures = null,
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
  if (maxPendingCaptures != null && (!Number.isInteger(maxPendingCaptures) || maxPendingCaptures < 1)) {
    throw new TypeError("maxPendingCaptures must be >= 1");
  }
  if (policy !== "drop" && policy !== "block")
    throw new TypeError('policy must be "drop" or "block"');
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module"
  });
  await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      var _a2, _b;
      if (((_a2 = ev.data) == null ? void 0 : _a2.type) === "ready") {
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
        resolve();
      } else if (((_b = ev.data) == null ? void 0 : _b.type) === "error") {
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
        reject(new Error(ev.data.message || "Worker error"));
      }
    };
    const onErr = (ev) => {
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
      reject(ev.error || new Error("Worker failed to initialize"));
    };
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onErr);
  });
  const stats = {
    captured: 0,
    encoded: 0,
    written: 0,
    dropped: 0,
    failed: 0,
    queueMax: 0,
    inFlightMax: 0,
    pendingCaptureMax: 0,
    lastBitmapMs: 0,
    bitmapMsAvg: 0,
    lastEncodeMs: 0,
    encodeMsAvg: 0,
    lastWriteMs: 0,
    writeMsAvg: 0
  };
  const maxCaptureTasks = maxPendingCaptures == null ? Math.max(1, Math.min(4, concurrency)) : maxPendingCaptures;
  const frameIntervalMs = 1e3 / fps;
  const maxCatchUpFrames = 4;
  const maxAccumMs = frameIntervalMs * maxCatchUpFrames;
  let stopped = false;
  let rafId = null;
  let fatalError = null;
  let inFlight = 0;
  let pendingCaptures = 0;
  let accMs = 0;
  let lastTickMs = null;
  let seq = 0;
  const queue = [];
  const waiters = [];
  const ack = /* @__PURE__ */ new Map();
  const captureTasks = /* @__PURE__ */ new Set();
  let doneSettled = false;
  let resolveDone = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  function isAbortError(err) {
    return (err == null ? void 0 : err.name) === "AbortError" || (err == null ? void 0 : err.message) === "stopped" || (err == null ? void 0 : err.message) === "Aborted";
  }
  function emitProgress() {
    onProgress == null ? void 0 : onProgress({ ...stats });
  }
  function throwIfAborted() {
    if (fatalError) throw fatalError;
    if (signal == null ? void 0 : signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  }
  function wakeAllWaiters() {
    while (waiters.length) {
      const w = waiters.shift();
      if (w) w();
    }
  }
  function releaseBitmap2(bitmap) {
    if (typeof (bitmap == null ? void 0 : bitmap.close) === "function") {
      try {
        bitmap.close();
      } catch {
      }
    }
  }
  function settleDone(value) {
    if (doneSettled) return;
    doneSettled = true;
    resolveDone == null ? void 0 : resolveDone(value);
  }
  function dispatchFrame(item) {
    inFlight++;
    stats.inFlightMax = Math.max(stats.inFlightMax, inFlight);
    const { seq: seq2, bitmap, w, h } = item;
    const p = new Promise((resolve, reject) => ack.set(seq2, { resolve, reject }));
    worker.postMessage(
      { type: "encode", frameIndex: seq2, bitmap, width: w, height: h },
      [bitmap]
    );
    p.catch(() => {
    });
  }
  function dispatchIfPossible() {
    while (!stopped && inFlight < concurrency && queue.length > 0) {
      const item = queue.shift();
      dispatchFrame(item);
      wakeAllWaiters();
    }
  }
  async function pushCapturedFrame(item) {
    if (stopped) {
      releaseBitmap2(item.bitmap);
      return false;
    }
    if (inFlight < concurrency) {
      dispatchFrame(item);
      return true;
    }
    if (policy === "drop") {
      if (queue.length >= maxQueue) {
        stats.dropped++;
        releaseBitmap2(item.bitmap);
        return false;
      }
      queue.push(item);
      stats.queueMax = Math.max(stats.queueMax, queue.length);
      return true;
    }
    if (maxQueue === 0) {
      while (!stopped && inFlight >= concurrency) {
        await new Promise((r) => waiters.push(r));
        throwIfAborted();
      }
      if (stopped) {
        releaseBitmap2(item.bitmap);
        return false;
      }
      dispatchFrame(item);
      return true;
    }
    while (!stopped && queue.length >= maxQueue) {
      await new Promise((r) => waiters.push(r));
      throwIfAborted();
    }
    if (stopped) {
      releaseBitmap2(item.bitmap);
      return false;
    }
    queue.push(item);
    stats.queueMax = Math.max(stats.queueMax, queue.length);
    return true;
  }
  function canScheduleCapture() {
    if (stopped) return false;
    if (pendingCaptures >= maxCaptureTasks) return false;
    if (policy === "drop") {
      const buffered = queue.length + inFlight + pendingCaptures;
      const capacity = maxQueue + concurrency;
      return buffered < capacity;
    }
    if (maxQueue === 0) return inFlight < concurrency;
    return queue.length < maxQueue || inFlight < concurrency;
  }
  function scheduleCaptureFrame() {
    pendingCaptures++;
    stats.pendingCaptureMax = Math.max(stats.pendingCaptureMax, pendingCaptures);
    let task = null;
    task = (async () => {
      throwIfAborted();
      const w = canvas.width;
      const h = canvas.height;
      const b0 = performance.now();
      const bitmap = await createImageBitmap(canvas);
      const b1 = performance.now();
      const bitmapMs = b1 - b0;
      stats.lastBitmapMs = bitmapMs;
      stats.bitmapMsAvg = stats.bitmapMsAvg ? stats.bitmapMsAvg * 0.9 + bitmapMs * 0.1 : bitmapMs;
      stats.captured++;
      await pushCapturedFrame({
        seq: seq++,
        bitmap,
        w,
        h
      });
    })().catch((err) => {
      if (!stopped && !isAbortError(err)) {
        stats.failed++;
        console.error("capture failed:", err);
      }
    }).finally(() => {
      pendingCaptures--;
      captureTasks.delete(task);
      dispatchIfPossible();
      wakeAllWaiters();
      emitProgress();
    });
    captureTasks.add(task);
  }
  worker.addEventListener("message", async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "frame") {
      const { frameIndex: frameSeq, blob, encodeMs } = msg;
      stats.encoded++;
      if (typeof encodeMs === "number") {
        stats.lastEncodeMs = encodeMs;
        stats.encodeMsAvg = stats.encodeMsAvg ? stats.encodeMsAvg * 0.9 + encodeMs * 0.1 : encodeMs;
      }
      try {
        const w0 = performance.now();
        await exporter.write(frameSeq, blob);
        const w1 = performance.now();
        stats.written++;
        const writeMs = w1 - w0;
        stats.lastWriteMs = writeMs;
        stats.writeMsAvg = stats.writeMsAvg ? stats.writeMsAvg * 0.9 + writeMs * 0.1 : writeMs;
        const entry = ack.get(frameSeq);
        if (entry) entry.resolve();
      } catch (err) {
        stats.failed++;
        const entry = ack.get(frameSeq);
        if (entry) entry.reject(err);
      } finally {
        ack.delete(frameSeq);
        inFlight = Math.max(0, inFlight - 1);
        dispatchIfPossible();
        wakeAllWaiters();
        emitProgress();
      }
      return;
    }
    if (msg.type === "error") {
      const frameSeq = Number(msg.frameIndex);
      const err = new Error(msg.message || "Worker error");
      stats.failed++;
      if (Number.isInteger(frameSeq)) {
        const entry = ack.get(frameSeq);
        if (entry) entry.reject(err);
        ack.delete(frameSeq);
        inFlight = Math.max(0, inFlight - 1);
        dispatchIfPossible();
        wakeAllWaiters();
      } else {
        fatalError = err;
      }
      console.error("Worker error:", err.message);
      emitProgress();
    }
  });
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
    if (accMs > maxAccumMs) {
      const dropFrames = Math.floor((accMs - maxAccumMs) / frameIntervalMs);
      if (dropFrames > 0) {
        stats.dropped += dropFrames;
        accMs -= dropFrames * frameIntervalMs;
      }
      if (accMs > maxAccumMs) accMs = maxAccumMs;
    }
    let loopGuard = 0;
    while (accMs >= frameIntervalMs && loopGuard < maxCatchUpFrames) {
      if (!canScheduleCapture()) {
        if (policy === "drop") {
          stats.dropped++;
          accMs -= frameIntervalMs;
          loopGuard++;
          continue;
        }
        break;
      }
      accMs -= frameIntervalMs;
      scheduleCaptureFrame();
      loopGuard++;
    }
    emitProgress();
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
  async function stop() {
    if (stopped) return done;
    stopped = true;
    if (rafId != null) cancelAnimationFrame(rafId);
    let stopError = null;
    try {
      wakeAllWaiters();
      const tasks = Array.from(captureTasks);
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
      for (const item of queue.splice(0, queue.length)) {
        releaseBitmap2(item.bitmap);
      }
      while (inFlight > 0 || ack.size > 0) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await exporter.finalize();
    } catch (err) {
      stopError = err;
      throw err;
    } finally {
      try {
        worker.terminate();
      } catch {
      }
      settleDone({ error: stopError ?? fatalError ?? null });
    }
    return done;
  }
  return { stop, stats, done };
}

// src/frame_pipeline.js
var realSetTimeout = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout.bind(globalThis) : null;
var realClearTimeout = typeof globalThis.clearTimeout === "function" ? globalThis.clearTimeout.bind(globalThis) : null;
var _a;
var realPerformanceNow = typeof ((_a = globalThis.performance) == null ? void 0 : _a.now) === "function" ? globalThis.performance.now.bind(globalThis.performance) : null;
function nowMs() {
  return realPerformanceNow ? realPerformanceNow() : Date.now();
}
function toInt(v, fallback, min = 1, max = Infinity) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) return fallback;
  return Math.min(n, max);
}
function defaultEncodeWorkers() {
  var _a2;
  const hc = Number(((_a2 = globalThis.navigator) == null ? void 0 : _a2.hardwareConcurrency) || 4);
  if (!Number.isFinite(hc) || hc <= 2) return 1;
  return Math.max(1, Math.min(3, Math.floor(hc - 1)));
}
function updateAvg(stats, lastKey, avgKey, value) {
  stats[lastKey] = value;
  stats[avgKey] = stats[avgKey] ? stats[avgKey] * 0.9 + value * 0.1 : value;
}
function releaseBitmap(bitmap) {
  if (typeof (bitmap == null ? void 0 : bitmap.close) === "function") {
    try {
      bitmap.close();
    } catch {
    }
  }
}
function asCallable(fn, self) {
  if (typeof fn !== "function") return null;
  return (...args) => fn.call(self ?? globalThis, ...args);
}
function getPaApi() {
  return globalThis.paEncoder || globalThis.__pa_encoder || {};
}
function findFrameWaitHook(canvas) {
  const api = getPaApi();
  const candidates = [
    [canvas == null ? void 0 : canvas.__pa_encoder_waitForFrame, canvas],
    [canvas == null ? void 0 : canvas.__pa_encoder_waitForRender, canvas],
    [globalThis.__pa_encoder_waitForFrame, globalThis],
    [globalThis.__pa_encoder_waitForRender, globalThis],
    [api.waitForFrame, api],
    [api.waitForRender, api]
  ];
  for (const [fn, self] of candidates) {
    const callable = asCallable(fn, self);
    if (callable) return callable;
  }
  return null;
}
async function resolveCandidate(value) {
  if (typeof value === "function") return await value();
  return await value;
}
async function findGpuQueue(canvas) {
  var _a2;
  const api = getPaApi();
  const queueCandidates = [
    canvas == null ? void 0 : canvas.__pa_encoder_gpuQueue,
    globalThis.__pa_encoder_gpuQueue,
    api.gpuQueue,
    api.queue
  ];
  for (const candidate of queueCandidates) {
    const queue = await resolveCandidate(candidate);
    if (typeof (queue == null ? void 0 : queue.onSubmittedWorkDone) === "function") return queue;
  }
  const deviceCandidates = [
    canvas == null ? void 0 : canvas.__pa_encoder_gpuDevice,
    globalThis.__pa_encoder_gpuDevice,
    globalThis.__pa_encoder_webgpuDevice,
    api.gpuDevice,
    api.webgpuDevice,
    api.device
  ];
  for (const candidate of deviceCandidates) {
    const device = await resolveCandidate(candidate);
    if (typeof ((_a2 = device == null ? void 0 : device.queue) == null ? void 0 : _a2.onSubmittedWorkDone) === "function") {
      return device.queue;
    }
  }
  return null;
}
function withRealTimeout(promise, timeoutMs, message) {
  const ms = Number(timeoutMs);
  if (!realSetTimeout || !Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null && realClearTimeout) realClearTimeout(timer);
  });
}
async function waitForFrameReady({
  canvas,
  frameIndex = 0,
  mode = "auto",
  timeoutMs = 5e3
} = {}) {
  const waitMode = mode || "auto";
  const t0 = nowMs();
  if (waitMode === "none") {
    return { kind: "none", waitMs: nowMs() - t0 };
  }
  const context = { canvas, frameIndex };
  const hook = findFrameWaitHook(canvas);
  if (hook) {
    await withRealTimeout(
      Promise.resolve(hook(context)),
      timeoutMs,
      `Frame ${frameIndex} render wait hook timed out`
    );
    return { kind: "hook", waitMs: nowMs() - t0 };
  }
  if (waitMode === "hook") {
    throw new Error("Frame render wait hook was requested but not found.");
  }
  const queue = await findGpuQueue(canvas);
  if (queue && (waitMode === "auto" || waitMode === "gpu")) {
    await withRealTimeout(
      queue.onSubmittedWorkDone(),
      timeoutMs,
      `Frame ${frameIndex} GPU queue wait timed out`
    );
    return { kind: "gpu", waitMs: nowMs() - t0 };
  }
  if (waitMode === "gpu") {
    throw new Error("GPU queue wait was requested but no WebGPU queue was found.");
  }
  await Promise.resolve();
  return { kind: "none", waitMs: nowMs() - t0 };
}
async function createWorkerSlot(onMessage, onError) {
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module"
  });
  await new Promise((resolve, reject) => {
    const handleMessage = (ev) => {
      var _a2, _b;
      if (((_a2 = ev.data) == null ? void 0 : _a2.type) === "ready") {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
        resolve();
      } else if (((_b = ev.data) == null ? void 0 : _b.type) === "error") {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
        reject(new Error(ev.data.message || "Worker error"));
      }
    };
    const handleError = (ev) => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      reject(ev.error || new Error("Worker failed to initialize"));
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
  });
  const slot = {
    worker,
    busy: false,
    current: null
  };
  worker.addEventListener("message", (ev) => onMessage(slot, ev.data));
  worker.addEventListener(
    "error",
    (ev) => onError(slot, ev.error || new Error("Worker failed"))
  );
  return slot;
}
async function createFramePngPipeline({
  exporter,
  encodeWorkers = defaultEncodeWorkers(),
  maxEncodeQueue = 8,
  maxPendingBitmaps = 4,
  writeConcurrency = 1,
  onProgress,
  signal
} = {}) {
  if (!exporter || typeof exporter.write !== "function" || typeof exporter.finalize !== "function") {
    throw new TypeError("exporter must have write() and finalize()");
  }
  const workerCount = toInt(encodeWorkers, defaultEncodeWorkers(), 1, 8);
  const queueLimit = toInt(maxEncodeQueue, 8, 0, 64);
  const bitmapLimit = toInt(maxPendingBitmaps, 4, 1, 64);
  const writerLimit = toInt(writeConcurrency, 1, 1, 8);
  const stats = {
    mode: "frame",
    captured: 0,
    encoded: 0,
    written: 0,
    failed: 0,
    dropped: 0,
    encodeWorkers: workerCount,
    writeConcurrency: writerLimit,
    heldBitmaps: 0,
    encodeQueue: 0,
    writeQueue: 0,
    activeEncode: 0,
    activeWrite: 0,
    queueMax: 0,
    inFlightMax: 0,
    pendingCaptureMax: 0,
    pendingBitmapMax: 0,
    writeQueueMax: 0,
    activeWriteMax: 0,
    lastRenderWaitMs: 0,
    renderWaitMsAvg: 0,
    renderWaitKind: "none",
    lastSnapshotMs: 0,
    snapshotMsAvg: 0,
    lastBitmapMs: 0,
    bitmapMsAvg: 0,
    lastEncodeMs: 0,
    encodeMsAvg: 0,
    lastWriteMs: 0,
    writeMsAvg: 0,
    finalizeMs: 0
  };
  const encodeQueue = [];
  const writeQueue = [];
  const waiters = [];
  let workers = [];
  let heldBitmaps = 0;
  let activeEncode = 0;
  let activeWrite = 0;
  let fatalError = null;
  let closed = false;
  function refreshStats() {
    stats.heldBitmaps = heldBitmaps;
    stats.encodeQueue = encodeQueue.length;
    stats.writeQueue = writeQueue.length;
    stats.activeEncode = activeEncode;
    stats.activeWrite = activeWrite;
    stats.queueMax = Math.max(stats.queueMax, encodeQueue.length);
    stats.inFlightMax = Math.max(stats.inFlightMax, activeEncode);
    stats.pendingCaptureMax = Math.max(stats.pendingCaptureMax, heldBitmaps);
    stats.pendingBitmapMax = Math.max(stats.pendingBitmapMax, heldBitmaps);
    stats.writeQueueMax = Math.max(stats.writeQueueMax, writeQueue.length);
    stats.activeWriteMax = Math.max(stats.activeWriteMax, activeWrite);
  }
  function emitProgress() {
    refreshStats();
    onProgress == null ? void 0 : onProgress({ ...stats });
  }
  function notify() {
    emitProgress();
    while (waiters.length) {
      const waiter = waiters.shift();
      if (waiter) waiter();
    }
  }
  function waitForChange() {
    return new Promise((resolve) => waiters.push(resolve));
  }
  function makeError(err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  function setFatalError(err) {
    if (!fatalError) {
      fatalError = makeError(err);
      stats.failed++;
    }
    for (const item of encodeQueue.splice(0, encodeQueue.length)) {
      releaseBitmap(item.bitmap);
      heldBitmaps = Math.max(0, heldBitmaps - 1);
    }
    writeQueue.splice(0, writeQueue.length);
    notify();
  }
  function throwIfUnavailable() {
    if (fatalError) throw fatalError;
    if (closed) throw new Error("Frame PNG pipeline is closed.");
    if (signal == null ? void 0 : signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  }
  function hasIdleWorker() {
    return workers.some((w) => !w.busy);
  }
  function hasCaptureCapacity() {
    if (heldBitmaps >= bitmapLimit) return false;
    if (encodeQueue.length < queueLimit) return true;
    return hasIdleWorker();
  }
  async function waitForCaptureCapacity() {
    while (!hasCaptureCapacity()) {
      throwIfUnavailable();
      await waitForChange();
    }
    throwIfUnavailable();
  }
  function dispatchWrite() {
    while (!closed && !fatalError && activeWrite < writerLimit && writeQueue.length) {
      const item = writeQueue.shift();
      activeWrite++;
      stats.activeWriteMax = Math.max(stats.activeWriteMax, activeWrite);
      (async () => {
        const t0 = nowMs();
        try {
          await exporter.write(item.frameIndex, item.blob);
          const t1 = nowMs();
          stats.written++;
          updateAvg(stats, "lastWriteMs", "writeMsAvg", t1 - t0);
        } catch (err) {
          setFatalError(err);
        } finally {
          activeWrite = Math.max(0, activeWrite - 1);
          dispatchWrite();
          notify();
        }
      })();
    }
  }
  function enqueueWrite(frameIndex, blob) {
    writeQueue.push({ frameIndex, blob });
    stats.writeQueueMax = Math.max(stats.writeQueueMax, writeQueue.length);
    dispatchWrite();
  }
  function finishEncode(slot, msg) {
    const current = slot.current;
    slot.busy = false;
    slot.current = null;
    activeEncode = Math.max(0, activeEncode - 1);
    heldBitmaps = Math.max(0, heldBitmaps - 1);
    if ((msg == null ? void 0 : msg.type) === "frame") {
      const encodeMs = Number(msg.encodeMs);
      stats.encoded++;
      if (Number.isFinite(encodeMs)) {
        updateAvg(stats, "lastEncodeMs", "encodeMsAvg", encodeMs);
      }
      enqueueWrite(msg.frameIndex ?? (current == null ? void 0 : current.frameIndex), msg.blob);
    } else {
      setFatalError(new Error((msg == null ? void 0 : msg.message) || "Worker failed to encode frame"));
    }
    dispatchEncode();
    notify();
  }
  function failEncode(slot, err) {
    var _a2;
    if ((_a2 = slot.current) == null ? void 0 : _a2.bitmap) releaseBitmap(slot.current.bitmap);
    if (slot.current) heldBitmaps = Math.max(0, heldBitmaps - 1);
    slot.busy = false;
    slot.current = null;
    activeEncode = Math.max(0, activeEncode - 1);
    setFatalError(err);
  }
  function dispatchEncode() {
    while (!closed && !fatalError && encodeQueue.length) {
      const slot = workers.find((w) => !w.busy);
      if (!slot) return;
      const item = encodeQueue.shift();
      slot.busy = true;
      slot.current = item;
      activeEncode++;
      stats.inFlightMax = Math.max(stats.inFlightMax, activeEncode);
      try {
        slot.worker.postMessage(
          {
            type: "encode",
            frameIndex: item.frameIndex,
            bitmap: item.bitmap,
            width: item.width,
            height: item.height
          },
          [item.bitmap]
        );
      } catch (err) {
        failEncode(slot, err);
      }
    }
  }
  workers = await Promise.all(
    Array.from(
      { length: workerCount },
      () => createWorkerSlot(
        (slot, msg) => {
          if (!msg || msg.type !== "frame" && msg.type !== "error") return;
          finishEncode(slot, msg);
        },
        (slot, err) => failEncode(slot, err)
      )
    )
  );
  async function capture(canvas, frameIndex) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new TypeError("canvas must be an HTMLCanvasElement");
    }
    await waitForCaptureCapacity();
    const width = canvas.width;
    const height = canvas.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`Canvas has invalid size: ${width}x${height}`);
    }
    let bitmap = null;
    const t0 = nowMs();
    try {
      bitmap = await createImageBitmap(canvas);
    } catch (err) {
      stats.failed++;
      throw err;
    }
    const t1 = nowMs();
    try {
      throwIfUnavailable();
    } catch (err) {
      releaseBitmap(bitmap);
      throw err;
    }
    heldBitmaps++;
    stats.captured++;
    updateAvg(stats, "lastSnapshotMs", "snapshotMsAvg", t1 - t0);
    stats.lastBitmapMs = stats.lastSnapshotMs;
    stats.bitmapMsAvg = stats.snapshotMsAvg;
    encodeQueue.push({ frameIndex, bitmap, width, height });
    dispatchEncode();
    notify();
  }
  async function drain() {
    while (encodeQueue.length || writeQueue.length || heldBitmaps > 0 || activeEncode > 0 || activeWrite > 0) {
      if (fatalError) throw fatalError;
      dispatchEncode();
      dispatchWrite();
      await waitForChange();
    }
    if (fatalError) throw fatalError;
    closed = true;
    for (const slot of workers) {
      try {
        slot.worker.terminate();
      } catch {
      }
    }
    workers = [];
    notify();
    return { ...stats };
  }
  async function cancel() {
    closed = true;
    for (const item of encodeQueue.splice(0, encodeQueue.length)) {
      releaseBitmap(item.bitmap);
    }
    heldBitmaps = 0;
    writeQueue.splice(0, writeQueue.length);
    for (const slot of workers) {
      try {
        slot.worker.terminate();
      } catch {
      }
    }
    workers = [];
    notify();
  }
  function recordRenderWait(result = {}) {
    const waitMs = Number(result.waitMs || 0);
    stats.renderWaitKind = result.kind || "none";
    updateAvg(stats, "lastRenderWaitMs", "renderWaitMsAvg", waitMs);
    notify();
  }
  function recordFinalize(ms) {
    const finalizeMs = Number(ms);
    if (Number.isFinite(finalizeMs)) stats.finalizeMs = finalizeMs;
    notify();
  }
  return {
    stats,
    capture,
    drain,
    cancel,
    recordRenderWait,
    recordFinalize
  };
}

// src/virtual_time.js
function installVirtualTime({
  fps = 60,
  hookDateNow = true,
  hookPerformanceNow = true,
  hookTimers = true,
  maxTimerCallbacksPerStep = 1e4
} = {}) {
  var _a2, _b, _c, _d, _e, _f;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new TypeError("installVirtualTime: fps must be a positive number");
  }
  const dtMs = 1e3 / fps;
  const orig = {
    requestAnimationFrame: (_a2 = window.requestAnimationFrame) == null ? void 0 : _a2.bind(window),
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
  onCanvasReady = null,
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
    if (typeof onCanvasReady === "function") {
      await onCanvasReady(canvas, vt);
    }
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
  createFramePngPipeline,
  createFsExporter,
  createZipExporter,
  startLiveCapture,
  virtualTimeCapture,
  virtualTimeCaptureFromStart,
  waitForFrameReady
};
