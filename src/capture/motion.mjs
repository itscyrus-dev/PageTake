import { publicUrl } from "./archive.mjs";
import { installClipCapture } from "./clips.mjs";

const worldName = "web-replay-motion";
const collector = "__webReplayMotion";

function install(config) {
  if (window !== top) return;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animations = new Map(), components = new Map(), watched = new Map(), media = new Map();
  const ids = new WeakMap(), paths = new WeakMap();
  const events = [], scrollTrace = [], dropped = {};
  let scroll = null;
  let declarations;
  let declarationsAt = -Infinity;
  let sequence = 0;
  const componentSelector = [
    "details", "dialog", "[role=dialog]", "[role=tab]", "[role=tabpanel]", "[role=option]", "[role=progressbar]",
    "[aria-expanded]", "[aria-selected]", "[aria-pressed]", "[aria-current]", "[aria-roledescription=carousel]",
    "[aria-roledescription=slide]",
  ].join(",");
  const geometrySelector = "svg circle, svg ellipse, svg path, svg line, svg polyline, svg polygon";
  const stateAttributes = ["open", "hidden", "inert", "aria-hidden", "aria-expanded", "aria-selected", "aria-pressed",
    "aria-current", "aria-valuenow", "aria-controls", "aria-modal", "data-state", "role"];
  const styleProperties = [
    "position", "top", "z-index", "display", "visibility", "overflow", "align-items", "justify-content",
    "grid-template-columns", "gap", "margin", "padding", "font-family", "font-size", "font-weight",
    "line-height", "letter-spacing", "color", "background-color", "border-radius", "box-shadow", "backdrop-filter",
    "opacity", "transform", "translate", "rotate", "scale", "clip-path", "stroke-dasharray", "stroke-dashoffset",
    "stroke-width", "stroke-linecap", "transition-property", "transition-duration", "transition-timing-function",
  ];
  const now = () => Math.round(performance.now());
  const shorten = (value, length = 180) => value?.trim().slice(0, length);
  const scalar = (value) => typeof value === "number" && !Number.isFinite(value) ? String(value)
    : (value instanceof CSSNumericValue ? value.toString() : value);
  const box = (element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return [x, y, width, height].map((value) => Math.round(value * 10) / 10);
  };
  const properties = (css, names) => Object.fromEntries(names.map((name) => [name, shorten(css.getPropertyValue(name), 300)]));
  const attrs = (element, names) => Object.fromEntries(names.filter((name) => element.hasAttribute(name))
    .map((name) => [name, shorten(element.getAttribute(name), 1200)]));
  const inView = ([x, y, w, h]) => w > 0 && h > 0 && y + h > 0 && y < innerHeight && x + w > 0 && x < innerWidth;
  const identity = (element) => {
    if (!ids.has(element)) ids.set(element, "target-" + ++sequence);
    return ids.get(element);
  };

  function target(element) {
    let selector = paths.get(element);
    if (selector && document.querySelector(selector) !== element) selector = null;
    if (!selector && element.getRootNode() === document) {
      const segments = [];
      for (let node = element; node; node = node.parentElement) {
        const id = node.id && "#" + CSS.escape(node.id);
        if (id && document.querySelectorAll(id).length === 1) {
          segments.unshift(id);
          break;
        }
        let index = 1;
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          if (sibling.localName === node.localName) index++;
        }
        segments.unshift(CSS.escape(node.localName) + ":nth-of-type(" + index + ")");
      }
      selector = segments.join(" > ");
      paths.set(element, selector);
    }
    const section = element.closest("section,article,header,footer");
    return {
      id: identity(element), selector: selector ?? null, tag: element.localName,
      section: shorten(section?.querySelector("h1,h2,h3")?.textContent),
      label: shorten(element.getAttribute("aria-label") ?? (element.matches("button,summary,[role=tab]") ? element.textContent : "")),
    };
  }

  function put(map, key, value, limit, category) {
    if (map.size >= limit) {
      dropped[category] = true;
      return false;
    }
    map.set(key, value);
    return true;
  }

  function append(list, entry, limit, category) {
    if (list.length === limit) {
      list[list.length - 1] = entry;
      dropped[category] = true;
    } else list.push(entry);
  }

  function appendSample(list, entry, category) {
    if (list.length === 61) {
      for (let index = 39; index > 0; index -= 2) list.splice(index, 1);
      dropped[category] = true;
    }
    list.push(entry);
  }

  function animationSample(animation, t) {
    const effect = animation.effect;
    const element = effect?.target;
    if (!(element instanceof Element) || typeof effect.getKeyframes !== "function") return;
    let item = animations.get(animation);
    if (!item) {
      if (animations.size >= 400) {
        dropped.animations = true;
        return;
      }
      const frames = effect.getKeyframes();
      const type = animation instanceof CSSAnimation ? "css-keyframes"
        : animation instanceof CSSTransition ? "css-transition" : "web-animations";
      if (type === "css-keyframes" && t - declarationsAt > 250) {
        declarations = cssRules();
        declarationsAt = t;
      }
      const declaredKeyframes = type === "css-keyframes"
        ? declarations.keyframes.filter(({ name }) => name === animation.animationName) : undefined;
      const cssNames = [...new Set(frames.flatMap(Object.keys))]
        .filter((key) => !["offset", "computedOffset", "easing", "composite"].includes(key))
        .map((key) => key.startsWith("--") ? key : key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()));
      for (const { frames } of declaredKeyframes ?? []) {
        for (const frame of frames) {
          for (const name of Object.keys(frame.customProperties)) {
            if (!cssNames.includes(name)) cssNames.push(name);
          }
        }
      }
      const timing = Object.fromEntries(Object.entries(effect.getTiming()).map(([key, value]) => [key, scalar(value)]));
      const precedingEvent = events.at(-1);
      item = {
        id: "motion-" + (animations.size + 1), target: target(element), type,
        name: animation.animationName ?? animation.transitionProperty ?? animation.id,
        pseudoElement: effect.pseudoElement, timelineType: animation.timeline?.constructor.name ?? null,
        timeline: timing, firstObservedMs: t,
        precedingEvent: precedingEvent && t - precedingEvent.t <= 1000 ? precedingEvent.id : null,
        properties: cssNames, keyframes: frames.slice(0, 100), declaredKeyframes, samples: [],
      };
      if (frames.length > 100) dropped.keyframes = true;
      animations.set(animation, item);
    }
    item.lastObservedMs = t;
    const { progress, currentIteration } = effect.getComputedTiming();
    const computed = getComputedStyle(element, effect.pseudoElement);
    appendSample(item.samples, { t, currentTime: scalar(animation.currentTime), progress, currentIteration,
      state: animation.playState, scrollY, values: properties(computed, item.properties) }, "animationSamples");
  }

  function componentSample(element, t) {
    const id = identity(element);
    let item = components.get(id);
    const rect = box(element);
    if (!item && !inView(rect)) return;
    if (!item) {
      item = { target: target(element), states: [], transitions: [] };
      if (!put(components, id, item, 240, "components")) return;
    }
    const css = getComputedStyle(element);
    const state = {
      connected: element.isConnected, attributes: attrs(element, stateAttributes),
      shown: element.isConnected && !!rect[2] && !!rect[3] && css.visibility !== "hidden",
      modal: element.matches(":modal"),
    };
    let index = item.states.findIndex((existing) => JSON.stringify(existing) === JSON.stringify(state));
    if (index < 0) {
      if (item.states.length === 40) {
        dropped.states = true;
        return;
      }
      index = item.states.push(state) - 1;
    }
    if (item.current === index) return;
    append(item.transitions, { t, scrollY, from: item.current ?? null, to: index, precedingEvent: events.at(-1)?.id ?? null },
      80, "transitions");
    item.current = index;
  }

  function watch(element, t) {
    const rect = box(element);
    const id = identity(element);
    const css = getComputedStyle(element);
    const explicit = config.watch && element.matches(config.watch);
    if (!inView(rect) && !watched.has(id) && !explicit) return;
    let item = watched.get(id);
    const isGeometry = element.matches(geometrySelector);
    if (!item) {
      item = { target: target(element), samples: [] };
      if (isGeometry) {
        let length = null;
        try { length = element.getTotalLength(); } catch { /* Hidden or invalid paths can lack a length. */ }
        item.geometry = {
          viewBox: element.ownerSVGElement?.getAttribute("viewBox") ?? null,
          attributes: attrs(element, ["d", "points", "r", "rx", "ry", "cx", "cy", "x1", "y1", "x2", "y2",
            "transform", "pathLength", "stroke-width", "stroke-linecap", "stroke-dasharray", "stroke-dashoffset"]),
          length,
        };
      }
      if (!put(watched, id, item, 160, "styles")) return;
    }
    const value = element.matches("input,textarea,[contenteditable]") ? null : shorten(element.textContent, 80);
    const data = {
      visible: inView(rect), box: rect, css: properties(css, styleProperties),
      number: value && /^[+\-−]?[\d.,]+\s*%?$/.test(value) ? value : null,
    };
    if (isGeometry) data.geometryAttributes = attrs(element, ["d", "r", "cx", "cy", "transform", "stroke-dashoffset"]);
    const key = JSON.stringify(data);
    if (item.lastKey === key) return;
    item.lastKey = key;
    appendSample(item.samples, { t, scrollY, ...data }, "styleSamples");
  }

  function mediaSample(element) {
    const id = identity(element);
    let poster = null;
    try { if (element.poster) poster = new URL(element.poster, document.baseURI).href; }
    catch { /* Skip an invalid poster URL. */ }
    const entry = {
      target: media.get(id)?.target ?? target(element), kind: element.localName,
      source: element.currentSrc, poster, autoplay: element.autoplay,
      muted: element.muted, defaultMuted: element.defaultMuted, loop: element.loop,
      controls: element.controls, preload: element.preload, playsInline: element.playsInline,
      paused: element.paused, currentTime: element.currentTime, duration: scalar(element.duration),
      width: element.videoWidth, height: element.videoHeight, errorCode: element.error?.code ?? null,
    };
    if (media.has(id)) media.set(id, entry);
    else put(media, id, entry, 80, "media");
  }

  function event(type, element, extra) {
    if (!(element instanceof Element)) return;
    append(events, { id: (events.at(-1)?.id ?? 0) + 1, t: now(), scrollY, type, target: target(element), ...extra },
      500, "events");
  }

  for (const type of ["click", "focusin", "pointerover", "pointerout", "toggle", "play", "pause", "loadedmetadata", "error",
    "animationstart", "animationend", "animationcancel", "transitionrun", "transitionend", "transitioncancel"]) {
    document.addEventListener(type, (e) => {
      const node = e.target;
      if (!(node instanceof Element)) return;
      if ((type === "pointerover" || type === "pointerout") && e.relatedTarget instanceof Node && node.contains(e.relatedTarget)) return;
      if (type === "error" && !(node instanceof HTMLMediaElement)) return;
      event(type, node, { trusted: e.isTrusted, name: e.animationName ?? e.propertyName, elapsedTime: e.elapsedTime,
        pseudoElement: e.pseudoElement });
      if (node instanceof HTMLMediaElement) mediaSample(node);
      if (type === "animationstart" || type === "transitionrun") {
        for (const animation of node.getAnimations()) animationSample(animation, now());
      }
    }, true);
  }
  addEventListener("scroll", () => {
    scroll = { t: now(), x: scrollX, y: scrollY };
  }, { passive: true });

  // Track attribute changes even when a known component stops matching the selector.
  const touched = new Set();
  const knownComponents = new Map();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const node = record.target;
      if (node instanceof Element && (node.matches(componentSelector) || knownComponents.has(ids.get(node)))) {
        if (touched.size < 240) touched.add(node);
        else dropped.componentMutations = true;
      }
    }
  });
  observer.observe(document, { subtree: true, attributes: true, attributeFilter: stateAttributes });

  function poll(deep = false) {
    const t = now();
    if (scroll && scroll.t !== scrollTrace.at(-1)?.t) append(scrollTrace, scroll, 1200, "scrollTrace");
    for (const animation of document.getAnimations()) animationSample(animation, t);
    for (const node of touched) componentSample(node, t);
    touched.clear();
    for (const [id, element] of knownComponents) {
      if (!element.isConnected) {
        componentSample(element, t);
        knownComponents.delete(id);
      }
    }
    const candidates = document.querySelectorAll([componentSelector, config.watch].filter(Boolean).join(","));
    if (candidates.length > 320) dropped.componentScan = true;
    for (const element of [...candidates].slice(0, 320)) {
      componentSample(element, t);
      const id = ids.get(element);
      if (components.has(id)) knownComponents.set(id, element);
    }
    const scope = [config.watch, "progress,meter,[role=progressbar]", geometrySelector].filter(Boolean).join(",");
    const nodes = document.querySelectorAll(scope);
    if (nodes.length > 320) dropped.styleScan = true;
    for (const node of [...nodes].slice(0, 320)) watch(node, t);
    if (deep) {
      const elements = document.querySelectorAll("audio,video");
      if (elements.length > 80) dropped.media = true;
      for (const node of [...elements].slice(0, 80)) mediaSample(node);
    }
  }

  function cssRules() {
    const result = { keyframes: [], properties: [], transitions: [], reducedMotionRules: [], inaccessibleSheets: 0 };
    const active = new Set();
    function read(sheet, context = []) {
      if (active.has(sheet)) return;
      active.add(sheet);
      let rules;
      try { rules = sheet.cssRules; }
      catch { result.inaccessibleSheets++; }
      if (rules) visit(rules, context);
      active.delete(sheet);
    }
    function add(kind, value) {
      if (result[kind].length < 500) result[kind].push(value);
      else dropped["css-" + kind] = true;
    }
    function visit(rules, context) {
      for (const rule of rules) {
        if (rule instanceof CSSImportRule && rule.styleSheet) read(rule.styleSheet, [...context, rule.media.mediaText].filter(Boolean));
        else if (rule instanceof CSSKeyframesRule) {
          if (rule.cssRules.length > 100) dropped.keyframes = true;
          add("keyframes", { name: rule.name, context, frames: [...rule.cssRules].slice(0, 100).map((frame) => ({
            offset: frame.keyText, css: shorten(frame.style.cssText, 2000),
            customProperties: properties(frame.style, [...frame.style].filter((name) => name.startsWith("--"))),
          })) });
        } else if (rule.constructor.name === "CSSPropertyRule") add("properties", { context, css: shorten(rule.cssText, 2000) });
        else {
          if (rule.selectorText && rule.style) {
            const declarations = [...rule.style].filter((name) => /^(?:animation|transition)(?:-|$)/.test(name));
            if (declarations.length) add("transitions", { selector: rule.selectorText, context, css: properties(rule.style, declarations) });
            if (context.some((value) => value.includes("prefers-reduced-motion"))) {
              add("reducedMotionRules", { selector: rule.selectorText, context, css: shorten(rule.style.cssText, 2000) });
            }
          }
          if (rule.cssRules) visit(rule.cssRules, [...context, rule.conditionText ?? rule.name].filter(Boolean));
        }
      }
    }
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) read(sheet, [sheet.media.mediaText].filter(Boolean));
    return result;
  }

  try {
    if (config.watch) document.querySelector(config.watch);
  } catch {
    config.watch = "";
    dropped.invalidWatchSelector = true;
  }
  const interval = setInterval(poll, 100);
  globalThis[config.collector] = {
    snapshot() {
      poll(true);
      return { t: now(), scroll, scrollY, dpr: devicePixelRatio, observedAnimations: animations.size };
    },
    finish() {
      clearInterval(interval);
      observer.disconnect();
      poll(true);
      return {
        clock: "performance.now() since navigation", intervalMs: 100, reducedMotion, watchSelector: config.watch,
        css: cssRules(), animations: [...animations.values()], components: [...components.values()], events, scrollTrace,
        styles: [...watched.values()].map(({ lastKey, ...item }) => item),
        media: [...media.values()], dropped,
        surfaces: {
          canvases: document.querySelectorAll("canvas").length,
          iframes: document.querySelectorAll("iframe").length,
          smil: document.querySelectorAll("svg animate,svg animateTransform,svg animateMotion,svg set").length,
        },
      };
    },
  };
}

