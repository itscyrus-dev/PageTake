#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { defaultChrome, launchChrome } from "./src/capture/chrome.mjs";
import { publicUrl, recordNetwork, replayNetwork } from "./src/capture/archive.mjs";
import { fillMedia } from "./src/capture/fill-media.mjs";
import { compareCaptures } from "./src/compare/compare.mjs";
import { readVerifyPlan } from "./src/compare/verify-plan.mjs";
import { captureVerificationSide } from "./src/compare/verify-browser.mjs";
import { referenceFrameIssues, writeVerificationReport } from "./src/compare/verify-report.mjs";
import { loadVerificationBaseline, saveVerificationBaseline } from "./src/compare/verify-baseline.mjs";
import { loadVerificationAssets } from "./src/compare/verify-assets.mjs";
import { writeRepairChecklist } from "./src/compare/verify-repair.mjs";
import { generateProject } from "./src/generate.mjs";
import { exportProject } from "./src/export/export.mjs";
import { writeGuide } from "./src/export/guide.mjs";
import { createScroller } from "./src/capture/scroll.mjs";
import { startMotionCapture } from "./src/capture/motion.mjs";
import { captureActions, readActions } from "./src/capture/actions.mjs";
import { startJsMotion } from "./src/capture/js-motion.mjs";
import { canvasCapture } from "./src/capture/clips.mjs";

const usage = `Usage
  node pagetake.mjs record <URL> <new-dir> [--seconds 20] [--width 1440] [--height 900]
  node pagetake.mjs fill-media <recording-dir> [--media-url <URL>]
  node pagetake.mjs replay <recording-dir> [--seconds 20]
  node pagetake.mjs compare <recording-dir> <candidate-dir> [--output compare.html]
  node pagetake.mjs baseline <plan.json> <new-dir> [--no-headless] [--chrome <path>]
  node pagetake.mjs verify <plan.json> <new-dir> [--baseline <dir>] [--no-headless] [--chrome <path>]
  node pagetake.mjs repair <verify.json>
  node pagetake.mjs inspect <candidate-URL> <new-dir> [--seconds 20]
  node pagetake.mjs export <recording-dir> <new-project-dir> [--no-recover-images]
  node pagetake.mjs guide <recording-dir> <export-dir>
  node pagetake.mjs generate <recording-dir> <new-project-dir> [--base-url URL --model NAME | --prompt-only]
Options
  --headless              Run Chrome in the background
  --media-url <URL>       Also recover an observed media URL with no recorded bytes
  --no-recover-images    Export using only recorded resources
  --baseline <dir>        Use a saved reference for verification
  --scroll <range>        full, manual, 800:2400, or a CSS selector
  --samples 3             Number of page samples (maximum 12)
  --actions <file>        Capture an interaction plan after page sampling
  --watch <selector>      Sample extra targets for styles and numeric values
  --js-motion             Observe JavaScript animation-frame callbacks
  --canvas <selector>     Record a two-second Canvas clip after page sampling
  --reduced-motion        Emulate reduced motion
  --no-reduced-motion     Emulate no reduced-motion preference
  --output <path>         Replay capture directory or comparison report
  --chrome <path>         Path to the Chrome executable
  --notes <file>          Include design or motion notes in the model prompt
  --candidate <dir>       Include a previous draft in the model prompt
  --feedback <file>       Include a comparison JSON report in the model prompt
Scroll or interact during recording to capture lazy assets. Offline replay uses archived responses.`;

