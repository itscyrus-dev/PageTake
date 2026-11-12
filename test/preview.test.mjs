import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serve = fileURLToPath(new URL("../serve.mjs", import.meta.url));

test("Preview serves recorded Next.js and CDN image sizes for uncaptured variants", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pagetake-preview-"));
  let child;
  let lines;
  try {
    const image = "/_next/image?url=%2Fshortcut.png&q=75";
    const routes = [
      { route: image + "&w=640", file: "640.svg", status: 200, type: "image/svg+xml" },
      { route: image + "&w=320", file: "320.svg", status: 200, type: "image/svg+xml" },
      { route: image + "&w=1024", file: "error.txt", status: 404, type: "text/plain" },
      { route: "/hero.png?imageMogr2/format/webp/quality/85/thumbnail/640x", file: "640.svg", status: 200, type: "image/svg+xml" },
      { route: "/hero.png?imageMogr2/format/webp/quality/85/thumbnail/320x", file: "320.svg", status: 200, type: "image/svg+xml" },
    ];
    await Promise.all([
      writeFile(join(root, "routes.json"), JSON.stringify({ routes })),
      ...[320, 640].map((width) => writeFile(join(root, width + ".svg"),
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10"/>`)),
      writeFile(join(root, "error.txt"), "Not found"),
    ]);
    child = spawn(process.execPath, [serve, root, "0"], { stdio: ["ignore", "pipe", "inherit"] });
    lines = createInterface({ input: child.stdout });
    const [base] = await once(lines, "line", { signal: AbortSignal.timeout(5000) });
    for (const [request, expected] of [
      [image + "&w=320", 320],
      ["/_next/image?w=400&q=75&url=%2Fshortcut.png", 640],
      [image + "&w=1200", 640],
      ["/hero.png?imageMogr2/format/webp/quality/85/thumbnail/400x", 640],
      ["/hero.png?imageMogr2/format/webp/quality/85/thumbnail/1200x", 640],
    ]) {
      const response = await fetch(new URL(request, base));
      assert.equal(response.status, 200, request);
      assert.equal(response.headers.get("content-type"), "image/svg+xml");
      assert.match(await response.text(), new RegExp(`width="${expected}"`));
    }
    for (const request of [
      image + "&w=1024",
      image + "&w=invalid",
      "/hero.png?imageMogr2/format/webp/quality/85/thumbnail/640x480",
      "/hero.png?imageMogr2/format/webp/quality/90/thumbnail/640x",
      "/_next/image?url=%2Fmissing.png&q=75&w=400",
      "/_next/image?url=%2Fshortcut.png&q=90&w=400",
    ]) {
      assert.equal((await fetch(new URL(request, base))).status, 404, request);
    }
  } finally {
    lines?.close();
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