export async function startMotionCapture(page, values) {
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    worldName, source: `(${install})(${JSON.stringify({ collector, watch: values.watch })});
      if (globalThis.${collector}) Object.assign(globalThis.${collector}, (${installClipCapture})());`,
  });
  const reducedMotion = values["reduced-motion"];
  if (reducedMotion !== undefined) {
    const value = reducedMotion ? "reduce" : "no-preference";
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
  }
  let contextId;
  async function evaluate(method, args = []) {
    if (!contextId) {
      const { frameTree } = await page.send("Page.getFrameTree");
      ({ executionContextId: contextId } = await page.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName }));
    }
    const result = await page.send("Runtime.evaluate", {
      contextId, expression: `globalThis.${collector}?.${method}(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Could not read motion evidence");
    return result.result.value;
  }
  return {
    snapshot: () => evaluate("snapshot"),
    startClip: (selector) => evaluate("start", [selector]),
    stopClip: () => evaluate("stop"),
    async finish() {
      const result = await evaluate("finish");
      if (!result) return { error: "The page returned no motion evidence" };
      for (const entry of result.media) {
        for (const key of ["source", "poster"]) {
          try { entry[key] = entry[key] ? publicUrl(entry[key]) : null; }
          catch { entry[key] = null; }
        }
      }
      return result;
    },
  };
}
