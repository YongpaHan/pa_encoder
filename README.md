HTML canvas frame encoder made for personal use.

# Installation

```bash
npm install pa_encoder
```

Provides:

- JavaScript API (ES module)
- CLI tool (`pa_encoder`)

---

# Usage

## CLI (recommended)

Starts a local proxy server and opens a browser UI.

```bash
pa_encoder --url http://localhost:5173 --entry /src/main.js
```

### Options

- `--url` Target site URL
- `--entry` Entry script imported in preview iframe
- `--port` UI server port (default: `8787`)

The UI shows a live preview, capture controls, and progress logs.

Live mode UI tips:
- `Duration=0` means manual stop
- `PendingCap` limits concurrent canvas snapshot tasks
- `Stats(ms)` controls status update interval to keep UI lightweight

Frame mode UI tips:
- `Best`/`FS` writes PNG frames directly to a chosen directory from the UI
- `Workers` controls parallel PNG encoding after each frame snapshot is captured
- `PendingBmp` limits how many `ImageBitmap` snapshots can be held in memory
- `Wait=auto` uses a sketch render hook or exposed WebGPU queue when available

For WebGPU sketches, expose either:

```js
window.__pa_encoder_gpuDevice = device;
// or
window.__pa_encoder_waitForFrame = async () => {
  await device.queue.onSubmittedWorkDone();
};
```

---

## JavaScript API

### Live capture (real-time)

```js
import { startLiveCapture, createZipExporter } from "pa_encoder";

const canvas = document.querySelector("canvas");
const exporter = await createZipExporter({ zipName: "frames.zip" });

const session = await startLiveCapture({
  canvas,
  exporter,
  fps: 30,
  maxPendingCaptures: 2,
});

await session.stop();
```

`startLiveCapture()` returns `{ stop, stats, done }`:
- `stop()` finalizes capture/export
- `stats` is the live mutable stats object
- `done` resolves when capture fully stops/finalizes

---

### Deterministic frame capture (virtual time)

```js
import {
  virtualTimeCaptureFromStart,
  waitForFrameReady,
  createFramePngPipeline,
  createFsExporter,
} from "pa_encoder";

const exporter = await createFsExporter({ dirNameHint: "frames" });
const pipeline = await createFramePngPipeline({
  exporter,
  encodeWorkers: 3,
  maxPendingBitmaps: 4,
  maxEncodeQueue: 8,
});

await virtualTimeCaptureFromStart({
  fps: 60,
  frameCount: 300,
  start: async () => {
    await import("/src/main.js");
  },
  onFrame: async (canvas, i) => {
    await waitForFrameReady({ canvas, frameIndex: i, mode: "auto" });
    await pipeline.capture(canvas, i);
  },
});

await pipeline.drain();
await exporter.finalize();
```

Hooks `requestAnimationFrame`, time APIs, and timers to ensure deterministic output.
Frame snapshots are captured sequentially for correctness, then PNG encoding and writes are pipelined.

---

## Exporters

All exporters share the same interface:

```ts
{
  write(frameIndex, blob);
  finalize();
}
```

### ZIP exporter

```js
import { createZipExporter } from "pa_encoder";
await createZipExporter({ zipName: "frames.zip" });
```

Downloads a ZIP of PNG frames.

---

### File System exporter (Chromium)

```js
import { createFsExporter } from "pa_encoder";
await createFsExporter({ dirNameHint: "frames" });
```

Writes directly to a directory (secure context required).

---

### Best exporter

```js
import { createBestExporter } from "pa_encoder";
await createBestExporter({ prefer: "fs" });
```

Uses File System export when available, otherwise ZIP.

---

## Supported Environments

- Modern Chromium-based browsers recommended
- Requires:
  - ES module Web Workers
  - `OffscreenCanvas`
  - `createImageBitmap`
- ZIP export works in most modern browsers
- File System export requires Chromium + secure context
