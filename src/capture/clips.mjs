import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const canvasClipFile = /^canvas-(?:standalone|action-(?:[1-9]|1[0-2]))\.webm$/;

export function installClipCapture() {
  let clip;
  const limit = 6 * 1024 * 1024;

  return {
    start(selector) {
      if (clip) throw new Error("A Canvas clip is already recording");
      document.querySelector(selector); // Report an invalid selector immediately.
      clip = { selector, requestedAt: performance.now(), chunks: [], bytes: 0 };
      const current = clip;
      function tryStart() {
        const canvas = document.querySelector(selector);
        if (!canvas) return;
        clearInterval(current.search);
        try {
          if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Selector target is not a Canvas");
          if (!canvas.width || !canvas.height) throw new Error("Canvas has zero dimensions");
          current.stream = canvas.captureStream(24);
          current.width = canvas.width;
          current.height = canvas.height;
          current.recorder = new MediaRecorder(current.stream, { mimeType: "video/webm", videoBitsPerSecond: 1_800_000 });
          current.done = new Promise((resolve) => {
            current.recorder.addEventListener("error", (event) => {
              current.error = event.error?.message ?? "Canvas encoding failed";
              resolve();
            }, { once: true });
            current.recorder.addEventListener("stop", resolve, { once: true });
          });
          current.recorder.addEventListener("dataavailable", (event) => {
            current.bytes += event.data.size;
            if (current.bytes <= limit) current.chunks.push(event.data);
            else {
              current.error = "Canvas clip exceeded the size limit";
              if (current.recorder.state !== "inactive") current.recorder.stop();
            }
          });
          current.recorder.start(200);
          current.startedAt = performance.now();
          current.stream.getVideoTracks()[0]?.requestFrame?.();
        } catch (error) {
          current.error = error.message;
        }
      }
      current.search = setInterval(tryStart, 40);
      tryStart();
    },
    async stop() {
      if (!clip) return { error: "Canvas recording was not started" };
      const current = clip;
      clip = undefined;
      clearInterval(current.search);
      const endedAt = performance.now();
      try {
        if (current.recorder?.state && current.recorder.state !== "inactive") {
          current.recorder.stop();
          const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 2000));
          if (await Promise.race([current.done.then(() => true), timeout]) === false) return { error: "Canvas encoder did not finish in time" };
        }
        if (current.error) return { error: current.error };
        if (!current.recorder) return { error: "Canvas target was not found during the recording window" };
        if (!current.bytes) return { error: "Canvas did not produce any encodable frames" };
        const blob = new Blob(current.chunks, { type: "video/webm" });
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const { requestedAt, startedAt, width, height, bytes } = current;
        return { data, requestedAt, startedAt, endedAt, durationMs: endedAt - startedAt, width, height, bytes, fpsLimit: 24 };
      } finally {
        for (const track of current.stream?.getTracks() ?? []) track.stop();
      }
    },
  };
}

export function canvasCapture(motion, output) {
  return async (selector, name) => {
    try {
      await motion.startClip(selector);
    } catch (error) {
      return async () => ({ selector, error: error.message });
    }
    return async () => {
      try {
        const { data, ...info } = await motion.stopClip();
        if (!data) return { selector, ...info };
        const file = "canvas-" + name + ".webm";
        await writeFile(join(output, file), Buffer.from(data, "base64"));
        return { selector, file, ...info };
      } catch (error) {
        return { selector, error: error.message };
      }
    };
  };
}
