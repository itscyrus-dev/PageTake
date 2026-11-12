import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { launchChrome } from "../capture/chrome.mjs";
import { publicUrl } from "../capture/archive.mjs";
import { cropViewport } from "./region-image.mjs";

async function evaluate(page, fn, input) {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
    expression: `(${fn})(${JSON.stringify(input)})`, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? "Page evaluation failed");
  return result.value;
}

async function prepareSection(page, url, selector, timeoutMs) {
  const navigation = await page.send("Page.navigate", { url });
  if (navigation.errorText) throw new Error(navigation.errorText);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const found = await evaluate(page, (selector) => {
      if (document.readyState === "loading") return false;
      const matches = document.querySelectorAll(selector);
      if (matches.length > 1) throw new Error("Section selector matches more than one element");
      const node = matches[0];
      if (!node || !node.getBoundingClientRect().width) return false;
      node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      return true;
    }, selector).catch((error) => {
      if (!/execution context|navigat/i.test(error.message)) throw error;
      return false;
    });
    if (found) return;
    await delay(100);
  }
  const title = await evaluate(page, () => document.title.slice(0, 120)).catch(() => "");
  throw new Error(`Section did not appear: ${selector}${title ? ` (page title: ${title})` : ""}`);
}

async function moveOutside(page, selector, action) {
  const point = await evaluate(page, ({ selector, action }) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error("Section disappeared");
    if (action === "idle" && node.contains(document.activeElement)) document.activeElement.blur();
    const points = [[0, 0], [innerWidth - 1, 0], [0, innerHeight - 1], [innerWidth - 1, innerHeight - 1]];
    const outside = points.find(([x, y]) => !node.contains(document.elementFromPoint(x, y)));
    return outside ? { x: outside[0], y: outside[1] } : { x: -1, y: -1 };
  }, { selector, action });
  const started = performance.now();
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  if (await evaluate(page, (selector) => document.querySelector(selector)?.matches(":hover"), selector)) {
    throw new Error("Pointer did not leave the section");
  }
  return started;
}

async function trigger(page, action, selector, target) {
  if (action === "wait") return performance.now();
  if (action === "idle" || action === "leave") return moveOutside(page, selector, action);
  const beforeTarget = performance.now();
  const point = await evaluate(page, ({ action, selector, target }) => {
    const matches = document.querySelectorAll(target);
    if (matches.length !== 1) throw new Error(`Action target must match one element: ${target}`);
    const node = matches[0];
    if (!document.querySelector(selector)?.contains(node)) throw new Error("Action target is outside the section");
    if (action === "focus") {
      node.focus({ preventScroll: true });
      if (node !== document.activeElement) throw new Error("Action target could not be focused");
      return null;
    }
    if (action === "click" && node.matches(":disabled,[aria-disabled=true]")) throw new Error("Action target is disabled");
    const rect = node.getBoundingClientRect();
    const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
    const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
    if (!node.contains(document.elementFromPoint(x, y))) throw new Error("Action target does not receive pointer events at its center");
    return { x, y };
  }, { action, selector, target });
  if (!point) return beforeTarget;
  let started = performance.now();
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  if (action === "hover") {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await evaluate(page, (target) => document.querySelector(target)?.matches(":hover"), target)) return started;
      await delay(20);
    }
    throw new Error("Pointer did not hover the action target");
  }
  if (action === "click") {
    const mouse = { ...point, button: "left", clickCount: 1 };
    started = performance.now();
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
  }
  return started;
}

async function verificationScreenshot(page, viewport, headless) {
  if (headless) {
    return async () => {
      const { data } = await page.send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false, optimizeForSpeed: true,
      });
      return Buffer.from(data, "base64");
    };
  }

  // A screenshot can resync the native cursor and end CDP-driven hover in a visible window.
  let latest;
  page.on("Page.screencastFrame", (frame) => {
    latest = frame;
    void page.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await page.send("Page.startScreencast", {
    format: "png", maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 2,
  });
  return async ({ x, y }) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const metadata = latest?.metadata;
      if (metadata && Math.abs(metadata.scrollOffsetX - x) < 1 && Math.abs(metadata.scrollOffsetY - y) < 1) {
        return Buffer.from(latest.data, "base64");
      }
      await delay(25);
    }
    throw new Error("No browser frame matched the section scroll position");
  };
}

