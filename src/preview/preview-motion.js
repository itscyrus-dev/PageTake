(() => {
  const query = new URLSearchParams(location.search);
  const mode = query.get("motion");
  const time = Number(query.get("t") ?? 0);
  const speed = Number(query.get("speed") ?? 0.25);
  const section = query.get("section");
  const stateName = document.currentScript?.dataset.state;
  const nativeFrame = window.requestAnimationFrame.bind(window);
  const nativeNow = performance.now.bind(performance);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const controlsMotion = ["speed", "pause", "step"].includes(mode);

  function installJsFrameClock() {
    const queue = new Map();
    const cancel = window.cancelAnimationFrame.bind(window);
    let handle = 2 ** 32;
    let active = false;
    let previous;
    let virtual;
    let remaining = mode === "step" || query.has("t") ? Math.min(10000, Math.max(0, time || 0)) : 0;
    const rate = Number.isFinite(speed) && speed > 0 && speed <= 4 ? speed : 0.25;
    performance.now = () => active ? virtual : nativeNow();
    window.requestAnimationFrame = function (callback) {
      if (typeof callback !== "function") throw new TypeError("A frame callback is required");
      if (!active) {
        const id = nativeFrame((timestamp) => {
          if (active) queue.set(id, callback);
          else callback.call(window, timestamp);
        });
        return id;
      }
      queue.set(++handle, callback);
      return handle;
    };
    window.cancelAnimationFrame = (id) => {
      if (!queue.delete(Number(id)) && id < 2 ** 32) cancel(id);
    };
    function tick(timestamp) {
      const delta = previous === undefined ? 0 : Math.max(0, timestamp - previous);
      previous = timestamp;
      const increment = mode === "speed" ? delta * rate : Math.min(delta, remaining);
      virtual += increment;
      if (mode !== "speed") remaining -= increment;
      if (increment > 0 || (mode === "speed" && delta === 0)) {
        for (const id of [...queue.keys()]) {
          const callback = queue.get(id);
          if (!callback) continue;
          queue.delete(id);
          try { callback.call(window, virtual); }
          catch (error) { reportError(error); }
        }
      }
      if (mode === "speed" || remaining > 0) nativeFrame(tick);
    }
    return () => {
      virtual = nativeNow();
      active = true;
      nativeFrame(tick);
    };
  }
  const activateJsClock = controlsMotion && query.get("js") === "1" ? installJsFrameClock() : null;

  function controlMotion() {
    if (!controlsMotion) return;
    const seen = new WeakSet();
    function update() {
      for (const animation of document.getAnimations()) {
        if (seen.has(animation) || animation.timeline !== document.timeline) continue;
        try {
          if (mode === "speed" && Number.isFinite(speed) && speed > 0 && speed <= 4) {
            animation.updatePlaybackRate(speed);
          } else if (mode === "pause" || mode === "step") {
            animation.pause();
            if ((mode === "step" || query.has("t")) && Number.isFinite(time) && time >= 0) animation.currentTime = time;
          }
          seen.add(animation);
        } catch {
          // A timeline can become inactive between discovery and control.
        }
      }
      nativeFrame(update);
    }
    nativeFrame(update);
    activateJsClock?.();
  }

  function stateStatus(status, message) {
    document.documentElement.dataset.wrState = status;
    if (!message) return;
    const output = document.createElement("output");
    output.textContent = message;
    output.setAttribute("role", "status");
    output.style.cssText = "position:fixed;bottom:1rem;right:1rem;max-width:calc(100% - 2rem);z-index:2147483647;background:#222;color:white;padding:0.65rem 1rem;font:14px system-ui";
    document.body.append(output);
  }

  async function waitFor(check, timeout = 2500) {
    const deadline = nativeNow() + timeout;
    do {
      const result = check();
      if (result) return result;
      await sleep(50);
    } while (nativeNow() < deadline);
    throw new Error("The expected element or state did not appear.");
  }

  async function restoreState() {
    stateStatus("loading");
    try {
      const response = await fetch("/__web-replay/states/" + encodeURIComponent(stateName));
      if (!response.ok) throw new Error("This state is unavailable in the recording.");
      const saved = await response.json();
      // Responsive pages can start from a different scroll position. Each scroll step uses a selector.
      if (Math.abs(innerWidth - saved.viewport.width) <= 24) {
        window.scrollTo({ top: saved.startScroll, behavior: "instant" });
      }
      for (const step of saved.steps) {
        if (step.type !== "wait") {
          const node = await waitFor(() => {
            const target = document.querySelector(step.selector);
            if (!target || !target.getClientRects().length) return null;
            if (step.type !== "click") return target;
            const rect = target.getBoundingClientRect();
            const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
            const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
            return left < right && top < bottom && target.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))
              ? target : null;
          });
          if (step.type === "scroll") node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          if (step.type === "focus") node.focus({ preventScroll: true });
          if (step.type === "click") {
            const button = node.closest("button,input");
            if (node.closest("a[href],area[href],label") || (button?.form && ["submit", "image", "reset"].includes(button.type))) {
              throw new Error("The checkpoint contains a navigation or form action.");
            }
            node.click();
          }
        }
        await sleep(step.durationMs);
      }
      const expected = saved.expect;
      await waitFor(() => {
        const node = document.querySelector(expected.selector);
        return node && node.getAttribute(expected.attribute) === expected.value;
      });
      stateStatus("ready");
    } catch (error) {
      stateStatus("unavailable", "Web Replay: " + error.message);
    }
  }

  async function initialize() {
    if (stateName) await restoreState();
    else if (section) {
      try {
        const node = document.getElementById(section) ?? document.querySelector(section);
        node?.scrollIntoView({ block: "start", behavior: "instant" });
      } catch {
        // An invalid selector does not affect the page.
      }
    }
    controlMotion();
  }

  if (!stateName && !section && query.get("js") !== "1") controlMotion();
  else if (document.readyState === "complete") void initialize();
  else addEventListener("load", initialize, { once: true });
})();
