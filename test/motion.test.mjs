import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { defaultChrome, launchChrome } from "../src/capture/chrome.mjs";

const run = promisify(execFile);
const cli = new URL("../pagetake.mjs", import.meta.url).pathname;

test("Export motion, Canvas clips, and verified states and control preview clocks", { timeout: 60000 }, async () => {
  const markup = `<!doctype html><html><head><title>Motion evidence</title><style>
    @property --amount { syntax: "<number>"; inherits: false; initial-value: 0 }
    @keyframes progress { from { --amount: 0 } to { --amount: 100 } }
    #meter { animation: progress 2s linear infinite }
    #tile { width: 60px; height: 40px; background: red; opacity: .25; transition: opacity 600ms ease-in }
    #tab[aria-selected=true] + #tile { opacity: 1 }
    @media (prefers-reduced-motion: reduce) { #meter { animation-duration: 6s } }
    </style></head><body><section id="demo"><h1>Motion demo</h1>
    <button id="tab" role="tab" aria-controls="tile" aria-selected="false">Show panel</button>
    <div id="tile" role="tabpanel"></div><div id="meter">0%</div>
    <canvas id="stage" width="100" height="50"></canvas>
    <svg viewBox="0 0 100 100" width="100" height="100"><circle id="ring" cx="50" cy="50" r="30" fill="none" stroke="blue" stroke-dasharray="100 200" stroke-linecap="round"/></svg>
    <script>
      const frame = requestAnimationFrame.bind(window);
      const ctx = document.querySelector("#stage").getContext("2d");
      let frameCount = 0;
      function draw(t) {
        window.fixtureClock = { t, now: performance.now(), frameCount: ++frameCount };
        ctx.clearRect(0, 0, 100, 50);
        ctx.fillRect((t / 10) % 80, 0, 20, 20);
        frame(draw);
      }
      frame(draw);
      document.querySelector("#tab").onclick = (event) => {
        event.currentTarget.setAttribute("aria-selected", "true");
        let start;
        const tick = (t) => {
          start ??= t;
          const value = Math.min(97, Math.round((t - start) / 6));
          document.querySelector("#meter").textContent = value + "%";
          document.querySelector("#ring").style.strokeDashoffset = 100 - value;
          if (value < 97) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        fetch("/missing.json");
      };
    </script></section></body></html>`;
  const server = createServer((request, response) => {
    if (request.url === "/demo?fixture=1") response.writeHead(200, { "content-type": "text/html" }).end(markup);
    else response.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  const root = await mkdtemp(join(tmpdir(), "web-replay-motion-test-"));
  const recording = join(root, "capture");
  const output = join(root, "source");
  const candidate = join(root, "candidate");
  const plan = join(root, "plan.json");
  const readJson = async (folder, file) => JSON.parse(await readFile(join(folder, file), "utf8"));
  let preview;
  let chrome;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/demo?fixture=1`;
    await writeFile(plan, JSON.stringify([{ type: "click", selector: "#tab", durationMs: 800, canvas: "#stage",
      state: "show-panel", expect: { selector: "#tab", attribute: "aria-selected", value: "true" } }]));
    const browser = ["--headless", "--seconds", "2", "--samples", "1", "--width", "390", "--height", "844"];
    await run(process.execPath, [cli, "record", url, recording, ...browser, "--watch", "#meter", "--actions", plan,
      "--js-motion", "--canvas", "#stage"]);
    const capture = await readJson(recording, "manifest.json");
    assert.ifError(capture.motion.error);
    assert.equal(capture.motion.reducedMotion, false);
    assert.equal(capture.motion.css.properties.length, 1);
    assert.equal(capture.motion.css.reducedMotionRules.length, 1);
    const animation = capture.motion.animations.find((entry) => entry.name === "progress");
    assert.equal(animation.target.selector, "#meter");
    assert.equal(animation.timeline.iterations, "Infinity");
    assert.ok(animation.declaredKeyframes[0].frames.some((frame) => frame.customProperties["--amount"] === "100"));
    assert.ok(animation.samples.some((frame) => Number(frame.values["--amount"]) > 0));
    const transition = capture.motion.animations.find((entry) => entry.type === "css-transition");
    assert.equal(transition.target.selector, "#tile");
    assert.ok(transition.samples.some(({ values }) => Number(values.opacity) > .25 && Number(values.opacity) < 1));
    const tab = capture.motion.components.find((entry) => entry.target.selector === "#tab");
    assert.deepEqual(tab.states.map(({ attributes }) => attributes["aria-selected"]), ["false", "true"]);
    assert.ok(capture.motion.events.some((event) => event.type === "click" && event.trusted));
    const ring = capture.motion.styles.find((entry) => entry.target.selector === "#ring");
    assert.equal(ring.geometry.attributes.r, "30");
    assert.ok(ring.samples.some(({ css }) => css["stroke-dashoffset"] === "3px"));
    const counter = capture.motion.styles.find((entry) => entry.target.selector === "#meter");
    assert.ok(counter.samples.some(({ number }) => number === "97%"));
    assert.deepEqual(capture.actions[0].frames.map(({ phase }) => phase), ["before", 0, 25, 50, 75, 100]);
    assert.equal(capture.actions[0].verified, true);
    assert.ok(capture.motion.js.callbacks.some(({ name, calls }) => name === "draw" && calls > 5));
    assert.ifError(capture.motion.canvasClip.error);
    assert.ifError(capture.actions[0].clip.error);
    await run(process.execPath, [cli, "export", recording, output]);
    const missing = await readJson(output, "manifest/missing.json");
    assert.ok(missing.network.some(({ url, reason, detail }) => url.endsWith("/missing.json") && reason === "http-error" && detail === 404));
    const interactions = await readJson(output, "manifest/interactions.json");
    assert.equal(interactions.stateLinks[0].url, "/?state=show-panel");
    const canvas = await readJson(output, "manifest/canvas-clips.json");
    assert.deepEqual(canvas.clips.map(({ file, width, height }) => [file, width, height]),
      [["canvas-standalone.webm", 100, 50], ["canvas-action-1.webm", 100, 50]]);
    const jsMotion = await readJson(output, "manifest/js-motion.json");
    assert.ok(jsMotion.watchedTargets.some(({ target, samples }) => target.selector === "#meter" && samples.at(-1).number === "97%"));
    assert.ok((await readFile(join(output, "manifest", interactions.actions[0].frames[3].frame))).length > 100);
    preview = spawn(process.execPath, [join(output, "serve.mjs"), output, "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const [address] = await once(preview.stdout, "data");
    const base = address.toString().trim();
    const clip = await fetch(base + "manifest/canvas-action-1.webm");
    assert.equal(clip.headers.get("content-type"), "video/webm");
    assert.equal(Buffer.from(await clip.arrayBuffer()).readUInt32BE(0), 0x1a45dfa3);
    const normal = await fetch(base).then((response) => response.text());
    assert.doesNotMatch(normal, /__web-replay\/preview-motion/);
    const pausedUrl = base + "?motion=step&t=250&section=demo";
    const response = await fetch(pausedUrl);
    assert.match(response.url, /fixture=1&motion=step/);
    assert.match(await response.text(), /__web-replay\/preview-motion/);
    await run(process.execPath, [cli, "inspect", pausedUrl, candidate, ...browser, "--reduced-motion"]);
    const playback = await readJson(candidate, "report.json");
    const paused = playback.samples[0].animations.find(({ name }) => name === "progress");
    assert.equal(paused.state, "paused");
    assert.equal(paused.time, 250);
    assert.equal(paused.duration, 6000);
    const compared = join(root, "compared");
    await run(process.execPath, [cli, "inspect", base, compared, ...browser, "--actions", plan]);
    await run(process.execPath, [cli, "compare", recording, compared]);
    const scores = await readJson(compared, "compare.html.json");
    assert.equal(scores.actions[0].comparable, 6);
    chrome = await launchChrome({ executable: process.env.CHROME_PATH ?? defaultChrome, headless: true, width: 390, height: 844 });
    await chrome.page.send("Page.navigate", { url: base + "?state=show-panel&motion=step&t=250&js=1" });
    const { result, exceptionDetails } = await chrome.page.send("Runtime.evaluate", {
      expression: `(async () => {
        const deadline = Date.now() + 5000;
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        while (!document.documentElement?.dataset.wrState || document.documentElement.dataset.wrState === "loading") {
          if (Date.now() > deadline) throw new Error("Checkpoint did not finish");
          await sleep(30);
        }
        await sleep(500);
        const frame = window.fixtureClock;
        await sleep(200);
        const video = document.createElement("video");
        video.muted = true;
        video.src = "/manifest/canvas-action-1.webm";
        await video.play();
        while (video.currentTime < 0.15 && !video.ended) {
          if (Date.now() > deadline) throw new Error("The Canvas clip did not play");
          await sleep(30);
        }
        return { status: document.documentElement.dataset.wrState, selected: document.querySelector("#tab").getAttribute("aria-selected"),
          first: frame, second: window.fixtureClock, elapsed: performance.now(), video: [video.videoWidth, video.videoHeight, video.currentTime] };
      })()`, returnByValue: true, awaitPromise: true,
    });
    assert.ifError(exceptionDetails);
    assert.equal(result.value.status, "ready");
    assert.equal(result.value.selected, "true");
    assert.ok(result.value.first.frameCount > 5);
    assert.deepEqual(result.value.first, result.value.second);
    assert.equal(result.value.second.now, result.value.elapsed);
    assert.deepEqual(result.value.video.slice(0, 2), [100, 50]);
    assert.ok(result.value.video[2] >= 0.15);
  } finally {
    await chrome?.close();
    preview?.kill();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
