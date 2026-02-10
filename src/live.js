// src/live.js
export async function startLiveCapture({
  canvas,
  exporter,
  fps = 30,
  concurrency = 2,
  maxQueue = 8,
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
  if (policy !== "drop" && policy !== "block")
    throw new TypeError('policy must be "drop" or "block"');

  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });

  // --- worker ready
  await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      if (ev.data?.type === "ready") {
        worker.removeEventListener("message", onMsg);
        resolve();
      } else if (ev.data?.type === "error") {
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
    writeMsAvg: 0,
  };

  let stopped = false;
  let rafId = null;

  // backpressure state
  let inFlight = 0;
  const queue = []; // { seq, bitmap, w, h }
  const waiters = []; // for "block"

  // ack map: seq -> {resolve, reject}
  const ack = new Map();

  function throwIfAborted() {
    if (signal?.aborted) {
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
        onProgress?.({ ...stats });
        return false;
      }
      queue.push(item);
      stats.queueMax = Math.max(stats.queueMax, queue.length);
      return true;
    }

    // policy === "block"
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

      const { seq, bitmap, w, h } = item;

      const p = new Promise((resolve, reject) =>
        ack.set(seq, { resolve, reject })
      );

      worker.postMessage(
        { type: "encode", frameIndex: seq, bitmap, width: w, height: h },
        [bitmap]
      );

      // ensure rejection doesn't become unhandled
      p.catch(() => {});
    }
  }

  worker.addEventListener("message", async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "frame") {
      const { frameIndex: seq, blob, encodeMs } = msg;

      // encode stats
      stats.encoded++;
      if (typeof encodeMs === "number") {
        stats.lastEncodeMs = encodeMs;
        stats.encodeMsAvg = stats.encodeMsAvg
          ? stats.encodeMsAvg * 0.9 + encodeMs * 0.1
          : encodeMs;
      }

      try {
        const w0 = performance.now();
        await exporter.write(seq, blob);
        const w1 = performance.now();

        stats.written++;
        const writeMs = w1 - w0;
        stats.lastWriteMs = writeMs;
        stats.writeMsAvg = stats.writeMsAvg
          ? stats.writeMsAvg * 0.9 + writeMs * 0.1
          : writeMs;

        const entry = ack.get(seq);
        if (entry) entry.resolve();
      } catch (err) {
        const entry = ack.get(seq);
        if (entry) entry.reject(err);
      } finally {
        ack.delete(seq);
        inFlight--;
        dispatchIfPossible();
        onProgress?.({ ...stats });
      }
    } else if (msg.type === "error") {
      console.error("Worker error:", msg.message);
    }
  });

  // sampling clock
  const frameIntervalMs = 1000 / fps;
  let accMs = 0;
  let lastTickMs = null;
  let seq = 0;

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

    while (accMs >= frameIntervalMs) {
      accMs -= frameIntervalMs;

      const b0 = performance.now();
      createImageBitmap(canvas)
        .then(async (bitmap) => {
          const b1 = performance.now();
          const bitmapMs = b1 - b0;
          stats.lastBitmapMs = bitmapMs;
          stats.bitmapMsAvg = stats.bitmapMsAvg
            ? stats.bitmapMsAvg * 0.9 + bitmapMs * 0.1
            : bitmapMs;

          if (stopped) {
            if (typeof bitmap.close === "function") bitmap.close();
            return;
          }

          stats.captured++;

          const ok = await enqueueFrame({
            seq: seq++,
            bitmap,
            w: canvas.width,
            h: canvas.height,
          });

          if (ok) dispatchIfPossible();
          onProgress?.({ ...stats });
        })
        .catch((e) => console.error("createImageBitmap failed:", e));
    }

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (rafId != null) cancelAnimationFrame(rafId);

    // unblock waiters
    while (waiters.length) wakeOneWaiter();

    // release queued bitmaps
    for (const item of queue.splice(0, queue.length)) {
      if (typeof item.bitmap.close === "function") item.bitmap.close();
    }

    // wait for inFlight completion
    while (inFlight > 0 || ack.size > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }

    await exporter.finalize();
    worker.terminate();
  }

  return { stop, stats };
}
