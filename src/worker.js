// src/worker.js
let offscreen = null;
let ctx = null;

self.postMessage({ type: "ready" });

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "encode") return;

  const { frameIndex, bitmap, width, height } = msg;

  const t0 = performance.now();
  try {
    if (
      !offscreen ||
      offscreen.width !== width ||
      offscreen.height !== height
    ) {
      offscreen = new OffscreenCanvas(width, height);
      ctx = offscreen.getContext("2d", { alpha: true });
      if (!ctx) throw new Error("Failed to get 2d context on OffscreenCanvas");
    }

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);

    const blob = await offscreen.convertToBlob({ type: "image/png" });
    const t1 = performance.now();

    self.postMessage({ type: "frame", frameIndex, blob, encodeMs: t1 - t0 });
  } catch (e) {
    self.postMessage({
      type: "error",
      frameIndex,
      message: e?.message ?? String(e),
    });
  } finally {
    if (typeof bitmap?.close === "function") {
      try {
        bitmap.close();
      } catch {}
    }
  }
};
