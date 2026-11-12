import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportProject } from "../src/export/export.mjs";
import { generateProject, parseFiles } from "../src/generate.mjs";
import { compareScreenshots } from "../src/compare/score.mjs";

test("Identical pixels score 100 and substantially different frames score lower", () => {
  const solid = (byte) => ({ width: 32, height: 32, channels: 3, pixels: Buffer.alloc(32 * 32 * 3, byte) });
  assert.deepEqual(compareScreenshots(solid(10), solid(10)), { pixel: 100, structural: 100, visual: 100 });
  assert.ok(compareScreenshots(solid(0), solid(255)).visual < 1);
  assert.equal(compareScreenshots(solid(10), { ...solid(10), width: 31 }), null);
});

test("Reject out-of-tree paths and duplicate model files", () => {
  assert.throws(() => parseFiles('{"files":[{"path":"../index.html","content":"x"}]}'), /file path/);
  assert.throws(() => parseFiles('{"files":[{"path":"index.html","content":"x"},{"path":"Index.html","content":"x"}]}'), /duplicate/);
});

async function fixture(folder) {
  await mkdir(join(folder, "bodies"), { recursive: true });
  const resources = [
    ["https://test.example/", "text/html", '<title>Demo</title><main><section><h1>Hero</h1><button>Upload</button></section><section><h2>Gallery</h2><video aria-label="Product demo"></video></section></main><script src="https://assets.example/app.js">privateBootstrap()</script>'],
    ["https://assets.example/app.js", "text/javascript", 'document.title="Animation";'],
  ];
  const responses = [];
  for (const [url, type, value] of resources) {
    const body = createHash("sha256").update(value).digest("hex");
    await writeFile(join(folder, "bodies", body), value);
    responses.push({ url, status: 200, range: "", body, bytes: Buffer.byteLength(value), headers: [{ name: "content-type", value: type }] });
  }
  await writeFile(join(folder, "manifest.json"), JSON.stringify({
    version: 1, url: resources[0][0], responses, samples: [], viewport: { width: 1440, height: 900 },
  }));
}

test("Export a standalone project with local aliases for CDN routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-replay-export-test-"));
  try {
    const archive = join(root, "archive");
    await fixture(archive);
    const project = await exportProject(archive, join(root, "project"));
    assert.equal(project.count, 6);
    const markup = await readFile(join(project.output, "index.html"), "utf8");
    assert.match(markup, /src="\/_w\/2_+\/app\.js"/);
    assert.match(markup, /privateBootstrap\(\)/);
    assert.ok((await readFile(join(project.output, "serve.mjs"), "utf8")).includes("createServer"));
    const guide = await readFile(join(project.output, "AGENTS.md"), "utf8");
    assert.match(guide, /node serve\.mjs/);
    assert.match(guide, /Work in the destination project/);
    const map = await readFile(join(project.output, "guide", "page.md"), "utf8");
    assert.match(map, /\[Hero\]\(01-hero\.md\)/);
    assert.match(map, /\[Gallery\]\(02-gallery\.md\)/);
    const hero = await readFile(join(project.output, "guide", "01-hero.md"), "utf8");
    assert.match(hero, /button · Upload/);
    assert.doesNotMatch(hero, /privateBootstrap|Product demo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Send page evidence to a compatible model endpoint and save editable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-replay-generation-test-"));
  const previous = process.env.WEB_REPLAY_API_KEY;
  process.env.WEB_REPLAY_API_KEY = "fixture-key";
  let received;
  const server = createServer(async (request, response) => {
    const data = [];
    for await (const chunk of request) data.push(chunk);
    received = { path: request.url, auth: request.headers.authorization, input: JSON.parse(Buffer.concat(data)) };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      files: [{ path: "index.html", content: "<h1>Animated</h1>" }, { path: "app.js", content: "requestAnimationFrame(() => {});" }],
    }) } }] }));
  });
  try {
    const archive = join(root, "archive");
    await fixture(archive);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const options = { model: "fixture-model", "base-url": `http://127.0.0.1:${server.address().port}/v1` };
    const project = await generateProject(archive, join(root, "project"), options);
    assert.equal(received.path, "/v1/chat/completions");
    assert.equal(received.auth, "Bearer fixture-key");
    assert.equal(received.input.model, "fixture-model");
    assert.match(received.input.messages[1].content, /Demo/);
    assert.equal(await readFile(join(project, "index.html"), "utf8"), "<h1>Animated</h1>");
    const prompt = await generateProject(archive, join(root, "prompt"), { "prompt-only": true });
    assert.match(await readFile(join(prompt, "prompt.json"), "utf8"), /Demo/);
  } finally {
    if (previous === undefined) delete process.env.WEB_REPLAY_API_KEY;
    else process.env.WEB_REPLAY_API_KEY = previous;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
