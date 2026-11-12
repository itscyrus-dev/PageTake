import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../src/capture/archive.mjs";
import { fillMedia } from "../src/capture/fill-media.mjs";

test("Fill media downloads verified gaps and retains incompatible recordings", async () => {
  const bytes = Buffer.from("0123456789");
  const calls = [];
  const server = createServer((request, response) => {
    const { url, headers } = request;
    calls.push([url, headers.range, headers["if-range"]]);
    const media = { "content-type": "video/mp4", etag: url === "/changed" ? '"changed"' : '"fixture"' };
    if (!headers.range) return response.writeHead(200, media).end(bytes);
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.range);
    response.writeHead(206, { ...media, "content-range": `bytes ${first}-${last}/${bytes.length}` });
    response.end(bytes.subarray(Number(first), Number(last) + 1));
  });
  const root = await mkdtemp(join(tmpdir(), "pagetake-fill-media-"));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    await mkdir(join(root, "bodies"));
    const manifestPath = join(root, "manifest.json");
    async function part(path, start, end, etag) {
      const content = bytes.subarray(start, end + 1);
      const body = digest(content);
      await writeFile(join(root, "bodies", body), content);
      return { url: base + path, status: 206, range: `bytes=${start}-${end}`, body, bytes: content.length,
        headers: [
          { name: "Content-Type", value: "video/mp4" },
          { name: "Content-Range", value: `bytes ${start}-${end}/${bytes.length}` },
          ...(etag ? [{ name: "ETag", value: etag }] : []),
        ] };
    }
    const responses = await Promise.all([
      part("/gaps", 3, 5, '"fixture"'), part("/gaps", 8, 9, '"fixture"'),
      part("/no-validator", 3, 9), part("/changed", 3, 9, '"fixture"'),
    ]);
    await writeFile(manifestPath, JSON.stringify({ version: 1, responses,
      networkIssues: [{ url: base + "/uncaptured", range: "bytes=0-", reason: "request-canceled" }] }));

    await assert.rejects(fillMedia(root, [base + "/unknown"]), /was not observed/);
    assert.equal(calls.length, 0);
    const result = await fillMedia(root, [base + "/uncaptured"]);
    assert.deepEqual(calls, [
      ["/gaps", "bytes=0-2", '"fixture"'], ["/gaps", "bytes=6-7", '"fixture"'],
      ["/no-validator", undefined, undefined], ["/changed", "bytes=0-2", '"fixture"'],
      ["/uncaptured", undefined, undefined],
    ]);
    assert.deepEqual(result.repaired.map(({ downloaded }) => downloaded), [5, 10, 10]);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].reason, /recorded version/);
    const filled = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(filled.responses.length, 4);
    assert.deepEqual(filled.responses[0], responses[3]);
    for (const entry of filled.responses.slice(1)) {
      assert.equal(entry.status, 200);
      assert.equal(entry.range, "");
      assert.equal(entry.headers.some(({ name }) => name.toLowerCase() === "content-range"), false);
      assert.deepEqual(await readFile(join(root, "bodies", entry.body)), bytes);
    }
    const second = await fillMedia(root, [base + "/uncaptured"]);
    assert.equal(second.repaired.length, 0);
    assert.deepEqual(calls.at(-1), ["/changed", "bytes=0-2", '"fixture"']);
    assert.equal(filled.mediaRepairs.length, 3);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