const options = {
  seconds: { type: "string" }, width: { type: "string" }, height: { type: "string" },
  samples: { type: "string" }, output: { type: "string" }, chrome: { type: "string" },
  headless: { type: "boolean" }, help: { type: "boolean" },
  "recover-images": { type: "boolean" },
  "base-url": { type: "string" }, model: { type: "string" }, notes: { type: "string" },
  "prompt-only": { type: "boolean" }, feedback: { type: "string" }, candidate: { type: "string" },
  scroll: { type: "string" }, match: { type: "string" },
  actions: { type: "string" }, watch: { type: "string" }, "reduced-motion": { type: "boolean" },
  baseline: { type: "string" }, "media-url": { type: "string", multiple: true }, canvas: { type: "string" }, "js-motion": { type: "boolean" },
};

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min}–${max}`);
  }
  return parsed;
}

async function sample(page, folder, screenshot, elapsedMs, includeDesign) {
  const [{ data }, { result }] = await Promise.all([
    page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }),
    page.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const clean = (value) => (value ?? "").replace(/\\s+/g, " ").trim().slice(0, 100);
        const sectionTitles = new WeakMap();
        const sectionOf = (node) => {
          for (let section = node?.closest?.("section,article"); section; section = section.parentElement?.closest("section,article")) {
            if (!sectionTitles.has(section)) {
              sectionTitles.set(section, clean(section.querySelector("h1,h2,h3")?.textContent));
            }
            if (sectionTitles.get(section)) return sectionTitles.get(section);
          }
          return "";
        };
        const describe = (e, css = getComputedStyle(e)) => {
          const box = e.getBoundingClientRect();
          const properties = ["display", "gridTemplateColumns", "flexDirection", "gap", "padding", "fontSize", "lineHeight", "fontWeight", "borderRadius", "objectFit"];
          return {tag:e.tagName,box:[box.x,box.y,box.width,box.height].map(Math.round),
            label:clean(e.getAttribute("aria-label") ?? e.getAttribute("alt") ?? e.getAttribute("placeholder") ??
              (e.matches("h1,h2,button,[role=tab]") ? e.textContent : "")), section:sectionOf(e),
            position:css.position,fontSize:css.fontSize,borderRadius:css.borderRadius,
            opacity:css.opacity,transform:css.transform,transition:css.transitionDuration,
            css:Object.fromEntries(properties.map((property) => [property, css[property]]))};
        };
        const layout = [...document.querySelectorAll("h1,h2,main,nav,footer,form,textarea,[role=tablist],canvas")].slice(0,40);
        const visibleDetails = [...document.querySelectorAll("section,article,button,img,video,[role=tab]")].filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight &&
            box.right > 0 && box.left < innerWidth && !!sectionOf(element);
        }).slice(0,45);
        const designRoles = "header,nav,footer,section,article,h1,h2,h3,h4,h5,h6,p,form,button,a,input,textarea,select,label,[role=button],[role=tab],[role=tablist],img,video,canvas";
        const design = [];
        const roleCounts = new Map();
        for (const element of ${includeDesign} ? [document.body, ...document.querySelectorAll(designRoles)] : []) {
          if (!element) continue;
          const explicitRole = element.getAttribute("role");
          const role = ["button", "tab", "tablist"].includes(explicitRole) ? explicitRole : element.tagName.toLowerCase();
          const region = element.closest("header,nav,footer")?.tagName ?? "content";
          const bucket = region + "/" + role;
          if ((roleCounts.get(bucket) ?? 0) >= 8) continue;
          const box = element.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top >= innerHeight ||
              box.right <= 0 || box.left >= innerWidth) continue;
          const css = getComputedStyle(element);
          if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
          const item = describe(element, css);
          const properties = ["fontFamily", "letterSpacing", "color", "backgroundColor"];
          item.role = role;
          item.label ||= clean(element.getAttribute("title") ?? (element.matches("h1,h2,h3,h4,h5,h6,p,a,label,[role=button]") ? element.textContent : ""));
          for (const property of properties) item.css[property] = css[property];
          design.push(item);
          roleCounts.set(bucket, (roleCounts.get(bucket) ?? 0) + 1);
        }
        return JSON.stringify({
        title: document.title, scrollY, viewport: [innerWidth, innerHeight],
        canvases: document.querySelectorAll("canvas").length,
        layout: [...new Set([...layout, ...visibleDetails])].map((element) => describe(element)),
        design: ${includeDesign} ? design : undefined,
        videos: [...document.querySelectorAll("video")].slice(0, 30).map(v => ({
          playing: !v.paused, time: v.currentTime, muted: v.muted, loop: v.loop
        })),
        animations: document.getAnimations().slice(0, 100).map(a => {
          const timing = a.effect?.getTiming();
          return {name: a.animationName ?? a.transitionProperty ?? null, state: a.playState,
            time: a.currentTime, duration: timing?.duration, iterations: timing?.iterations,
            delay: timing?.delay, easing: timing?.easing, section: sectionOf(a.effect?.target)};
        })
      });
      })()`,
    }),
  ]);
  await writeFile(join(folder, screenshot), Buffer.from(data, "base64"));
  return { elapsedMs, screenshot, ...JSON.parse(result.value) };
}

async function loadPositions(path, count) {
  const archive = JSON.parse(await readFile(resolve(path), "utf8"));
  const positions = archive.samples?.map((sample) => sample.scrollY);
  if (positions?.length !== count || !positions.every((position) => Number.isFinite(position) && position >= 0)) {
    throw new Error("Reference scroll positions are missing or the sample count differs");
  }
  return positions;
}

