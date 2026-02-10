HTML canvas frame encoder made for personal use (ツ)

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

---

## JavaScript API

### Live capture (real-time)

```js
import { startLiveCapture, createZipExporter } from "pa_encoder";

const canvas = document.querySelector("canvas");
const exporter = await createZipExporter({ zipName: "frames.zip" });

const { stop } = await startLiveCapture({
  canvas,
  exporter,
  fps: 30,
});

await stop();
```

---

### Deterministic frame capture (virtual time)

```js
import { virtualTimeCaptureFromStart, createZipExporter } from "pa_encoder";

const exporter = await createZipExporter({ zipName: "frames.zip" });

await virtualTimeCaptureFromStart({
  fps: 60,
  frameCount: 300,
  start: async () => {
    await import("/src/main.js");
  },
  onFrame: async (canvas, i) => {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    await exporter.write(i, blob);
  },
});

await exporter.finalize();
```

Hooks `requestAnimationFrame`, time APIs, and timers to ensure deterministic output.

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

---

(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)(ツ)^0^
