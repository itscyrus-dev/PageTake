import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defaultChrome, launchChrome } from "../src/capture/chrome.mjs";
import { exportProject } from "../src/export/export.mjs";

test("Export discovers a portable animated scene and reports a missing dependency", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pagetake-scenes-"));
  let server, browser, lines;
  try {
    const archive = join(root, "archive");
    const bodies = join(archive, "bodies");
    await mkdir(bodies, { recursive: true });
    const resources = [
      ["https://example.test/", "text/html", '<title>Scenes</title><main><h1>Fixture</h1><div id="hero"></div></main><script src="/app.js"></script>'],
      ["https://example.test/app.js", "text/javascript", `
        const script = document.createElement("script");
        script.src = "https://cdn.example.test/unicornStudio-2.5.2.umd.js";
        script.onload = () => {
          const runtime = window.UnicornStudio;
          runtime.addScene({ element: document.querySelector("#hero"), filePath: "https://cdn.example.test/scene.json",
            fps: 48, interactivity: { mouse: { disabled: !1, disableMobile: !0 } } });
          runtime.addScene({ elementId: "hero", filePath: "https://cdn.example.test/missing-scene.json" });
        };
        document.head.append(script);
      `],
      ["https://cdn.example.test/unicornStudio-2.5.2.umd.js", "text/javascript", `
        window.UnicornStudio = { async addScene({element, filePath, fps, dpi}) {
          const source = document.getElementById(filePath);
          const scene = JSON.parse(source.innerText);
          const texture = await fetch(scene.layers[0].src);
          if (!texture.ok) throw new Error("Texture could not load");
          element.append(document.createElement("canvas"));
          return { fps, dpi, destroy() { element.replaceChildren(); } };
        } };
      `],
      ["https://cdn.example.test/scene.json", "application/json",
        JSON.stringify({ options: { name: "Demo scene", fps: 60, dpi: 1.5 }, layers: [{ src: "./texture.svg" }] })],
      ["https://cdn.example.test/missing-scene.json", "application/json",
        JSON.stringify({ options: { name: "Partial scene" }, layers: [{ src: "./missing.svg" }] })],
      ["https://cdn.example.test/texture.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ];
    const responses = [];
    for (const [url, type, value] of resources) {
      const body = createHash("sha256").update(value).digest("hex");
      await writeFile(join(bodies, body), value);
      responses.push({ url, status: 200, range: "", body, bytes: Buffer.byteLength(value), headers: [{ name: "content-type", value: type }] });
    }
    await writeFile(join(archive, "manifest.json"), JSON.stringify({ version: 1, url: resources[0][0],
      responses, samples: [], viewport: { width: 800, height: 600 } }));
    const exported = await exportProject(archive, join(root, "source"));
    const moved = join(root, "moved");
    await rename(exported.output, moved);
    await rm(archive, { recursive: true });
    const agent = JSON.parse(await readFile(join(moved, "manifest", "agent.json"), "utf8"));
    const { scenes } = JSON.parse(await readFile(join(moved, agent.evidence.scenes), "utf8"));
    const [complete, partial] = scenes;
    assert.equal(complete.status, "packaged");
    assert.equal(complete.selector, "#hero");
    assert.deepEqual(complete.options, { fps: 48, dpi: 1.5, interactivity: { mouse: { disabled: false, disableMobile: true } } });
    assert.equal(complete.dependencies[0].url, "https://cdn.example.test/texture.svg");
    assert.equal(partial.status, "partial");
    assert.deepEqual(partial.missing, ["./missing.svg"]);
    assert.equal(partial.mount, undefined);
    const guide = await readFile(join(moved, agent.entrypoints.sceneGuide), "utf8");
    assert.ok(guide.includes(complete.mount));
    assert.match(guide, /missing\.svg/);

    await writeFile(join(moved, "scene-smoke.html"), `<div id="host"></div><script type="module">
      import { mountScene } from "./${complete.mount}";
      const host = document.querySelector("#host");
      try {
        const scene = await mountScene(host);
        if (!host.querySelector("canvas")) throw Error("Canvas not created");
        scene.destroy();
        document.title = host.childElementCount ? "Cleanup failed" : \`Mounted \${scene.fps} / \${scene.dpi}\`;
      } catch (error) { document.title = error.message; }
    </script>`);
    server = spawn(process.execPath, [join(moved, "serve.mjs"), moved, "0"], { stdio: ["ignore", "pipe", "inherit"] });
    lines = createInterface({ input: server.stdout });
    const [base] = await once(lines, "line", { signal: AbortSignal.timeout(5000) });
    browser = await launchChrome({ executable: process.env.CHROME_PATH ?? defaultChrome, headless: true, width: 800, height: 600 });
    await browser.page.send("Page.navigate", { url: new URL("scene-smoke.html", base).href });
    let title;
    for (let attempt = 0; attempt < 50; attempt++) {
      const observation = await browser.page.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
      title = observation.result.value;
      if (title) break;
      await delay(100);
    }
    assert.equal(title, "Mounted 48 / 1.5");
  } finally {
    await browser?.close();
    lines?.close();
    if (server?.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
