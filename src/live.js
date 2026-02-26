// src/live.js
export async function startLiveCapture({
  canvas,
  exporter,
  fps = 30,
  concurrency = 2,
  maxQueue = 8,
  maxPendingCaptures = null,
  policy = "drop", // "drop" | "block"
  onProgress,
  signal,
} = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError("canvas must be an HTMLCanvasElement");
  }
  if (
    !exporter ||
    typeof exporter.write !== "function" ||
    typeof exporter.finalize !== "function"
  ) {
    throw new TypeError("exporter must have write() and finalize()");
  }
  if (!Number.isFinite(fps) || fps <= 0)
    throw new TypeError("fps must be positive");
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new TypeError("concurrency must be >= 1");
  if (!Number.isInteger(maxQueue) || maxQueue < 0)
    throw new TypeError("maxQueue must be >= 0");
  if (
    maxPendingCaptures != null &&
    (!Number.isInteger(maxPendingCaptures) || maxPendingCaptures < 1)
  ) {
    throw new TypeError("maxPendingCaptures must be >= 1");
  }
  if (policy !== "drop" && policy !== "block")
    throw new TypeError('policy must be "drop" or "block"');

  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });

  await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      if (ev.data?.type === "ready") {
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
        resolve();
      } else if (ev.data?.type === "error") {
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
    writeMsAvg: 0,
  };

  const maxCaptureTasks =
    maxPendingCaptures == null
      ? Math.max(1, Math.min(4, concurrency))
      : maxPendingCaptures;

  const frameIntervalMs = 1000 / fps;
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

  const queue = []; // { seq, bitmap, w, h }
  const waiters = [];
  const ack = new Map();
  const captureTasks = new Set();
  let doneSettled = false;
  let resolveDone = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function isAbortError(err) {
    return (
      err?.name === "AbortError" ||
      err?.message === "stopped" ||
      err?.message === "Aborted"
    );
  }

  function emitProgress() {
    onProgress?.({ ...stats });
  }

  function throwIfAborted() {
    if (fatalError) throw fatalError;
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  }

  function wakeAllWaiters() {
    while (waiters.length) {
      const w = waiters.shift();
      if (w) w();
    }
  }

  function releaseBitmap(bitmap) {
    if (typeof bitmap?.close === "function") {
      try {
        bitmap.close();
      } catch {}
    }
  }

  function settleDone(value) {
    if (doneSettled) return;
    doneSettled = true;
    resolveDone?.(value);
  }

  function dispatchFrame(item) {
    inFlight++;
    stats.inFlightMax = Math.max(stats.inFlightMax, inFlight);

    const { seq, bitmap, w, h } = item;
    const p = new Promise((resolve, reject) => ack.set(seq, { resolve, reject }));
    worker.postMessage(
      { type: "encode", frameIndex: seq, bitmap, width: w, height: h },
      [bitmap]
    );
    p.catch(() => {});
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
      releaseBitmap(item.bitmap);
      return false;
    }

    if (inFlight < concurrency) {
      dispatchFrame(item);
      return true;
    }

    if (policy === "drop") {
      if (queue.length >= maxQueue) {
        stats.dropped++;
        releaseBitmap(item.bitmap);
        return false;
      }
      queue.push(item);
      stats.queueMax = Math.max(stats.queueMax, queue.length);
      return true;
    }

    // policy === "block"
    if (maxQueue === 0) {
      while (!stopped && inFlight >= concurrency) {
        await new Promise((r) => waiters.push(r));
        throwIfAborted();
      }
      if (stopped) {
        releaseBitmap(item.bitmap);
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
      releaseBitmap(item.bitmap);
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
      stats.bitmapMsAvg = stats.bitmapMsAvg
        ? stats.bitmapMsAvg * 0.9 + bitmapMs * 0.1
        : bitmapMs;

      stats.captured++;

      await pushCapturedFrame({
        seq: seq++,
        bitmap,
        w,
        h,
      });
    })()
      .catch((err) => {
        if (!stopped && !isAbortError(err)) {
          stats.failed++;
          console.error("capture failed:", err);
        }
      })
      .finally(() => {
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
        stats.encodeMsAvg = stats.encodeMsAvg
          ? stats.encodeMsAvg * 0.9 + encodeMs * 0.1
          : encodeMs;
      }

      try {
        const w0 = performance.now();
        await exporter.write(frameSeq, blob);
        const w1 = performance.now();

        stats.written++;
        const writeMs = w1 - w0;
        stats.lastWriteMs = writeMs;
        stats.writeMsAvg = stats.writeMsAvg
          ? stats.writeMsAvg * 0.9 + writeMs * 0.1
          : writeMs;

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
      stop().catch(() => {});
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
        releaseBitmap(item.bitmap);
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
      } catch {}
      settleDone({ error: stopError ?? fatalError ?? null });
    }
    return done;
  }

  return { stop, stats, done };
}
