import {
  virtualTimeCaptureFromStart,
  startLiveCapture,
  createFramePngPipeline,
  waitForFrameReady,
  createBestExporter,
  createZipExporter,
  createFsExporter,
} from "/__pa_encoder__/lib/index.js";

function getQueryParam(name) {
  return new URL(location.href).searchParams.get(name);
}

function post(type, data = {}) {
  try {
    parent.postMessage({ type, ...data }, "*");
  } catch {}
}

function toPositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function createThrottledPoster(type, intervalMs = 160) {
  let latest = null;
  const timer = setInterval(() => {
    if (!latest) return;
    post(type, latest);
    latest = null;
  }, Math.max(50, intervalMs));

  return {
    push(data) {
      latest = data;
    },
    flush() {
      if (!latest) return;
      post(type, latest);
      latest = null;
    },
    stop() {
      clearInterval(timer);
      latest = null;
    },
  };
}

function throttle(fn, waitMs = 120) {
  let timeoutId = null;
  return (...args) => {
    if (timeoutId) return;
    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, waitMs);
  };
}

async function importEntry(entry) {
  await import(entry);
}

function listCanvases() {
  return Array.from(document.querySelectorAll("canvas")).filter(
    (c) => c instanceof HTMLCanvasElement
  );
}

function buildCanvasList() {
  const cs = listCanvases();
  return cs.map((c, i) => {
    const selector = `canvas:nth-of-type(${i + 1})`;
    return {
      index: i,
      selector,
      id: c.id || "",
      className: String(c.className || ""),
      width: c.width,
      height: c.height,
      clientWidth: c.clientWidth,
      clientHeight: c.clientHeight,
      label: c.id ? `#${c.id}` : selector,
    };
  });
}

function sendCanvasList() {
  const canvases = buildCanvasList();
  post("pa_preview_canvas_list", { count: canvases.length, canvases });
}

function findCanvasDeep({
  selector = "canvas",
  includeShadow = true,
  maxIframeDepth = 8,
  doc = document,
  _depth = 0,
} = {}) {
  if (!doc || _depth > maxIframeDepth) return null;

  try {
    const el = doc.querySelector(selector);
    if (el instanceof HTMLCanvasElement) return el;
  } catch {}

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
        if (el instanceof HTMLCanvasElement) return el;
      } catch {}
      try {
        const fallback = sr.querySelector("canvas");
        if (fallback instanceof HTMLCanvasElement) return fallback;
      } catch {}
    }
  }

  let iframes = [];
  try {
    iframes = doc.querySelectorAll("iframe");
  } catch {
    iframes = [];
  }
  for (const iframe of iframes) {
    let childDoc = null;
    try {
      childDoc = iframe.contentDocument;
    } catch {
      childDoc = null;
    }
    if (!childDoc) continue;
    const found = findCanvasDeep({
      selector,
      includeShadow,
      maxIframeDepth,
      doc: childDoc,
      _depth: _depth + 1,
    });
    if (found) return found;
  }

  return null;
}

function resolveCanvas(selector = "canvas") {
  try {
    const direct = document.querySelector(selector);
    if (direct instanceof HTMLCanvasElement) return direct;
  } catch {}
  return findCanvasDeep({ selector }) || findCanvasDeep({ selector: "canvas" });
}

function ensureCanvasFocusable(canvas) {
  try {
    if (canvas && canvas.tabIndex < 0) canvas.tabIndex = 0;
  } catch {}
  try {
    canvas.style.outline = "none";
  } catch {}
}

function focusCanvasBestEffort(canvas) {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  ensureCanvasFocusable(canvas);
  try {
    canvas.focus({ preventScroll: true });
  } catch {
    try {
      canvas.focus();
    } catch {}
  }
}

function installDevicePixelRatioOverride(dpr) {
  const n = Number(dpr);
  if (!Number.isFinite(n) || n <= 0) return () => {};

  const hadOwn = Object.prototype.hasOwnProperty.call(window, "devicePixelRatio");
  const ownDesc = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");

  try {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      get: () => n,
    });
    return () => {
      try {
        if (hadOwn && ownDesc) {
          Object.defineProperty(window, "devicePixelRatio", ownDesc);
        } else {
          delete window.devicePixelRatio;
        }
      } catch {}
    };
  } catch (e) {
    console.warn("[pa_encoder] failed to override devicePixelRatio:", e);
    return () => {};
  }
}

function applyOutputSize(canvas, p = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) return false;

  const width = Math.floor(Number(p.outputWidth || 0));
  const height = Math.floor(Number(p.outputHeight || 0));
  if (width <= 0 || height <= 0) return false;

  const dpr = Number(p.outputDpr || 1);
  const cssScale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  canvas.width = width;
  canvas.height = height;
  try {
    canvas.style.width = `${Math.max(1, Math.round(width / cssScale))}px`;
    canvas.style.height = `${Math.max(1, Math.round(height / cssScale))}px`;
  } catch {}
  return true;
}

