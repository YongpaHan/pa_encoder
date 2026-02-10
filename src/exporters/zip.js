// src/exporters/zip.js
import JSZip from "jszip";

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function createZipExporter({
  zipName = "frames.zip",
  filename = (i) => `frame_${String(i).padStart(6, "0")}.png`,
  compressionLevel = 6, // 0..9
} = {}) {
  const zip = new JSZip();
  let count = 0;

  return {
    async write(frameIndex, blob) {
      const name = filename(frameIndex);
      const arr = await blob.arrayBuffer();
      zip.file(name, arr);
      count++;
    },
    async finalize() {
      const out = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: compressionLevel },
      });
      downloadBlob(zipName, out);
      return { files: count };
    },
  };
}
