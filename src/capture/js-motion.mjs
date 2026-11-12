function observeFrames(key) {
  if (window !== top) return;
  const request = window.requestAnimationFrame;
  const callbacks = new WeakMap();
  const tracks = [];
  const activity = [];
  const round = (value) => Math.round(value * 10) / 10;
  let overflow = 0;
  let totalFrames = 0;

  function keep(samples, sample, capacity) {
    if (samples.length === capacity) {
      for (let index = Math.floor(capacity * 0.7) - 1; index > 0; index -= 2) samples.splice(index, 1);
    }
    samples.push(sample);
  }

  window.requestAnimationFrame = function (callback) {
    if (typeof callback !== "function") return request.call(this, callback);
    const requestedAt = performance.now();
    let track = callbacks.get(callback);
    if (track === undefined) {
      track = null;
      if (tracks.length < 180) {
        track = { id: tracks.length + 1, name: String(callback.name ?? "").slice(0, 120), calls: 0, samples: [] };
        tracks.push(track);
      }
      callbacks.set(callback, track);
    }
    return request.call(this, function (timestamp) {
      const t = round(timestamp);
      if (track) {
        track.calls++;
        track.firstMs ??= t;
        track.lastMs = t;
        keep(track.samples, { t, requestedAt: round(requestedAt) }, 80);
      } else overflow++;
      const frame = activity.at(-1);
      if (frame?.t === t) frame.callbacks++;
      else {
        totalFrames++;
        keep(activity, { t, callbacks: 1 }, 1200);
      }
      return callback.call(this, timestamp);
    });
  };
  Object.defineProperty(window, key, {
    value: () => ({
      clock: "performance.now() since navigation", driver: "requestAnimationFrame",
      totalFrames, activity, callbacks: tracks.filter(({ calls }) => calls > 0), untrackedCalls: overflow,
    }),
  });
}

export async function startJsMotion(page, key) {
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "(" + observeFrames.toString() + ")(" + JSON.stringify(key) + ")",
  });
  return async () => {
    const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
      expression: "window[" + JSON.stringify(key) + "]?.()", returnByValue: true,
    });
    if (exceptionDetails || !result.value) throw new Error("Could not read JavaScript frame activity");
    return result.value;
  };
}
