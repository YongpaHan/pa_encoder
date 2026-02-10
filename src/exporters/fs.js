export async function createFsExporter({
  dirNameHint = "frames",
  filename = (i) => `frame_${String(i).padStart(6, "0")}.png`,
} = {}) {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("File System Access API is not supported in this browser.");
  }

  const dirHandle = await window.showDirectoryPicker({ id: dirNameHint });

  return {
    async write(frameIndex, blob) {
      const name = filename(frameIndex);
      const fileHandle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    },
    async finalize() {
      // nothing
    },
  };
}
