import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../pagetake", import.meta.url));

test("Clone creates a project and refreshes its default output while preserving user files", { timeout: 40000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pagetake-clone-"));
  const recordings = join(root, "recordings");
  let title = "First capture";
  const origin = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });
  try {
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const url = `http://127.0.0.1:${origin.address().port}/`;
    const project = join(recordings, "example");
    const clone = (...extra) => run(process.execPath, [
      cli, "clone", url, "example", "--headless", "--seconds", "2", "--samples", "2", ...extra,
    ], { env: { ...process.env, PAGETAKE_DIR: recordings } });
    const html = () => readFile(join(project, "source", "index.html"), "utf8");

    await clone();
    assert.match(await html(), /First capture/);
    await mkdir(join(project, "source", "react"));
    await writeFile(join(project, "source", "react", "App.tsx"), "user project");
    await mkdir(join(project, "source-other"));
    await writeFile(join(project, "source-other", "index.html"), "named export");
    await writeFile(join(project, "source", "resources", "stale.txt"), "stale output");

    title = "Second capture";
    await clone();
    assert.match(await html(), /Second capture/);
    const reference = join(project, "reference", "manifest.json");
    const captured = await readFile(reference, "utf8");
    assert.equal(JSON.parse(captured).samples[0].title, "Second capture");
    assert.equal(await readFile(join(project, "source", "react", "App.tsx"), "utf8"), "user project");
    assert.equal(await readFile(join(project, "source-other", "index.html"), "utf8"), "named export");
    assert.ok(!(await readdir(join(project, "source", "resources"))).includes("stale.txt"));

    await assert.rejects(clone("--seconds", "invalid"), /--seconds must be an integer/);
    assert.equal(await readFile(reference, "utf8"), captured);
    assert.match(await html(), /Second capture/);
    assert.deepEqual((await readdir(project)).sort(), ["reference", "source", "source-other"]);
  } finally {
    origin.close();
    await rm(root, { recursive: true, force: true });
  }
});
