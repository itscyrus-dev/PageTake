import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../src/capture/archive.mjs";
import { defaultChrome, launchChrome } from "../src/capture/chrome.mjs";
import { exportProject } from "../src/export/export.mjs";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="blue"/></svg>';
const markup = `<!doctype html><title>Image variants</title><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="page.css">
<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="mobile-dark.svg">
  <source media="(max-width: 600px)" srcset="mobile.svg">
  <source media="(prefers-color-scheme: dark)" srcset="/dark.svg 1x, /dark,2x.svg 2x">
  <img id="hero" src="/light.svg">
</picture>
<img src="/_next/image?url=%2Foptimizer.svg&amp;w=320&amp;q=75"
     srcset="/_next/image?url=%2Foptimizer.svg&amp;w=320&amp;q=75 1x, /_next/image?url=%2Foptimizer.svg&amp;w=1080&amp;q=75 2x">
<img src="/missing.svg"><img src="/private.svg?token=fixture-secret">
<div id="background"></div>`;
const css = '@media (prefers-color-scheme:dark) { #background { background-image:url("dark-background.svg") } }';

async function addResponse(folder, url, type, content) {
  const body = digest(content);
  await writeFile(join(folder, "bodies", body), content);
  return { url, status: 200, range: "", headers: [{ name: "content-type", value: type }], body, bytes: Buffer.byteLength(content) };
}

test("Export recovers declared image variants and previews them after the origin closes", { timeout: 40000 }, async () => {
  const requests = [];
  const origin = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/missing.svg") return response.writeHead(200, { "content-type": "text/html" }).end("not an image");
    response.writeHead(200, { "content-type": "image/svg+xml" }).end(svg);
  });
  const root = await mkdtemp(join(tmpdir(), "pagetake-image-export-"));
  let preview, chrome;
  try {
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const url = `http://127.0.0.1:${origin.address().port}/demo/`;
    const archive = join(root, "reference");
    await mkdir(join(archive, "bodies"), { recursive: true });
    const responses = await Promise.all([
      addResponse(archive, url, "text/html", markup),
      addResponse(archive, new URL("page.css", url).href, "text/css", css),
      addResponse(archive, new URL("/light.svg", url).href, "image/svg+xml", svg),
    ]);
    const original = JSON.stringify({ version: 1, url, responses, samples: [], viewport: { width: 1440, height: 900 } });
    await writeFile(join(archive, "manifest.json"), original);
    const output = join(root, "export");
    await exportProject(archive, output);
    await new Promise((resolve) => origin.close(resolve));

    assert.equal(await readFile(join(archive, "manifest.json"), "utf8"), original);
    const { images } = JSON.parse(await readFile(join(output, "manifest", "images.json"), "utf8"));
    assert.equal(images.find(({ url }) => url.endsWith("/missing.svg")).status, "missing");
    assert.ok(!JSON.stringify(images).includes("fixture-secret"));
    assert.ok(!requests.some((url) => /private|light\.svg/.test(url)));
    assert.equal(requests.filter((url) => url.startsWith("/_next/image")).length, 1);
    assert.ok(images.some(({ status }) => status === "responsive-variant"));
    assert.ok(images.filter(({ status }) => status !== "missing").every(({ verified }) => verified));
    const offline = join(root, "offline-export");
    await exportProject(archive, offline, { recover: false });
    const offlineReport = JSON.parse(await readFile(join(offline, "manifest", "images.json"), "utf8"));
    assert.equal(offlineReport.images.find(({ url }) => url.endsWith("/dark.svg")).reason, "Image recovery disabled");

    preview = spawn(process.execPath, [join(output, "serve.mjs"), output, "0"]);
    const [data] = await once(preview.stdout, "data", { signal: AbortSignal.timeout(5000) });
    const base = data.toString().trim();
    chrome = await launchChrome({ executable: process.env.CHROME_PATH ?? defaultChrome, headless: true, width: 1200, height: 800 });
    await chrome.page.send("Network.setBlockedURLs", { urls: [new URL(url).origin + "/*"] });
    for (const [width, scheme, scale, expected] of [
      [1200, "light", 1, "/light.svg"],
      [1200, "dark", 1, "/dark.svg"],
      [1200, "dark", 2, "/dark,2x.svg"],
      [390, "light", 1, "/demo/mobile.svg"],
      [390, "dark", 1, "/demo/mobile-dark.svg"],
    ]) {
      await chrome.page.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: scale, mobile: false });
      await chrome.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      const loaded = oncePageLoad(chrome.page);
      await chrome.page.send("Page.navigate", { url: base + "demo/" });
      await loaded;
      const { result } = await chrome.page.send("Runtime.evaluate", {
        expression: `(async () => {
          const image = document.querySelector("#hero");
          await image.decode();
          const css = getComputedStyle(document.querySelector("#background")).backgroundImage;
          if (css !== "none") {
            const background = new Image();
            background.src = css.slice(5, -2);
            await background.decode();
          }
          const current = new URL(image.currentSrc);
          return { source: current.pathname, local: current.origin === location.origin, background: css };
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      assert.equal(result.value?.source, expected);
      assert.equal(result.value.local, true);
      if (scheme === "dark") assert.equal(result.value.background, `url("${base}demo/dark-background.svg")`);
    }
  } finally {
    origin.close();
    if (preview?.exitCode === null) {
      const exited = once(preview, "exit");
      preview.kill();
      await exited;
    }
    await chrome?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function oncePageLoad(page) {
  return new Promise((resolve) => page.on("Page.loadEventFired", resolve));
}
