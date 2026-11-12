import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { scoreCaptures } from "./score.mjs";
import { evidenceFrame } from "../export/evidence.mjs";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function frame(label, folder, sample, output) {
  if (!sample || !evidenceFrame.test(sample.screenshot ?? "")) {
    return `<figure><figcaption>${label}</figcaption><p>Screenshot unavailable</p></figure>`;
  }
  const source = relative(dirname(output), join(folder, sample.screenshot))
    .split(/[\\/]/)
    .map(encodeURIComponent)
    .join("/");
  const animations = sample.animations?.length ?? 0;
  return `<figure><figcaption>${label} · ${escapeHtml(sample.elapsedMs)} ms · animations ${animations} · Canvas ${escapeHtml(sample.canvases)}</figcaption>
    <img src="${escapeHtml(source)}" alt="${label} screenshot" loading="lazy"></figure>`;
}

function frameScore(frame) {
  if (!frame || frame.reason) return escapeHtml(frame?.reason ?? "Reference frame missing");
  return `Visual ${frame.visual} · Pixel ${frame.pixel} · Structure ${frame.structural} · Motion ${frame.motion ?? "unscored"}`;
}

export async function compareCaptures(recording, replay, requestedOutput) {
  const recordingDir = resolve(recording);
  const replayDir = resolve(replay);
  const output = resolve(requestedOutput ?? join(replayDir, "compare.html"));
  const [original, playback] = await Promise.all([
    readFile(join(recordingDir, "manifest.json"), "utf8").then(JSON.parse),
    readFile(join(replayDir, "report.json"), "utf8").then(JSON.parse),
  ]);
  const scores = await scoreCaptures(recordingDir, replayDir, original.samples, playback.samples);
  const groups = Array.from({ length: Math.max(original.samples.length, playback.samples.length) }, (_, index) =>
    `<section><h2>Sample ${index + 1}</h2><p>${frameScore(scores.frames[index])}</p><div class="pair">
      ${frame("Reference", recordingDir, original.samples[index], output)}
      ${frame("Candidate", replayDir, playback.samples[index], output)}
    </div></section>`,
  );
  const actionScores = [];
  const actionGroups = [];
  for (const [index, action] of (original.actions ?? []).entries()) {
    const candidate = playback.actions?.[index];
    const matched = candidate && ["type", "selector", "durationMs"].every((key) => candidate[key] === action[key]);
    const label = `Action ${index + 1} · ${escapeHtml(action.type)} ${escapeHtml(action.selector)}`;
    if (!matched || action.error || candidate.error) {
      const reason = action.error ?? (matched ? candidate.error : "Matching candidate action missing");
      actionScores.push({ index: index + 1, reason });
      actionGroups.push(`<section><h2>${label}</h2><p>${escapeHtml(reason)}</p></section>`);
      continue;
    }
    const aligned = action.frames.map(({ phase }) => candidate.frames.find((frame) => frame.phase === phase));
    const actionScore = await scoreCaptures(recordingDir, replayDir, action.frames, aligned);
    actionScores.push({ index: index + 1, ...actionScore });
    actionGroups.push(`<section><h2>${label}</h2>${action.frames.map((sample, frameIndex) =>
      `<h3>${sample.phase === "before" ? "Before" : escapeHtml(sample.phase) + "%"} · ${frameScore(actionScore.frames[frameIndex])}</h3>
      <div class="pair">${frame("Reference", recordingDir, sample, output)}${frame("Candidate", replayDir, aligned[frameIndex], output)}</div>`,
    ).join("")}</section>`);
  }
  const network = playback.network;
  await writeFile(output, `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PageTake comparison</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#161616;color:#f1f1f1;font:16px/1.5 system-ui,sans-serif}
    main{max-width:1500px;margin:auto;padding:24px}
    h1,h2{margin:0 0 12px} h2{font-size:20px}
    p,figcaption{color:#c0c0c0;overflow-wrap:anywhere}
    section{margin:32px 0}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    figure{margin:0}figcaption{margin-bottom:8px}img{display:block;width:100%;height:auto;border:1px solid #454545;border-radius:8px}
    @media(max-width:700px){.pair{grid-template-columns:1fr}}
  </style></head><body><main>
  <h1>PageTake comparison</h1>
  <p>${escapeHtml(original.url)}</p>
  <p>Visual ${scores.visual ?? "unscored"} / 100 · Motion ${scores.motion ?? "unscored"} / 100 · comparable ${scores.comparable} / ${scores.total} frames</p>
  ${network ? `<p>Requests served: ${escapeHtml(network.served)}. Missing: ${escapeHtml(network.missing)}. Blocked: ${escapeHtml(network.blocked)}.</p>` : ""}
  <p>Compare screenshots in sample order. Video and animation clocks may differ.</p>
  ${groups.join("\n")}
  ${actionGroups.join("\n")}
  </main></body></html>`, { flag: "wx" });
  await writeFile(output + ".json", JSON.stringify({ ...scores, ...(actionScores.length ? { actions: actionScores } : {}) }, null, 2), { flag: "wx" });
  return output;
}
