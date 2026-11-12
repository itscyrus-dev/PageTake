import { setTimeout as delay } from "node:timers/promises";

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Page script failed");
  return result.result.value;
}

const pageStatus = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return rect.width && rect.height && css.visibility !== "hidden" && css.display !== "none";
  };
  let dismissed = false;
  const guidePage = location.pathname.includes("/winning-ads");
  if (guidePage) {
    const guide = [...document.querySelectorAll('[data-slot="card"] p')].find((element) =>
      visible(element) && element.textContent.trim() === "\u4e0a\u4f20\u6587\u4ef6\uff0c\u521b\u5efa\u7206\u6b3e\u5e7f\u544a\u3002"
    );
    const buttons = [...(guide?.closest('[data-slot="card"]')?.querySelectorAll("button") ?? [])];
    const close = buttons.find((button) => /\u5173\u95ed|close|dismiss/i.test(button.getAttribute("aria-label") ?? "")) ??
      buttons.find((button) => button.textContent.trim() === "\u786e\u8ba4");
    if (close && visible(close)) {
      close.click();
      dismissed = true;
    }
  }
  return {
    ready: location.protocol !== "about:" && document.readyState !== "loading",
    guidePage,
    locked: [document.documentElement, document.body].some((element) =>
      element && ["hidden", "clip"].includes(getComputedStyle(element).overflowY)
    ),
    dismissed,
  };
})()`;

/** Dismiss the known VidMuse onboarding dialog during automatic scrolling. */
async function prepare(page, headless) {
  let stableSince = 0;
  let notified = false;
  let ready = false;
  const expires = Date.now() + (headless ? 14000 : 18000);
  while (Date.now() < expires) {
    const status = await evaluate(page, pageStatus).catch(() => null);
    ready ||= !!status?.ready;
    if (status?.dismissed) console.log("Dismissed VidMuse onboarding.");
    if (status?.ready && !status.locked && !status.dismissed) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince > (status.guidePage ? 5500 : 1000)) return status.guidePage;
    } else {
      stableSince = 0;
      if (status?.locked && !status.dismissed && !headless && !notified) {
        console.log("Close the dialog or overlay to unlock scrolling.");
        notified = true;
      }
    }
    await delay(180);
  }
  if (!ready) throw new Error("The page did not load before automatic scrolling");
  throw new Error("Scrolling is locked. Dismiss the dialog and retry or use --scroll manual.");
}

/** Parse full-page, manual, pixel-range, and selector scrolling. */
export function parseScroll(value = "manual") {
  if (value === "manual" || value === "full") return { mode: value };
  const match = /^(\d+):(\d+)$/.exec(value);
  if (match) {
    const [start, end] = match.slice(1).map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      throw new Error("Use an ascending pixel range such as 800:2400");
    }
    return { mode: "range", start, end };
  }
  if (!value.trim()) throw new Error("Scroll selector cannot be empty");
  return { mode: "selector", selector: value };
}

async function getBounds(page, scroll) {
  const bounds = await evaluate(page, `(() => {
    const maximum = Math.max(0, document.scrollingElement.scrollHeight - innerHeight);
    const config = ${JSON.stringify(scroll)};
    if (config.mode === "full") return [0, maximum];
    if (config.mode === "range") return [Math.min(config.start, maximum), Math.min(config.end, maximum)];
    const element = document.querySelector(config.selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const start = Math.max(0, Math.min(maximum, scrollY + rect.top));
    return [start, Math.max(start, Math.min(maximum, scrollY + rect.bottom - innerHeight))];
  })()`);
  if (!bounds) throw new Error(`Scroll target not found: ${scroll.selector}`);
  return bounds;
}

async function scrollTo(page, position) {
  await evaluate(page, `window.scrollTo({ top: ${position}, behavior: "instant" }); 0`);
}

async function scrollBetween(page, start, target, stopAt) {
  const from = Date.now();
  const duration = Math.max(0, stopAt - from);
  for (;;) {
    const fraction = duration === 0 ? 1 : Math.min(1, (Date.now() - from) / duration);
    await scrollTo(page, Math.round(start + (target - start) * fraction));
    if (fraction === 1) return;
    await delay(Math.min(140, Math.max(1, stopAt - Date.now())));
  }
}

/** Create an automatic scroller and reuse measured positions for comparisons. */
export async function createScroller(page, { scroll, match, headless, samples }) {
  const config = parseScroll(scroll);
  if (config.mode === "manual" && !match) return null;
  if (samples < 2) throw new Error("Automatic scrolling requires at least two samples");
  const guidePage = await prepare(page, headless);
  const [first] = match ? [match[0]] : await getBounds(page, config);
  await scrollTo(page, first);
  let current = first;
  return {
    async step(index, deadline) {
      const bounds = match ? null : await getBounds(page, config);
      const target = match ? match[index - 1] :
        Math.round(bounds[0] + (bounds[1] - bounds[0]) * (index - 1) / (samples - 1));
      const settle = Math.min(550, Math.max(0, (deadline - Date.now()) / 4));
      await scrollBetween(page, current, target, deadline - settle);
      current = target;
      await delay(Math.max(0, deadline - Date.now()));
      if (guidePage && (await evaluate(page, pageStatus)).dismissed) {
        console.log("Dismissed VidMuse onboarding.");
        await delay(250);
        await scrollTo(page, target);
      }
    },
  };
}
