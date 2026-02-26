function qp(name) {
  return new URL(location.href).searchParams.get(name);
}

const $ = (id) => document.getElementById(id);

const entryEl = $("entry");
const modeEl = $("mode");
const canvasEl = $("canvas");
const fpsEl = $("fps");
const exporterEl = $("exporter");

const policyEl = $("policy");
const concurrencyEl = $("concurrency");
const maxQueueEl = $("maxQueue");
const durationEl = $("duration");
const maxPendingCapturesEl = $("maxPendingCaptures");
const statsIntervalMsEl = $("statsIntervalMs");

const framesEl = $("frames");
const warmupEl = $("warmup");

const detailsLive = $("detailsLive");
const detailsFrame = $("detailsFrame");

const btnReload = $("btnReload");
const btnStart = $("btnStart");
const btnStop = $("btnStop");

const btnHide = $("btnHide");
const btnCompact = $("btnCompact");
const btnDock = $("btnDock");

const btnPassthrough = $("btnPassthrough");
const btnFocus = $("btnFocus");

const logEl = $("log");
const statsEl = $("stats");
const preview = $("preview");

let running = false;
let stopTimer = null;

const docks = ["dock-br", "dock-bl", "dock-tr", "dock-tl"];
let dockIndex = 0;

let passthrough = false;
let lastStatusLog = "";

const LOG_MAX_LINES = 220;
const logLines = [];
const runtimeState = {
  status: "idle",
  message: "",
  progressDone: 0,
  progressTotal: 0,
  stats: null,
};

function toPositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function toNonNegativeNumber(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function appendLog(line) {
  const s = String(line ?? "");
  logLines.push(s);
  if (logLines.length > LOG_MAX_LINES) {
    logLines.splice(0, logLines.length - LOG_MAX_LINES);
  }
  logEl.textContent = logLines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(v) {
  running = v;
  btnStart.disabled = v;
  btnStop.disabled = !v;

  // recording starts -> enable passthrough so canvas can receive interaction
  if (v) {
    setPassthrough(true, { silent: true });
    // best-effort focus request
    postToPreview("pa_focus_canvas", {
      canvasSelector: selectedCanvasSelector(),
    });
  }
}

function nfmt(v, d = 2) {
  if (!Number.isFinite(v)) return "-";
  return Number(v).toFixed(d);
}

function renderStats() {
  const s = runtimeState.stats || null;
  const lines = [];

  lines.push(
    `status: ${runtimeState.status}${
      runtimeState.message ? ` (${runtimeState.message})` : ""
    }`
  );

  if (runtimeState.progressTotal > 0) {
    lines.push(`progress: ${runtimeState.progressDone}/${runtimeState.progressTotal}`);
  }

  if (!s) {
    lines.push("captured: -  encoded: -  written: -");
    lines.push("dropped: -   failed: -");
    lines.push("bitmap ms: -/-   encode ms: -/-   write ms: -/-");
    lines.push("queueMax: -   inFlightMax: -   pendingMax: -");
  } else {
    lines.push(
      `captured: ${s.captured ?? 0}  encoded: ${s.encoded ?? 0}  written: ${
        s.written ?? 0
      }`
    );
    lines.push(`dropped: ${s.dropped ?? 0}   failed: ${s.failed ?? 0}`);
    lines.push(
      `bitmap ms: ${nfmt(s.lastBitmapMs)}/${nfmt(s.bitmapMsAvg)}   ` +
        `encode ms: ${nfmt(s.lastEncodeMs)}/${nfmt(s.encodeMsAvg)}   ` +
        `write ms: ${nfmt(s.lastWriteMs)}/${nfmt(s.writeMsAvg)}`
    );
    lines.push(
      `queueMax: ${s.queueMax ?? 0}   inFlightMax: ${
        s.inFlightMax ?? 0
      }   pendingMax: ${s.pendingCaptureMax ?? 0}`
    );
  }

  statsEl.textContent = lines.join("\n");
}

function buildPreviewUrl(entry) {
  const e = entry || "/src/main.js";
  return `/__pa_encoder__/ui/preview.html?entry=${encodeURIComponent(e)}`;
}

function buildPreviewAutostartUrl(entry, payload) {
  const e = entry || "/src/main.js";
  const json = JSON.stringify(payload);
  const b64 = btoa(json);
  return (
    `/__pa_encoder__/ui/preview.html?entry=${encodeURIComponent(e)}` +
    `&autostart=1&payload=${encodeURIComponent(b64)}`
  );
}

function reloadPreview() {
  const entry = entryEl.value.trim() || "/src/main.js";
  preview.src = buildPreviewUrl(entry);
  appendLog(`reloading preview (entry=${entry})`);
}

function postToPreview(type, payload = {}) {
  const w = preview.contentWindow;
  if (!w) return false;
  w.postMessage({ type, payload }, "*");
  return true;
}

function fillCanvasDropdown(canvases) {
  const prev = canvasEl.value;

  canvasEl.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = canvases.length ? "(auto)" : "(no canvas found)";
  canvasEl.appendChild(opt0);

  for (const c of canvases) {
    const opt = document.createElement("option");
    opt.value = c.selector;
    opt.textContent = c.label || c.selector;
    canvasEl.appendChild(opt);
  }

  const hasPrev = Array.from(canvasEl.options).some((o) => o.value === prev);
  if (hasPrev) canvasEl.value = prev;
}

function selectedCanvasSelector() {
  return canvasEl.value || "canvas";
}

function exporterPayload() {
  const mode = exporterEl.value; // zip|fs|best
  const zipName = "frames.zip";
  return { exporter: { mode, prefer: "fs", zipName } };
}

function setDockByIndex(i) {
  for (const d of docks) document.body.classList.remove(d);
  dockIndex = ((i % docks.length) + docks.length) % docks.length;
  document.body.classList.add(docks[dockIndex]);
}

function cycleDock() {
  setDockByIndex(dockIndex + 1);
  appendLog(`dock: ${docks[dockIndex]}`);
}

function setPassthrough(on, { silent = false } = {}) {
  passthrough = !!on;
  document.body.classList.toggle("passthrough", passthrough);
  btnPassthrough.textContent = `Passthrough: ${passthrough ? "On" : "Off"}`;
  if (!silent) appendLog(`passthrough: ${passthrough ? "on" : "off"}`);
}

function focusSketch() {
  // Best-effort:
  // - Enable passthrough so user can click canvas
  // - Ask preview to focus the canvas
  setPassthrough(true);
  postToPreview("pa_focus_canvas", {
    canvasSelector: selectedCanvasSelector(),
  });
  appendLog("focus sketch: click the canvas if focus is not acquired");
}

function syncModeUI() {
  const isFrame = modeEl.value === "frame";
  detailsFrame.style.display = isFrame ? "block" : "none";
  detailsLive.style.display = isFrame ? "none" : "block";
  if (isFrame) detailsFrame.open = true;
  else detailsLive.open = true;
}

function currentPayload() {
  const fps = Math.max(1, Math.floor(Number(fpsEl.value || "60")));
  const kind = modeEl.value === "frame" ? "frame" : "live";
  const canvasSelector = selectedCanvasSelector();
  const statsIntervalMs = Math.max(
    50,
    toPositiveInt(statsIntervalMsEl.value, 180)
  );

  if (kind === "frame") {
    const frames = Math.max(1, Math.floor(Number(framesEl.value || "300")));
    const warmup = Math.max(0, Math.floor(Number(warmupEl.value || "0")));
    return {
      kind: "frame",
      fps,
      frames,
      warmup,
      canvasSelector,
      statsIntervalMs,
      ...exporterPayload(),
    };
  }

  const duration = toNonNegativeNumber(durationEl.value, 10);
  const maxPendingCaptures = Math.max(
    1,
    toPositiveInt(maxPendingCapturesEl.value, 2)
  );

  return {
    kind: "live",
    fps,
    duration,
    canvasSelector,
    policy: policyEl.value,
    concurrency: Math.max(1, Math.floor(Number(concurrencyEl.value || "2"))),
    maxQueue: Math.max(0, Math.floor(Number(maxQueueEl.value || "8"))),
    maxPendingCaptures,
    statsIntervalMs,
    ...exporterPayload(),
  };
}

function start() {
  if (running) return;

  const payload = currentPayload();
  const entry = entryEl.value.trim() || "/src/main.js";

  setRunning(true);
  appendLog(
    `start: ${payload.kind} fps=${payload.fps} canvas=${payload.canvasSelector}`
  );
  runtimeState.status = "running";
  runtimeState.message = "starting";
  runtimeState.progressDone = 0;
  runtimeState.progressTotal = 0;
  runtimeState.stats = null;
  renderStats();

  // start recording -> prefer passthrough + focus canvas
  setPassthrough(true, { silent: true });

  if (payload.kind === "frame") {
    // Frame mode: reload preview with autostart so virtual-time hooks apply before sketch starts
    preview.src = buildPreviewAutostartUrl(entry, payload);
    return;
  }

  const ok = postToPreview("pa_start_frame_capture", payload);
  if (!ok) {
    setRunning(false);
    appendLog("ERROR: preview iframe not ready");
    return;
  }

  clearTimeout(stopTimer);
  if (payload.duration > 0) {
    stopTimer = setTimeout(() => stop(), payload.duration * 1000);
  } else {
    stopTimer = null;
    appendLog("live duration=0 (manual stop)");
  }
}

function stop() {
  if (!running) return;

  clearTimeout(stopTimer);
  stopTimer = null;

  postToPreview("pa_stop", {});
  appendLog("stop requested...");
}

/* UI events */
btnReload.addEventListener("click", () => reloadPreview());
btnStart.addEventListener("click", () => start());
btnStop.addEventListener("click", () => stop());

btnHide.addEventListener("click", () =>
  document.body.classList.toggle("hidden")
);
btnCompact.addEventListener("click", () =>
  document.body.classList.toggle("compact")
);
btnDock.addEventListener("click", () => cycleDock());

btnPassthrough.addEventListener("click", () => setPassthrough(!passthrough));
btnFocus.addEventListener("click", () => focusSketch());

modeEl.addEventListener("change", () => syncModeUI());

/**
 * Hotkeys behavior:
 * - Only active when NOT recording (running === false).
 * - While recording, UI does not call preventDefault or consume keys.
 *   This minimizes interference with live keyboard interaction in the sketch.
 */
window.addEventListener("keydown", (e) => {
  if (running) return; // do not intercept any keys while recording

  const active = document.activeElement?.tagName?.toLowerCase() || "";
  const isTyping =
    active === "input" || active === "textarea" || active === "select";
  if (isTyping) return;

  const k = (e.key || "").toLowerCase();

  if (k === "h") {
    e.preventDefault();
    document.body.classList.toggle("hidden");
    return;
  }

  if (k === "p") {
    e.preventDefault();
    setPassthrough(!passthrough);
    return;
  }

  if (k === "c") {
    e.preventDefault();
    document.body.classList.toggle("compact");
    return;
  }

  if (k === "d") {
    e.preventDefault();
    cycleDock();
    return;
  }

  // Space starts recording when idle; during recording we do not bind Space to stop.
  if (e.code === "Space") {
    e.preventDefault();
    start();
    return;
  }
});

/* Messages from preview */
window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "pa_preview_ready") {
    appendLog(`preview ready (entry=${msg.entry})`);
    return;
  }

  if (msg.type === "pa_preview_canvas_list") {
    const canvases = Array.isArray(msg.canvases) ? msg.canvases : [];
    fillCanvasDropdown(canvases);
    return;
  }

  if (msg.type === "pa_status") {
    const status = msg.status || "";
    const message = msg.message || "";
    const line = message ? `${status}: ${message}` : String(status);
    if (line !== lastStatusLog) {
      appendLog(line);
      lastStatusLog = line;
    }
    runtimeState.status = status || "idle";
    runtimeState.message = message || "";
    renderStats();

    if (status === "idle") {
      setRunning(false);
      // optionally return UI control after recording
      // (do not force passthrough off; user may want to keep interacting)
      btnStart.focus?.();
    }
    if (status === "running") {
      setRunning(true);
    }
    return;
  }

  if (msg.type === "pa_progress") {
    runtimeState.progressDone = Number(msg.done ?? 0);
    runtimeState.progressTotal = Number(msg.total ?? 0);
    renderStats();
    return;
  }

  if (msg.type === "pa_stats") {
    const safe = { ...msg };
    delete safe.type;
    runtimeState.stats = safe;
    renderStats();
    return;
  }

  if (msg.type === "pa_error") {
    appendLog(`ERROR: ${msg.message || "unknown error"}`);
    runtimeState.status = "error";
    runtimeState.message = msg.message || "unknown error";
    renderStats();
    setRunning(false);
  }
});

/* init */
(function init() {
  setDockByIndex(0);
  setPassthrough(false, { silent: true });

  const entry = qp("entry") || "/src/main.js";
  entryEl.value = entry;

  setRunning(false);
  syncModeUI();
  renderStats();

  fillCanvasDropdown([]);
  appendLog("loading preview...");
  preview.src = buildPreviewUrl(entry);
})();
