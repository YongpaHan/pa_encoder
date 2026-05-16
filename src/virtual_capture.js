// src/virtual_capture.js
import { installVirtualTime } from "./virtual_time.js";

/**
 * Find first matching element in:
 * - current document
 * - any same-origin iframes recursively
 * - open shadowRoots (optional scan)
 *
 * Returns { el, doc } or null
 */
function findElementDeep({
  doc,
  selector,
  includeShadow = true,
  maxIframeDepth = 8,
  _depth = 0,
} = {}) {
  if (!doc || _depth > maxIframeDepth) return null;

  // 1) document query
  try {
    const el = doc.querySelector(selector);
    if (el) return { el, doc };
  } catch {}

  // 2) open shadow roots scan (best-effort)
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
      } catch {}
    }
  }

  // 3) same-origin iframes recursively
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
      _depth: _depth + 1,
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
    })(),
  };
  console.warn("[pa_encoder]", info);
}

function waitForCanvasLiveDeep({
  selector = "canvas",
  timeoutMs = 15000,
  pollMs = 50,
  includeShadow = true,
} = {}) {
  const immediate = findElementDeep({ doc: document, selector, includeShadow });
  if (immediate?.el) return Promise.resolve(immediate);

  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let done = false;
    let intervalId = null;

    const cleanup = (observer) => {
      if (done) return;
      done = true;
      try {
        observer?.disconnect();
      } catch {}
      if (intervalId) clearInterval(intervalId);
    };

    const check = (observer) => {
      const found = findElementDeep({ doc: document, selector, includeShadow });
      if (found?.el) {
        cleanup(observer);
        resolve(found);
        return;
      }
      if (performance.now() - t0 > timeoutMs) {
        cleanup(observer);
        debugSnapshot("waitForCanvasLiveDeep timeout");
        reject(new Error(`Timed out waiting for canvas selector: ${selector}`));
      }
    };

    const observer = new MutationObserver(() => check(observer));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    intervalId = setInterval(() => check(observer), pollMs);
  });
}

function resolveCanvasFromFound(found) {
  const el = found?.el;
  if (el instanceof HTMLCanvasElement) return el;
  throw new Error("Found element is not a canvas");
}

async function resolveCanvasWithWaitDeep({
  vt,
  selector = "canvas",
  canvasWaitFrames = 240,
  includeShadow = true,
} = {}) {
  const tryResolve = () => {
    const found = findElementDeep({ doc: document, selector, includeShadow });
    if (!found?.el) throw new Error("No canvas found on the page");
    return resolveCanvasFromFound(found);
  };

  try {
    return tryResolve();
  } catch (e) {
    console.warn("[pa_encoder] resolveCanvas failed:", e?.message ?? e);
  }

  for (let i = 0; i < canvasWaitFrames; i++) {
    vt.step(1);
    try {
      return tryResolve();
    } catch (e) {
      console.warn("[pa_encoder] resolveCanvas failed:", e?.message ?? e);
    }
  }

  throw new Error("No canvas found on the page");
}

/**
 * 기존 함수: "캔버스가 생긴 뒤" 훅 설치
 */
export async function virtualTimeCapture({
  fps = 60,
  canvasSelector = "canvas",
  preWaitTimeoutMs = 15000,
  includeShadow = true,
  canvasWaitFrames = 240,
  hookDateNow = true,
  hookPerformanceNow = true,
  hookTimers = true,
  frameCount = 60,
  onFrame = null,
} = {}) {
  debugSnapshot("virtualTimeCapture start");

  const foundLive = await waitForCanvasLiveDeep({
    selector: canvasSelector || "canvas",
    timeoutMs: preWaitTimeoutMs,
    includeShadow,
  });

  resolveCanvasFromFound(foundLive);

  const vt = installVirtualTime({
    fps,
    hookDateNow,
    hookPerformanceNow,
    hookTimers,
  });

  try {
    let canvas = await resolveCanvasWithWaitDeep({
      vt,
      selector: canvasSelector || "canvas",
      canvasWaitFrames,
      includeShadow,
    });

    for (let i = 0; i < frameCount; i++) {
      vt.step(1);

      if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) {
        canvas = await resolveCanvasWithWaitDeep({
          vt,
          selector: canvasSelector || "canvas",
          canvasWaitFrames: 30,
          includeShadow,
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

/**
 * ✅ 새 함수: "훅 설치 → start() 실행(import entry) → vt.step로 진행" (p5 deterministic에 필요)
 */
export async function virtualTimeCaptureFromStart({
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
  onFrame = null,
} = {}) {
  debugSnapshot("virtualTimeCaptureFromStart begin");

  const vt = installVirtualTime({
    fps,
    hookDateNow,
    hookPerformanceNow,
    hookTimers,
  });

  try {
    if (typeof start === "function") {
      await start(); // import entry while hooks are active
    }

    let canvas = await resolveCanvasWithWaitDeep({
      vt,
      selector: canvasSelector || "canvas",
      canvasWaitFrames,
      includeShadow,
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
          includeShadow,
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
