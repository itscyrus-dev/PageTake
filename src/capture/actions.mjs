import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const validSelector = (value) => typeof value === "string" && !!value.trim() && value.length <= 500;
export const stateName = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * @typedef {{selector: string, attribute: string, value: string | null}} StateExpectation
 * @typedef {{type: "click" | "hover" | "focus" | "scroll" | "wait", selector: string | null, durationMs: number}} ActionStep
 * @typedef {ActionStep & {canvas?: string, state?: string, expect?: StateExpectation}} CaptureAction
 */

/** @returns {Promise<CaptureAction[]>} */
export async function readActions(file) {
  if (!file) return [];
  const actions = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(actions) || actions.length > 12) throw new Error("--actions expects a JSON array with up to 12 entries");
  const states = new Set();
  return actions.map((action, index) => {
    const { type, selector, durationMs = 1000, canvas, state, expect } = action ?? {};
    if (!["click", "hover", "focus", "scroll", "wait"].includes(type) ||
        (type !== "wait" && !validSelector(selector)) ||
        !Number.isInteger(durationMs) || durationMs < 400 || durationMs > 10000 ||
        (canvas !== undefined && !validSelector(canvas)) ||
        (state !== undefined && (typeof state !== "string" || !stateName.test(state) || states.has(state) ||
          !validSelector(expect?.selector) || typeof expect.attribute !== "string" ||
          !/^(?:aria-[a-z-]+|data-[a-z0-9-]+|open|hidden|class)$/.test(expect.attribute) ||
          !(expect.value === null || (typeof expect.value === "string" && expect.value.length <= 500)))) ||
        (expect !== undefined && state === undefined)) {
      throw new Error(`Action ${index + 1} has invalid fields or a duplicate state name`);
    }
    if (state) states.add(state);
    return { type, selector: type === "wait" ? null : selector, durationMs, canvas, state,
      expect: expect && { selector: expect.selector, attribute: expect.attribute, value: expect.value } };
  });
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error("Action selector or page script failed");
  return result.result.value;
}

async function locate(page, selector, scroll) {
  const point = await evaluate(page, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    if (${scroll}) node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const rect = node.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    if (left >= right || top >= bottom) return { visible: false };
    const x = (left + right) / 2, y = (top + bottom) / 2;
    return { x, y, visible: node.contains(document.elementFromPoint(x, y)) };
  })()`);
  if (!point) throw new Error(`Action target not found: ${selector}`);
  return point;
}

async function trigger(page, action) {
  if (action.type === "wait") return;
  if (action.type === "scroll") {
    await locate(page, action.selector, true);
    return;
  }
  if (action.type === "focus") {
    const focused = await evaluate(page, `(() => {
      const node = document.querySelector(${JSON.stringify(action.selector)});
      node?.focus({ preventScroll: true });
      return !!node && node === document.activeElement;
    })()`);
    if (!focused) throw new Error(`Could not focus ${action.selector}`);
    return;
  }
  const { x, y, visible } = await locate(page, action.selector, false);
  if (!visible) throw new Error(`Action target is outside the viewport or covered: ${action.selector}`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  if (action.type === "click") {
    const mouse = { x, y, button: "left", clickCount: 1 };
    await page.send("Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" });
    await page.send("Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" });
  }
}

export async function captureActions(page, actions, sample, startClip) {
  const groups = [];
  for (const action of actions) {
    const frames = [];
    const group = { ...action, frames };
    groups.push(group);
    const take = async (phase, elapsedMs) => {
      const frame = await sample(`action-${groups.length}-${phase}.png`, elapsedMs);
      frames.push({ ...frame, phase });
    };
    let stopClip;
    try {
      await take("before", 0);
      if (action.canvas) stopClip = await startClip(action.canvas, `action-${groups.length}`);
      const started = performance.now();
      await trigger(page, action);
      for (const percent of [0, 25, 50, 75, 100]) {
        await delay(Math.max(0, started + action.durationMs * percent / 100 - performance.now()));
        await take(percent, Math.round(performance.now() - started));
      }
      if (action.expect) {
        group.verified = await evaluate(page, `((expected) => {
          const node = document.querySelector(expected.selector);
          return !!node && node.getAttribute(expected.attribute) === expected.value;
        })(${JSON.stringify(action.expect)})`);
      }
    } catch (error) {
      group.error = error.message;
    } finally {
      if (stopClip) group.clip = await stopClip();
    }
  }
  return groups;
}
