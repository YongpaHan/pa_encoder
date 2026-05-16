// src/frame_pipeline.js

const realSetTimeout =
  typeof globalThis.setTimeout === "function"
    ? globalThis.setTimeout.bind(globalThis)
    : null;
const realClearTimeout =
  typeof globalThis.clearTimeout === "function"
    ? globalThis.clearTimeout.bind(globalThis)
    : null;
const realPerformanceNow =
  typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now.bind(globalThis.performance)
    : null;

function nowMs() {
  return realPerformanceNow ? realPerformanceNow() : Date.now();
}

function toInt(v, fallback, min = 1, max = Infinity) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) return fallback;
  return Math.min(n, max);
}

function defaultEncodeWorkers() {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 4);
  if (!Number.isFinite(hc) || hc <= 2) return 1;
  return Math.max(1, Math.min(3, Math.floor(hc - 1)));
}

function updateAvg(stats, lastKey, avgKey, value) {
  stats[lastKey] = value;
  stats[avgKey] = stats[avgKey] ? stats[avgKey] * 0.9 + value * 0.1 : value;
}

function releaseBitmap(bitmap) {
  if (typeof bitmap?.close === "function") {
    try {
      bitmap.close();
    } catch {}
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
    [canvas?.__pa_encoder_waitForFrame, canvas],
    [canvas?.__pa_encoder_waitForRender, canvas],
    [globalThis.__pa_encoder_waitForFrame, globalThis],
    [globalThis.__pa_encoder_waitForRender, globalThis],
    [api.waitForFrame, api],
    [api.waitForRender, api],
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
  const api = getPaApi();
  const queueCandidates = [
    canvas?.__pa_encoder_gpuQueue,
    globalThis.__pa_encoder_gpuQueue,
    api.gpuQueue,
    api.queue,
  ];

  for (const candidate of queueCandidates) {
    const queue = await resolveCandidate(candidate);
    if (typeof queue?.onSubmittedWorkDone === "function") return queue;
  }

  const deviceCandidates = [
    canvas?.__pa_encoder_gpuDevice,
    globalThis.__pa_encoder_gpuDevice,
    globalThis.__pa_encoder_webgpuDevice,
    api.gpuDevice,
    api.webgpuDevice,
    api.device,
  ];

  for (const candidate of deviceCandidates) {
    const device = await resolveCandidate(candidate);
    if (typeof device?.queue?.onSubmittedWorkDone === "function") {
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

export async function waitForFrameReady({
  canvas,
  frameIndex = 0,
  mode = "auto",
  timeoutMs = 5000,
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
    type: "module",
  });

  await new Promise((resolve, reject) => {
    const handleMessage = (ev) => {
      if (ev.data?.type === "ready") {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
        resolve();
      } else if (ev.data?.type === "error") {
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
    current: null,
  };

  worker.addEventListener("message", (ev) => onMessage(slot, ev.data));
  worker.addEventListener("error", (ev) =>
    onError(slot, ev.error || new Error("Worker failed"))
  );

  return slot;
}

export async function createFramePngPipeline({
  exporter,
  encodeWorkers = defaultEncodeWorkers(),
  maxEncodeQueue = 8,
  maxPendingBitmaps = 4,
  writeConcurrency = 1,
  onProgress,
  signal,
} = {}) {
  if (
    !exporter ||
    typeof exporter.write !== "function" ||
    typeof exporter.finalize !== "function"
  ) {
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

    finalizeMs: 0,
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
    onProgress?.({ ...stats });
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
    if (signal?.aborted) {
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

    if (msg?.type === "frame") {
      const encodeMs = Number(msg.encodeMs);
      stats.encoded++;
      if (Number.isFinite(encodeMs)) {
        updateAvg(stats, "lastEncodeMs", "encodeMsAvg", encodeMs);
      }
      enqueueWrite(msg.frameIndex ?? current?.frameIndex, msg.blob);
    } else {
      setFatalError(new Error(msg?.message || "Worker failed to encode frame"));
    }

    dispatchEncode();
    notify();
  }

  function failEncode(slot, err) {
    if (slot.current?.bitmap) releaseBitmap(slot.current.bitmap);
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
            height: item.height,
          },
          [item.bitmap]
        );
      } catch (err) {
        failEncode(slot, err);
      }
    }
  }

  workers = await Promise.all(
    Array.from({ length: workerCount }, () =>
      createWorkerSlot(
        (slot, msg) => {
          if (!msg || (msg.type !== "frame" && msg.type !== "error")) return;
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
    while (
      encodeQueue.length ||
      writeQueue.length ||
      heldBitmaps > 0 ||
      activeEncode > 0 ||
      activeWrite > 0
    ) {
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
      } catch {}
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
      } catch {}
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
    recordFinalize,
  };
}
