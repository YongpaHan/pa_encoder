import {
  virtualTimeCaptureFromStart,
  startLiveCapture,
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

function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("canvas.toBlob() returned null"));
    }, type);
  });
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

async function createExporterFromPayload(p = {}) {
  const mode = p.exporter?.mode || "best";
  const prefer = p.exporter?.prefer || "fs";
  const zipName = p.exporter?.zipName || "frames.zip";

  if (mode === "zip") return await createZipExporter({ zipName });
  if (mode === "fs") return await createFsExporter();
  return await createBestExporter({ prefer, zip: { zipName } });
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
    const c = document.querySelector(sel) || document.querySelector("canvas");
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
  let firstCanvasFocused = false;

  try {
    exporter = await createExporterFromPayload(p);

    const fps = Number(p.fps ?? 60);
    const frames = Number(p.frames ?? 300);
    const warmup = Number(p.warmup ?? 0);
    const totalSteps = warmup + frames;

    let written = 0;
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
          await importEntry(entry);
          // after import, try focus if canvas already exists
          const c =
            document.querySelector(canvasSelector) ||
            document.querySelector("canvas");
          if (c instanceof HTMLCanvasElement) {
            focusCanvasBestEffort(c);
            firstCanvasFocused = true;
          }
        },

        onFrame: async (canvas, i) => {
          if (!firstCanvasFocused && canvas instanceof HTMLCanvasElement) {
            focusCanvasBestEffort(canvas);
            firstCanvasFocused = true;
          }

          if (stopFlag) throw new Error("stopped");
          if (i < warmup) return;

          const frameIndex = i - warmup;
          const blob = await canvasToBlob(canvas, "image/png");
          await exporter.write(frameIndex, blob);

          written++;
          post("pa_progress", { done: written, total: frames });
          post("pa_stats", { written, captured: i + 1 });
        },
      });
    } catch (e) {
      if ((e?.message ?? "") !== "stopped") throw e;
      post("pa_status", {
        status: "running",
        message: "finalizing (stopped)...",
      });
    }

    if (exporter && !didFinalize) {
      await exporter.finalize();
      didFinalize = true;
    }

    post("pa_status", {
      status: "idle",
      message: stopFlag ? "stopped (finalized)" : "frame capture finished",
    });
  } catch (e) {
    post("pa_error", { message: e?.message ?? String(e) });
    post("pa_status", { status: "idle" });
  } finally {
    if (exporter && !didFinalize) {
      try {
        await exporter.finalize();
      } catch {}
    }
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

  try {
    exporter = await createExporterFromPayload(p);

    const canvas =
      document.querySelector(canvasSelector) ||
      document.querySelector("canvas");
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
      const { stop } = await startLiveCapture({
        canvas,
        exporter,
        fps: Number(p.fps ?? 30),
        concurrency: Number(p.concurrency ?? 2),
        maxQueue: Number(p.maxQueue ?? 8),
        policy: p.policy ?? "drop",
        signal: ac.signal,
        onProgress: (stats) => post("pa_stats", stats),
      });

      post("pa_status", { status: "running", message: "capturing..." });

      await new Promise((_, reject) => {
        ac.signal.addEventListener("abort", () => reject(ac.signal.reason));
      }).catch(async (e) => {
        await stop();
        didFinalize = true;
        throw e;
      });
    } finally {
      clearInterval(stopWatcher);
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
    running = false;
    stopFlag = false;
  }
}

(function init() {
  const entry = getQueryParam("entry") || "/src/main.js";
  post("pa_preview_ready", { entry });

  sendCanvasList();
  const mo = new MutationObserver(() => sendCanvasList());
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
