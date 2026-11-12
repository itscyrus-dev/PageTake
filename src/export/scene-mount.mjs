const scriptUrl = new URL("./runtime.js", import.meta.url);
let runtimePromise;

function loadRuntime() {
  runtimePromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl.href;
    script.onload = () => {
      if (typeof window.UnicornStudio?.addScene === "function") resolve(window.UnicornStudio);
      else reject(new Error("Captured scene runtime did not expose addScene"));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("Captured scene runtime failed to load"));
    };
    document.head.append(script);
  }).catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

async function loadJson(name, signal) {
  const response = await fetch(new URL(name, import.meta.url), { signal });
  if (!response.ok) throw new Error(`Scene asset ${name} returned HTTP ${response.status}`);
  return response.json();
}

function rebase(value) {
  if (typeof value === "string" && value.startsWith("./assets/")) return new URL(value, import.meta.url).href;
  if (Array.isArray(value)) return value.map(rebase);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rebase(entry)]));
  }
  return value;
}

export async function mountScene(element, { signal } = {}) {
  signal?.throwIfAborted();
  const [runtime, scene, options] = await Promise.all([
    loadRuntime(), loadJson("./scene.json", signal), loadJson("./options.json", signal),
  ]);
  signal?.throwIfAborted();
  const data = document.createElement("script");
  data.type = "application/json";
  data.id = "pagetake-scene-" + crypto.randomUUID();
  data.textContent = JSON.stringify(rebase(scene));
  document.body.append(data);
  try {
    const mounted = await runtime.addScene({ ...options, element, filePath: data.id });
    if (signal?.aborted) {
      mounted.destroy();
      signal.throwIfAborted();
    }
    return mounted;
  } finally {
    data.remove();
  }
}