async function runBrowser({ url, output, values, viewport, offline, configure, finish }) {
  const seconds = integer(values.seconds, 20, 2, 600, "--seconds");
  const samples = integer(values.samples, 3, 1, 12, "--samples");
  const actions = await readActions(values.actions);
  const browser = await launchChrome({
    ...viewport, executable: values.chrome ?? process.env.CHROME_PATH ?? defaultChrome,
    headless: values.headless ?? false, offline,
  });
  const capture = [];
  try {
    const { product } = await browser.page.send("Browser.getVersion");
    const metadata = { browser: product, recordedAt: new Date().toISOString(), devicePixelRatio: 1 };
    const state = await configure(browser.page);
    const motion = await startMotionCapture(browser.page, values);
    const startClip = canvasCapture(motion, output);
    const finishJsMotion = values["js-motion"] && await startJsMotion(browser.page, "__wr_" + randomUUID());
    const navigation = await browser.page.send("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
    const positions = values.match ? await loadPositions(values.match, samples) : null;
    const scroller = await createScroller(browser.page, {
      scroll: values.scroll, match: positions, samples, headless: values.headless,
    });
    console.log(scroller
      ? `Automatic scrolling and sampling will take about ${seconds} seconds. First screenshot in about ${Number((seconds / samples).toFixed(1))} seconds, then scrolling continues.`
      : `${offline ? "Replaying" : "Recording"} for ${seconds} seconds. You can interact with the browser.`);
    async function take(screenshot, elapsedMs, includeDesign = false) {
      const observation = await motion.snapshot().catch((error) => ({ error: error.message }));
      return { ...await sample(browser.page, output, screenshot, elapsedMs, includeDesign), observation };
    }
    const started = Date.now();
    for (let index = 1; index <= samples; index++) {
      const target = started + seconds * 1000 * index / samples;
      if (scroller) await scroller.step(index, target);
      else await delay(Math.max(0, target - Date.now()));
      try {
        capture.push(await take(`frame-${String(index).padStart(2, "0")}.png`, Date.now() - started, true));
      } catch (error) {
        capture.push({ elapsedMs: Date.now() - started, error: error.message });
      }
    }
    const actionCaptures = await captureActions(browser.page, actions, take, startClip);
    for (const [index, action] of actionCaptures.entries()) {
      if (action.error) console.warn(`Action ${index + 1} incomplete · ${action.error}`);
      if (action.clip?.error) console.warn(`Action ${index + 1} Canvas clip incomplete · ${action.clip.error}`);
    }
    let clip;
    if (values.canvas !== undefined) {
      const stop = await startClip(values.canvas, "standalone");
      await delay(2000);
      clip = await stop();
      if (clip.error) console.warn(`Canvas clip incomplete · ${clip.error}`);
    }
    if (actions.length) await writeFile(join(output, "actions.json"), JSON.stringify(actions, null, 2));
    const motionCapture = await motion.finish().catch((error) => ({ error: error.message }));
    if (clip) motionCapture.canvasClip = clip;
    if (finishJsMotion) motionCapture.js = await finishJsMotion().catch((error) => ({ error: error.message }));
    if (motionCapture.error) console.warn(`Motion capture incomplete · ${motionCapture.error}`);
    await finish(state, capture, motionCapture, actionCaptures, metadata);
  } finally {
    await browser.close();
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true, allowNegative: true });
  const [command, first, second] = positionals;
  if (values.help || !command) return console.log(usage);
  if (values.baseline !== undefined && command !== "verify") throw new Error("--baseline is only valid with verify");
  if (values["media-url"] && command !== "fill-media") throw new Error("--media-url is only valid with fill-media");
  if (command === "fill-media" && first && positionals.length === 2) {
    const result = await fillMedia(first, values["media-url"]);
    for (const { url, bytes, downloaded } of result.repaired) {
      console.log(`Filled ${new URL(url).pathname} · ${downloaded} bytes downloaded · ${bytes} bytes total`);
    }
    for (const { url, reason } of result.failed) console.warn(`Media incomplete · ${new URL(url).pathname} · ${reason}`);
    console.log(`Media · ${result.repaired.length} repaired · ${result.failed.length} incomplete`);
    if (result.failed.length) process.exitCode = 1;
    return;
  }
  if (command === "record" && first && second && positionals.length === 3) {
    const url = publicUrl(first);
    if (!url) throw new Error("Use a public HTTP(S) URL without credentials or signed parameters");
    const output = resolve(second);
    const viewport = {
      width: integer(values.width, 1440, 320, 3840, "--width"),
      height: integer(values.height, 900, 240, 2160, "--height"),
    };
    await mkdir(output);
    await runBrowser({
      url, output, viewport, values, offline: false,
      configure: (page) => recordNetwork(page, output),
      finish: async (recorder, samples, motion, actions, metadata) => {
        const result = await recorder.finish();
        if (!result.responses.some((entry) => entry.url === url && entry.status < 400)) {
          throw new Error("Entry document was not captured. Check for a verification page or incomplete navigation.");
        }
        const manifest = { version: 1, url, viewport, scroll: values.scroll ?? "manual", durationSeconds: integer(values.seconds, 20, 2, 600, "--seconds"), ...metadata, ...result, samples, motion, actions };
        await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
        console.log(`Captured ${result.responses.length} resources (${result.storedBytes} bytes) in ${output}`);
      },
    });
    return;
  }
  if (command === "replay" && first && !second) {
    const folder = resolve(first);
    const archive = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
    if (archive.version !== 1 || !publicUrl(archive.url) || !Array.isArray(archive.responses)) {
      throw new Error("Unsupported capture manifest");
    }
    const output = resolve(values.output ?? join(folder, `replay-${Date.now()}`));
    await mkdir(output);
    const viewport = {
      width: integer(values.width, archive.viewport.width, 320, 3840, "--width"),
      height: integer(values.height, archive.viewport.height, 240, 2160, "--height"),
    };
    await runBrowser({
      url: archive.url, output, viewport, values, offline: true,
      configure: (page) => replayNetwork(page, folder, archive),
      finish: async (network, samples, motion, actions) => {
        await writeFile(join(output, "report.json"), JSON.stringify({ network, viewport, samples, motion, actions }, null, 2));
        console.log(`Replay complete. Served ${network.served}, missing ${network.missing}, blocked ${network.blocked}. Output: ${output}`);
      },
    });
    return;
  }
  if (command === "export" && first && second && positionals.length === 3) {
    const exported = await exportProject(first, second, { recover: values["recover-images"] });
    console.log(`Exported ${exported.count} routes. Run node "${join(exported.output, "serve.mjs")}" to preview.`);
    if (exported.images.total) {
      const { recovered, verified, total } = exported.images;
      console.log(`Images: ${verified}/${total} verified locally, ${recovered} recovered. See manifest/images.json.`);
    }
    return;
  }
  if (command === "guide" && first && second && positionals.length === 3) {
    console.log(`Page map: ${join(await writeGuide(first, second), "page.md")}`);
    return;
  }
  if (command === "generate" && first && second && positionals.length === 3) {
    console.log(await generateProject(first, second, values));
    return;
  }
  if (command === "inspect" && first && second && positionals.length === 3) {
    const url = publicUrl(first);
    if (!url) throw new Error("Candidate page must use an HTTP(S) URL");
    const output = resolve(second);
    const viewport = {
      width: integer(values.width, 1440, 320, 3840, "--width"),
      height: integer(values.height, 900, 240, 2160, "--height"),
    };
    await mkdir(output);
    await runBrowser({
      url, output, viewport, values, offline: false, configure: () => undefined,
      finish: async (_unused, samples, motion, actions) => {
        await writeFile(join(output, "report.json"), JSON.stringify({ viewport, samples, motion, actions }, null, 2));
        console.log(output);
      },
    });
    return;
  }
  if (command === "repair" && first && positionals.length === 2) {
    console.log(await writeRepairChecklist(first));
    return;
  }
  if (["baseline", "verify"].includes(command) && first && second && positionals.length === 3) {
    const plan = await readVerifyPlan(first, { referenceOnly: command === "baseline" });
    const output = resolve(second);
    const sourceExport = command === "verify" ? await loadVerificationAssets(plan.sourceExport, plan.reference) : null;
    const executable = values.chrome ?? process.env.CHROME_PATH ?? defaultChrome;
    await mkdir(output);
    const reference = values.baseline === undefined
      ? await captureVerificationSide(plan, "reference", output, executable, values.headless)
      : await loadVerificationBaseline(plan, resolve(values.baseline), output);
    if (command === "baseline") {
      await saveVerificationBaseline(plan, output, reference);
      const blocked = reference.sections.flat().filter((state) =>
        state.error || state.frames.some((frame) => referenceFrameIssues(frame, plan).length)).length;
      console.log(`Baseline: ${join(output, "baseline.json")} · ${blocked} blocked states`);
      if (blocked) process.exitCode = 1;
      return;
    }
    const candidate = await captureVerificationSide(plan, "candidate", output, executable, values.headless);
    const summary = await writeVerificationReport(plan, output, reference, candidate, sourceExport);
    const checklist = await writeRepairChecklist(join(output, "verify.json"));
    console.log(`Coverage ${summary.evaluated}/${summary.planned} (${summary.coveragePercent}%) · ${summary.passed} passed · ${summary.failed} failed · ${summary.blocked} blocked`);
    console.log(`Report: ${join(output, "verify.html")}`);
    console.log(`Repair checklist: ${checklist}`);
    if (summary.passed !== summary.planned) process.exitCode = 1;
    return;
  }
  if (command === "compare" && first && second && positionals.length === 3) {
    console.log(await compareCaptures(first, second, values.output));
    return;
  }
  throw new Error(usage);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
