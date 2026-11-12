import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { publicUrl } from "../src/capture/archive.mjs";

const run = promisify(execFile);
const cli = new URL("../pagetake.mjs", import.meta.url).pathname;

test("Credentials and signed URLs are excluded from capture", () => {
  assert.equal(publicUrl("https://example.com/script.js?v=2#test"), "https://example.com/script.js?v=2");
  assert.equal(publicUrl("https://user:pass@example.com"), null);
  assert.equal(publicUrl("https://example.com/image?X-Amz-Signature=fixture"), null);
  assert.equal(publicUrl("data:text/plain,hi"), null);
});

test("Recorded CSS, scripts, JSON, and Canvas work after the origin stops", { timeout: 45000 }, async () => {
  const server = createServer((request, response) => {
    const resources = {
      "/": ["text/html; charset=utf-8", '<!doctype html><title>Loading</title><link rel="stylesheet" href="/style.css"><main><section><h1>Motion demo</h1><canvas width="180" height="90"></canvas><div class="tile"></div></section></main><script src="/app.js"></script>'],
      "/style.css": ["text/css", ".tile{width:40px;height:40px;background:red;animation:move 2s linear infinite}@keyframes move{to{transform:translateX(140px)}}"],
      "/app.js": ["text/javascript", 'fetch("/data.json").then(r=>r.json()).then(data=>document.title=data.title);const ctx=document.querySelector("canvas").getContext("2d");function draw(t){ctx.fillStyle="white";ctx.fillRect(0,0,180,90);ctx.fillStyle="blue";ctx.fillRect(t%140,0,40,40);requestAnimationFrame(draw)}requestAnimationFrame(draw);'],
      "/data.json": ["application/json", '{"title":"Replay verified"}'],
    };
    const entry = resources[request.url];
    if (!entry) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": entry[0], "set-cookie": "fixture=drop-me" });
    response.end(entry[1]);
  });
  const root = await mkdtemp(join(tmpdir(), "web-replay-test-"));
  const recording = join(root, "capture");
  const replay = join(root, "replay");
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/`;
    await run(process.execPath, [cli, "record", url, recording, "--headless", "--seconds", "4", "--samples", "2"]);
    await new Promise((resolve) => server.close(resolve));
    const manifest = JSON.parse(await readFile(join(recording, "manifest.json"), "utf8"));
    assert.equal(manifest.responses.filter((entry) => entry.status === 200).length, 4);
    assert.ok(manifest.responses.every((entry) => entry.headers.every((header) => header.name.toLowerCase() !== "set-cookie")));
    const output = join(root, "source");
    await run(process.execPath, [cli, "export", recording, output]);
    const hero = await readFile(join(output, "guide", "01-hero.md"), "utf8");
    assert.match(hero, /frame-01\.png/);
    assert.match(hero, /fontSize=/);
    assert.match(hero, /move · 2000 ms/);
    await run(process.execPath, [cli, "replay", recording, "--headless", "--seconds", "4", "--samples", "2", "--output", replay]);
    const report = JSON.parse(await readFile(join(replay, "report.json"), "utf8"));
    assert.ok(report.network.served >= 4);
    assert.equal(report.network.errors, 0);
    for (const sample of report.samples) {
      assert.equal(sample.title, "Replay verified");
      assert.equal(sample.canvases, 1);
      assert.ok(sample.animations.some((animation) => animation.name === "move" && animation.state === "running"));
    }
    const [first, second] = await Promise.all(report.samples.map(({ screenshot }) => readFile(join(replay, screenshot))));
    assert.notDeepEqual(first, second);
    await run(process.execPath, [cli, "compare", recording, replay]);
    const comparison = await readFile(join(replay, "compare.html"), "utf8");
    assert.match(comparison, /\.\.\/capture\/frame-01\.png/);
    assert.match(comparison, /src="frame-01\.png"/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Automatic scroll dismisses the known guide and captures the selected section and lazy assets", { timeout: 30000 }, async () => {
  const markup = `<!doctype html><title>Scrolling</title>
    <style>body{margin:0}.space{height:1100px}#chosen{height:1800px}</style>
    <div data-slot="card" id="guide" hidden><p>\u4e0a\u4f20\u6587\u4ef6\uff0c\u521b\u5efa\u7206\u6b3e\u5e7f\u544a\u3002</p>
      <button aria-label="\u5173\u95ed" onclick="document.body.style.overflow='auto';this.parentElement.remove()">×</button>
    </div>
    <div class="space"></div><section id="chosen">Selected section</section><div class="space"></div>
    <script>setTimeout(()=>{
      document.body.style.overflow="hidden";
      document.getElementById("guide").hidden=false;
    }, 1500);
    let loaded=false; addEventListener("scroll",()=>{
      if(scrollY>1600&&!loaded){loaded=true;fetch("/late.json").then(()=>document.title="Lazy resource loaded")}
    });</script>`;
  const server = createServer((request, response) => {
    if (request.url === "/late.json") {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    } else response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(markup);
  });
  const root = await mkdtemp(join(tmpdir(), "web-replay-scroll-test-"));
  const archive = join(root, "capture");
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/winning-ads`;
    await run(process.execPath, [cli, "record", url, archive, "--headless", "--height", "600",
      "--seconds", "4", "--samples", "3", "--scroll", "#chosen"]);
    const manifest = JSON.parse(await readFile(join(archive, "manifest.json"), "utf8"));
    assert.equal(manifest.scroll, "#chosen");
    assert.deepEqual(manifest.samples.map(({ scrollY }) => scrollY), [1100, 1700, 2300]);
    assert.ok(manifest.responses.some((entry) => new URL(entry.url).pathname === "/late.json"));
    assert.equal(manifest.samples.at(-1).title, "Lazy resource loaded");
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
