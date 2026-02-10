// src/exporters/best.js
import { createFsExporter } from "./fs.js";
import { createZipExporter } from "./zip.js";

export async function createBestExporter({
  prefer = "fs", // "fs" | "zip"
  fs,
  zip,
} = {}) {
  const canFS =
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    "showDirectoryPicker" in window;

  if (prefer === "fs" && canFS) {
    return await createFsExporter(fs);
  }

  if (prefer === "zip") {
    return await createZipExporter(zip);
  }

  // fs not available -> zip fallback
  return await createZipExporter(zip);
}