async function captureFrame(page, screenshot, selector, layers, expected, output, file, started, atMs) {
  await delay(Math.max(0, started + atMs - performance.now()));
  const observation = await evaluate(page, ({ selector, layers, expected }) => {
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1) throw new Error("Section must match one element at capture time");
    const node = matches[0];
    const rect = node.getBoundingClientRect();
    const x = Math.floor(rect.left), y = Math.floor(rect.top);
    const width = Math.ceil(rect.right) - x, height = Math.ceil(rect.bottom) - y;
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > innerWidth || y + height > innerHeight) {
      throw new Error("Section must fit inside the viewport");
    }
    function visible(element) {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || box.bottom <= rect.top || box.top >= rect.bottom ||
          box.right <= rect.left || box.left >= rect.right || getComputedStyle(element).visibility !== "visible") return false;
      let opacity = 1;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none") return false;
        opacity *= Number(style.opacity);
      }
      return opacity > 0.05;
    }
    const assets = new Map();
    const nodes = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    function addAsset(kind, url) {
      if (!url || url.length > 2000 || assets.size >= 32 || !URL.canParse(url, document.baseURI)) return;
      const address = new URL(url, document.baseURI);
      if (!["http:", "https:"].includes(address.protocol)) return;
      assets.set(kind + address.href, { kind, url: address.href });
    }
    for (let i = 0, element = node; element && i < 160 && assets.size < 32; i++, element = nodes.nextNode()) {
      if (element instanceof HTMLImageElement) addAsset("image", element.currentSrc || element.getAttribute("src"));
      if (element instanceof HTMLVideoElement) addAsset("poster", element.getAttribute("poster"));
      for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\("([^"]+)"\)/g)) {
        addAsset("background", match[1]);
      }
      if (element.localName === "use") {
        const source = element.getAttribute("href") ?? element.getAttribute("xlink:href");
        if (source && !source.startsWith("#")) addAsset("svg", source);
      }
    }
    const animations = new Set(node.getAnimations({ subtree: true }));
    const visualProperties = ["backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition",
      "opacity", "filter", "backdropFilter", "maskImage", "clipPath", "mixBlendMode", "transform", "zIndex"];
    const visualLayers = [{ id: "section", selector }, ...layers].map(({ id, selector, pseudo }) => {
      let matches;
      try {
        matches = document.querySelectorAll(selector);
      } catch {
        return { id, selector, pseudo, error: "Invalid layer selector" };
      }
      if (matches.length !== 1) return { id, selector, pseudo, error: `Layer matched ${matches.length} elements` };
      const layer = matches[0];
      const css = getComputedStyle(layer, pseudo);
      for (const match of css.backgroundImage.matchAll(/url\("([^"]+)"\)/g)) addAsset("background", match[1]);
      if (id !== "section") for (const animation of layer.getAnimations()) animations.add(animation);
      const canvases = layer instanceof HTMLCanvasElement ? [layer] : [...layer.querySelectorAll("canvas")].slice(0, 4);
      return { id, selector, pseudo, styles: Object.fromEntries(visualProperties.map((key) => [key, css[key]])),
        canvases: canvases.map((canvas) => ({ width: canvas.width, height: canvas.height })) };
    });
    if (visualLayers.some((layer) => layer.canvases?.length)) {
      const resources = performance.getEntriesByType("resource").filter(({ name }) => /\.(?:json|wasm)(?:[?#]|$)/i.test(name));
      for (const resource of resources.slice(0, 8)) addAsset("page resource", resource.name);
    }
    const videoNodes = node instanceof HTMLVideoElement ? [node] : [...node.querySelectorAll("video")].slice(0, 6);
    const videos = videoNodes.map((video) => {
      addAsset("video", video.currentSrc);
      return { url: video.currentSrc || undefined, currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
        paused: video.paused, readyState: video.readyState };
    });
    return {
      box: { x, y, width, height }, scroll: { x: scrollX, y: scrollY },
      visualLayers, videos,
      assets: [...assets.values()],
      inlineSvg: [...node.querySelectorAll("svg")].slice(0, 8).map((svg) => svg.outerHTML)
        .filter((markup) => markup.length <= 8000),
      animations: [...animations].slice(0, 24).map((animation) => {
        const effect = animation.effect;
        const timing = effect?.getTiming();
        return {
          name: animation.animationName ?? animation.transitionProperty ?? null,
          target: effect?.target?.tagName ?? null,
          currentTimeMs: typeof animation.currentTime === "number" ? animation.currentTime : null,
          playState: animation.playState, durationMs: timing?.duration, delayMs: timing?.delay,
          easing: timing?.easing, keyframes: effect?.getKeyframes?.().slice(0, 24),
        };
      }),
      assertions: expected.map(({ label, selector, visibleCount }) => {
        const actual = [...node.querySelectorAll(selector)].filter(visible).length;
        return { label, expected: visibleCount, actual, passed: actual === visibleCount };
      }),
    };
  }, { selector, layers, expected });
  observation.assets = observation.assets.flatMap(({ kind, url }) => {
    const safe = publicUrl(url);
    return safe ? [{ kind, url: safe }] : [];
  });
  for (const video of observation.videos) {
    if (video.url) video.url = publicUrl(video.url) ?? undefined;
  }
  const elapsedMs = Math.round(performance.now() - started);
  const bytes = await screenshot(observation.scroll);
  await writeFile(join(output, file), cropViewport(bytes, observation.box));
  return { atMs, elapsedMs, file, ...observation };
}

export async function captureVerificationSide(plan, side, output, executable, headless = true) {
  const browser = await launchChrome({ ...plan.viewport, executable, headless });
  try {
    const { product } = await browser.page.send("Browser.getVersion");
    const environment = {
      browser: product, platform: process.platform, osRelease: release(), architecture: process.arch,
      headless, width: plan.viewport.width, height: plan.viewport.height,
      devicePixelRatio: 1, reducedMotion: plan.reducedMotion,
    };
    const capturedAt = new Date().toISOString();
    const sections = await captureVerificationPage(plan, side, output, browser.page, headless);
    return { sections, environment, capturedAt, source: { type: "live" } };
  } finally {
    await browser.close();
  }
}

async function captureVerificationPage(plan, side, output, page, headless) {
  await page.send("Page.bringToFront");
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: plan.reducedMotion ? "reduce" : "no-preference" }],
  });
  const screenshot = await verificationScreenshot(page, plan.viewport, headless);
  const sections = [];
  for (const [index, section] of plan.sections.entries()) {
    const selector = section.selectors[side];
    const layers = (section.layers ?? []).map(({ id, selectors, pseudo }) => ({ id, selector: selectors[side], pseudo }));
    const states = [];
    sections.push(states);
    let unavailable;
    try {
      await prepareSection(page, plan[side], selector, plan.readyTimeoutMs);
    } catch (error) {
      unavailable = error.message;
    }
    for (const [stateIndex, state] of section.states.entries()) {
      const result = { frames: [] };
      states.push(result);
      if (unavailable) {
        result.error = unavailable;
        continue;
      }
      let started;
      try {
        started = await trigger(page, state.action, selector, state.target?.[side] ?? selector);
      } catch (error) {
        result.error = error.message;
        unavailable = `Earlier action failed: ${state.id}`;
        continue;
      }
      const expected = (state.expect ?? []).map(({ selectors, ...entry }) => ({ ...entry, selector: selectors[side] }));
      for (const [frameIndex, atMs] of state.framesMs.entries()) {
        try {
          const file = `${side}-${index + 1}-${stateIndex + 1}-${frameIndex + 1}.png`;
          result.frames.push(await captureFrame(page, screenshot, selector, layers, expected, output, file, started, atMs));
        } catch (error) {
          result.frames.push({ atMs, error: error.message });
        }
      }
    }
  }
  return sections;
}