async function createExporterFromPayload(p = {}) {
  const mode = p.exporter?.mode || "best";
  const prefer = p.exporter?.prefer || "fs";
  const zipName = p.exporter?.zipName || "frames.zip";

  if (mode === "parent-fs") {
    return createParentFsExporter({ sessionId: p.exporter?.sessionId });
  }
  if (mode === "zip") return await createZipExporter({ zipName });
  if (mode === "fs") return await createFsExporter();
  return await createBestExporter({ prefer, zip: { zipName } });
}

let parentExportRequestSeq = 1;

function createParentFsExporter({ sessionId } = {}) {
  if (!sessionId) {
    throw new Error("Parent FS exporter requires a session id.");
  }

  const pending = new Map();
  const onMessage = (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== "pa_export_ack") return;

    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);

    if (msg.ok) entry.resolve();
    else entry.reject(new Error(msg.message || "Parent export failed"));
  };

  window.addEventListener("message", onMessage);

  function request(type, data = {}) {
    const requestId = `export-${parentExportRequestSeq++}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        parent.postMessage(
          {
            type,
            requestId,
            sessionId,
            ...data,
          },
          "*"
        );
      } catch (e) {
        pending.delete(requestId);
        reject(e);
      }
    });
  }

  function cleanup() {
    window.removeEventListener("message", onMessage);
    for (const entry of pending.values()) {
      entry.reject(new Error("Parent FS exporter was closed."));
    }
    pending.clear();
  }

  return {
    async write(frameIndex, blob) {
      await request("pa_export_write", { frameIndex, blob });
    },
    async finalize() {
      try {
        await request("pa_export_finalize");
      } finally {
        cleanup();
      }
    },
  };
}

let running = false;
let stopFlag = false;

window.addEventListener("message", async (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "pa_stop") {
    stopFlag = true;
    return;
  }

  if (msg.type === "pa_focus_canvas") {
    const sel = msg.payload?.canvasSelector || "canvas";
    const c = resolveCanvas(sel);
    if (c instanceof HTMLCanvasElement) focusCanvasBestEffort(c);
    return;
  }

  if (msg.type !== "pa_start_frame_capture") return;
  if (running) return;

  // live는 message로 시작 가능
  const p = msg.payload || {};
  if ((p.kind || "live") === "frame") {
    post("pa_error", {
      message: "Frame mode requires iframe reload autostart.",
    });
    return;
  }

  await runLive(p);
});

async function runFrameAutostart(payload, entry) {
  if (running) return;
  running = true;
  stopFlag = false;

  const p = payload || {};
  const canvasSelector = p.canvasSelector || "canvas";

  post("pa_status", { status: "running", message: "capture starting..." });

  let exporter = null;
  let didFinalize = false;
  let didDrainPipeline = false;
  let firstCanvasFocused = false;
  let restoreDpr = () => {};
  let pipeline = null;
  const progressPoster = createThrottledPoster(
    "pa_progress",
    toPositiveInt(p?.statsIntervalMs, 120)
  );
  const statsPoster = createThrottledPoster(
    "pa_stats",
    toPositiveInt(p?.statsIntervalMs, 120)
  );

  try {
    exporter = await createExporterFromPayload(p);

    const fps = Number(p.fps ?? 60);
    const frames = Number(p.frames ?? 300);
    const warmup = Number(p.warmup ?? 0);
    const totalSteps = warmup + frames;

    pipeline = await createFramePngPipeline({
      exporter,
      encodeWorkers: Number(p.encodeWorkers),
      maxEncodeQueue: Number(p.maxEncodeQueue),
      maxPendingBitmaps: Number(p.maxPendingBitmaps),
      writeConcurrency: Number(p.writeConcurrency),
      onProgress: (stats) => {
        progressPoster.push({ done: stats.written, total: frames });
        statsPoster.push({ ...stats, total: frames });
      },
    });

    post("pa_progress", { done: 0, total: frames });

    try {
      await virtualTimeCaptureFromStart({
        fps,
        canvasSelector,
        canvasWaitFrames: Number(p.canvasWaitFrames ?? 600),

        hookDateNow: true,
        hookPerformanceNow: true,
        hookTimers: true,

        frameCount: totalSteps,

        start: async () => {
          restoreDpr = installDevicePixelRatioOverride(p.outputDpr);
          await importEntry(entry);
          // after import, try focus if canvas already exists
          const c = resolveCanvas(canvasSelector);
          if (c instanceof HTMLCanvasElement) {
            focusCanvasBestEffort(c);
            firstCanvasFocused = true;
          }
        },

        onCanvasReady: async (canvas) => {
          if (applyOutputSize(canvas, p)) {
            post("pa_status", {
              status: "running",
              message: `canvas size fixed (${canvas.width}x${canvas.height})`,
            });
          }
          if (canvas instanceof HTMLCanvasElement) {
            focusCanvasBestEffort(canvas);
            firstCanvasFocused = true;
          }
        },

        onFrame: async (canvas, i) => {
          if (!firstCanvasFocused && canvas instanceof HTMLCanvasElement) {
            focusCanvasBestEffort(canvas);
            firstCanvasFocused = true;
          }

          if (stopFlag) throw new Error("stopped");
          const waitResult = await waitForFrameReady({
            canvas,
            frameIndex: i,
            mode: p.renderWaitMode || "auto",
            timeoutMs: Number(p.renderWaitTimeoutMs ?? 5000),
          });
          pipeline.recordRenderWait(waitResult);

          if (i < warmup) return;

          const frameIndex = i - warmup;
          await pipeline.capture(canvas, frameIndex);
        },
      });
    } catch (e) {
      if ((e?.message ?? "") !== "stopped") throw e;
      post("pa_status", {
        status: "running",
        message: "finalizing (stopped)...",
      });
    }

    if (pipeline && !didDrainPipeline) {
      post("pa_status", { status: "running", message: "draining pipeline..." });
      await pipeline.drain();
      didDrainPipeline = true;
    }

    if (exporter && !didFinalize) {
      post("pa_status", { status: "running", message: "finalizing..." });
      const f0 = performance.now();
      await exporter.finalize();
      const f1 = performance.now();
      pipeline?.recordFinalize(f1 - f0);
      didFinalize = true;
    }
    progressPoster.flush();
    statsPoster.flush();

    post("pa_status", {
      status: "idle",
      message: stopFlag ? "stopped (finalized)" : "frame capture finished",
    });
  } catch (e) {
    post("pa_error", { message: e?.message ?? String(e) });
    post("pa_status", { status: "idle" });
  } finally {
    restoreDpr();
    if (pipeline && !didDrainPipeline) {
      try {
        await pipeline.cancel();
      } catch {}
    }
    if (exporter && !didFinalize) {
      try {
        await exporter.finalize();
      } catch {}
    }
    progressPoster.stop();
    statsPoster.stop();
    running = false;
    stopFlag = false;
  }
}

async function runLive(p) {
  running = true;
  stopFlag = false;

  const canvasSelector = p.canvasSelector || "canvas";
  post("pa_status", { status: "running", message: "capture starting..." });

  let exporter = null;
  let didFinalize = false;
  const statsPoster = createThrottledPoster(
    "pa_stats",
    toPositiveInt(p?.statsIntervalMs, 180)
  );

  try {
    exporter = await createExporterFromPayload(p);

    const canvas = resolveCanvas(canvasSelector);
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error(`Canvas not found: ${canvasSelector}`);
    }

    // Try to focus canvas so keyboard interaction goes to sketch
    focusCanvasBestEffort(canvas);

    const ac = new AbortController();
    const stopWatcher = setInterval(() => {
      if (stopFlag && !ac.signal.aborted) ac.abort(new Error("stopped"));
    }, 50);

    try {
      const session = await startLiveCapture({
        canvas,
        exporter,
        fps: Number(p.fps ?? 30),
        concurrency: Number(p.concurrency ?? 2),
        maxQueue: Number(p.maxQueue ?? 8),
        maxPendingCaptures: toPositiveInt(p.maxPendingCaptures, undefined),
        policy: p.policy ?? "drop",
        signal: ac.signal,
        onProgress: (stats) => statsPoster.push(stats),
      });

      post("pa_status", { status: "running", message: "capturing..." });

      const result = await Promise.race([
        new Promise((resolve) => {
          ac.signal.addEventListener(
            "abort",
            () => resolve({ kind: "abort", reason: ac.signal.reason }),
            { once: true }
          );
        }),
        Promise.resolve(session.done).then((v) => ({ kind: "done", value: v })),
      ]);

      if (result.kind === "abort") {
        await session.stop();
        didFinalize = true;
        throw result.reason ?? new Error("stopped");
      }

      didFinalize = true;
      const err = result.value?.error;
      if (err) throw err;
      throw new Error("stopped");
    } finally {
      clearInterval(stopWatcher);
      statsPoster.flush();
    }
  } catch (e) {
    if ((e?.message ?? "") === "stopped") {
      post("pa_status", { status: "idle", message: "stopped" });
    } else {
      post("pa_error", { message: e?.message ?? String(e) });
      post("pa_status", { status: "idle" });
    }
  } finally {
    if (exporter && !didFinalize) {
      try {
        await exporter.finalize();
      } catch {}
    }
    statsPoster.stop();
    running = false;
    stopFlag = false;
  }
}

(function init() {
  const entry = getQueryParam("entry") || "/src/main.js";
  post("pa_preview_ready", { entry });

  sendCanvasList();
  const sendCanvasListThrottled = throttle(sendCanvasList, 120);
  const mo = new MutationObserver(() => sendCanvasListThrottled());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(sendCanvasList, 250);
  setTimeout(sendCanvasList, 1000);

  const autostart = getQueryParam("autostart") === "1";
  const payloadB64 = getQueryParam("payload");

  if (autostart && payloadB64) {
    try {
      const json = atob(payloadB64);
      const payload = JSON.parse(json);
      // IMPORTANT: do not import entry here; runFrameAutostart does it under virtual time
      runFrameAutostart(payload, entry);
    } catch (e) {
      post("pa_error", { message: e?.message ?? String(e) });
    }
  } else {
    importEntry(entry).catch((e) => {
      console.error("[pa_encoder preview] entry import failed:", entry, e);
      post("pa_error", { message: e?.message ?? String(e) });
    });
  }
})();
