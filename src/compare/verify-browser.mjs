import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { launchChrome } from "../capture/chrome.mjs";
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

async function captureFrame(page, screenshot, selector, expected, output, file, started, atMs) {
  await delay(Math.max(0, started + atMs - performance.now()));
  const observation = await evaluate(page, ({ selector, expected }) => {
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
    return {
      box: { x, y, width, height }, scroll: { x: scrollX, y: scrollY },
      animations: node.getAnimations({ subtree: true }).slice(0, 24).map((animation) => {
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
  }, { selector, expected });
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
          result.frames.push(await captureFrame(page, screenshot, selector, expected, output, file, started, atMs));
        } catch (error) {
          result.frames.push({ atMs, error: error.message });
        }
      }
    }
  }
  return sections;
}
