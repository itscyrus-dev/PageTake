import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decodeScreenshot } from "../src/compare/score.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../pagetake", import.meta.url));

test("Verification aligns independent selectors and reports passed, failed, and blocked states", { timeout: 35000 }, async () => {
  const server = createServer((request, response) => {
    const reference = request.url === "/reference";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><style>
      body{margin:0}.lead{height:${reference ? 420 : 610}px}
      article{margin:20px;width:160px;height:100px;background:#fce8bc;color:#222}
      i{display:inline-block;width:25px;height:25px;background:red;opacity:0}
      @keyframes show{from,to{opacity:1}}
      ${reference ? "article:hover i" : "article:hover .available"}{animation:show 2s both}
    </style><div class="lead"></div>
    <article id="${reference ? "original" : "copy"}"><i></i></article>
    <article id="${reference ? "original-extra" : "copy-extra"}"><i class="available"></i></article>`);
  });
  const root = await mkdtemp(join(tmpdir(), "pagetake-verify-"));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const expect = (visibleCount) => [{ label: "Artwork", selectors: { reference: "i", candidate: "i" }, visibleCount }];
    const plan = {
      version: 1, reference: base + "/reference", candidate: base + "/candidate",
      viewport: { width: 800, height: 600 }, minVisual: 95, maxTimingDeltaMs: 500,
      sections: [
        {
          id: "card", selectors: { reference: "#original", candidate: "#copy" },
          states: [
            { id: "default", action: "idle", framesMs: [100], expect: expect(0) },
            { id: "hover", action: "hover", framesMs: [100, 400], expect: expect(1) },
            { id: "leave", action: "leave", framesMs: [100], expect: expect(0) },
          ],
        },
        {
          id: "baseline", selectors: { reference: "#original-extra", candidate: "#copy-extra" },
          states: [{ id: "unconfirmed", action: "idle", framesMs: [100], expect: expect(1) }],
        },
      ],
    };
    const input = join(root, "plan.json"), output = join(root, "report");
    await writeFile(input, JSON.stringify(plan));
    await assert.rejects(run(process.execPath, [cli, "verify", input, output]), { code: 1 });
    const report = JSON.parse(await readFile(join(output, "verify.json"), "utf8"));
    assert.deepEqual(report.summary, { planned: 4, evaluated: 3, passed: 2, failed: 1, blocked: 1, coveragePercent: 75 });
    assert.deepEqual(report.sections[0].states.map(({ status }) => status), ["passed", "failed", "passed"]);
    const [idle, hover, leave] = report.sections[0].states;
    assert.equal(idle.frames[0].changedPercent, 0);
    assert.equal(leave.frames[0].visual, 100);
    assert.notEqual(idle.frames[0].reference.scroll.y, idle.frames[0].candidate.scroll.y);
    assert.deepEqual(hover.frames.map(({ atMs }) => atMs), [100, 400]);
    assert.ok(hover.frames.every((frame) => frame.changedPercent > 0 && frame.reference.assertions[0].passed &&
      !frame.candidate.assertions[0].passed));
    assert.equal(hover.frames[0].reference.animations[0].durationMs, 2000);
    assert.equal(hover.frames[0].reference.animations[0].keyframes.length, 2);
    const diff = decodeScreenshot(await readFile(join(output, hover.frames[0].diff)));
    assert.deepEqual([diff.width, diff.height], [160, 100]);
    assert.match(await readFile(join(output, "verify.html"), "utf8"), /Coverage <strong>3\/4 \(75%\)/);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("A saved baseline verifies two candidate revisions after the origin closes", { timeout: 60000 }, async () => {
  function fixture(prefix, hover) {
    return `<!doctype html><style>
      body{margin:0}section{margin:20px;width:160px;height:100px;background:#eed}
      i{display:inline-block;width:40px;height:40px;background:#a21;visibility:hidden}
      ${hover ? "section:hover i{visibility:visible}" : ""}
    </style><section id="${prefix}-card"><i></i></section>
    <section id="${prefix}-footer">Footer</section>`;
  }

  const reference = createServer((_request, response) => response.end(fixture("original", true)));
  const candidate = createServer((request, response) => response.end(fixture("copy", request.url === "/fixed")));
  const root = await mkdtemp(join(tmpdir(), "pagetake-baseline-"));
  try {
    for (const server of [reference, candidate]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const referenceUrl = `http://127.0.0.1:${reference.address().port}/`;
    const candidateUrl = `http://127.0.0.1:${candidate.address().port}`;
    const expect = (visibleCount) => [{ label: "Artwork", selectors: { reference: "i", candidate: "i" }, visibleCount }];
    const plan = {
      version: 1, reference: referenceUrl, candidate: candidateUrl + "/broken",
      viewport: { width: 800, height: 600 }, minVisual: 95, maxTimingDeltaMs: 500,
      sections: [
        {
          id: "card", selectors: { reference: "#original-card", candidate: "#copy-card" },
          states: [
            { id: "default", action: "idle", framesMs: [100], expect: expect(0) },
            { id: "hover", action: "hover", framesMs: [100, 400], expect: expect(1) },
            { id: "leave", action: "leave", framesMs: [100], expect: expect(0) },
          ],
        },
        {
          id: "footer", selectors: { reference: "#original-footer", candidate: "#copy-footer" },
          states: [{ id: "default", action: "idle", framesMs: [100] }],
        },
      ],
    };
    const baseline = join(root, "baseline");
    const input = join(root, "plan.json");
    const baselinePlan = structuredClone(plan);
    delete baselinePlan.candidate;
    for (const section of baselinePlan.sections) {
      delete section.selectors.candidate;
      for (const state of section.states) for (const entry of state.expect ?? []) delete entry.selectors.candidate;
    }
    await writeFile(input, JSON.stringify(baselinePlan));
    await run(process.execPath, [cli, "baseline", input, baseline], { cwd: root });
    await new Promise((resolve) => reference.close(resolve));
    await assert.rejects(fetch(referenceUrl), (error) => error.cause?.code === "ECONNREFUSED");
    const manifest = join(baseline, "baseline.json");
    const originalManifest = await readFile(manifest, "utf8");
    const stored = JSON.parse(originalManifest);
    assert.equal(stored.reference, referenceUrl);
    assert.match(stored.environment.browser, /Chrome\//);
    assert.equal(stored.environment.headless, true);
    assert.match(stored.sections[0].states[1].frames[0].sha256, /^[a-f0-9]{64}$/);

    for (const [revision, expected] of [["broken", ["passed", "failed", "passed"]], ["fixed", ["passed", "passed", "passed"]]]) {
      const output = join(root, revision);
      await writeFile(input, JSON.stringify({ ...plan, candidate: candidateUrl + "/" + revision }));
      const command = run(process.execPath, [cli, "verify", "plan.json", revision, "--baseline", "baseline"], { cwd: root });
      if (revision === "broken") await assert.rejects(command, { code: 1 });
      else await command;
      const report = JSON.parse(await readFile(join(output, "verify.json"), "utf8"));
      assert.deepEqual(report.sections[0].states.map((state) => state.status), expected);
      assert.equal(report.sections[1].states[0].status, "passed");
      assert.equal(report.summary.coveragePercent, 100);
      assert.equal(report.baseline.id, stored.id);
      assert.equal(report.baseline.type, "saved");
      assert.equal(report.baseline.capturedAt, stored.capturedAt);
      assert.deepEqual(report.environment.differences, []);
      for (const section of report.sections) for (const state of section.states) for (const frame of state.frames) {
        await Promise.all([frame.reference.file, frame.candidate.file, frame.diff].map((file) => readFile(join(output, file))));
      }
      assert.match(await readFile(join(output, "verify.html"), "utf8"), /Saved baseline.*Browser environment/s);
    }
    assert.equal(await readFile(manifest, "utf8"), originalManifest);

    // A fixture mismatch exercises the reporting path without requiring a second Chrome installation in CI.
    stored.environment.browser = "Chrome/0.0.0.0";
    await writeFile(manifest, JSON.stringify(stored));
    await rm(join(baseline, stored.sections[0].states[1].frames[0].file));
    await writeFile(input, JSON.stringify({ ...plan, candidate: candidateUrl + "/fixed" }));
    const output = join(root, "missing-frame");
    await assert.rejects(run(process.execPath, [cli, "verify", input, output, "--baseline=" + baseline]), { code: 1 });
    const incomplete = JSON.parse(await readFile(join(output, "verify.json"), "utf8"));
    assert.deepEqual(incomplete.environment.differences, [{
      field: "browser", reference: "Chrome/0.0.0.0", candidate: incomplete.environment.candidate.browser,
    }]);
    assert.equal(incomplete.summary.blocked, 1);
    assert.equal(incomplete.sections[0].states[1].status, "blocked");
    assert.match(incomplete.sections[0].states[1].frames[0].reasons[0], /screenshot is unavailable/);
  } finally {
    for (const server of [reference, candidate]) if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
