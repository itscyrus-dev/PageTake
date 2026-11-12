import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareScreenshots, decodeScreenshot } from "./score.mjs";
import { escapeHtml } from "./compare.mjs";
import { encodeRegionPng } from "./region-image.mjs";
import { resolveLayerFiles, resolveReferenceAssets } from "./verify-assets.mjs";

function align(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const { channels } = image;
  const pixels = Buffer.alloc(width * height * channels);
  const stride = image.width * channels;
  for (let y = 0; y < image.height; y++) {
    image.pixels.copy(pixels, y * width * channels, y * stride, (y + 1) * stride);
  }
  return { width, height, channels, pixels };
}

async function compareRegion(output, reference, candidate, file) {
  const read = async (frame) => decodeScreenshot(await readFile(join(output, frame.file)));
  const [a, b] = await Promise.all([read(reference), read(candidate)]);
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const first = align(a, width, height), second = align(b, width, height);
  const stride = 1 + width * 3;
  const rows = Buffer.alloc(stride * height);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inA = x < a.width && y < a.height, inB = x < b.width && y < b.height;
      if (!inA && !inB) continue;
      const index = y * width + x;
      const color = index * first.channels, other = index * second.channels;
      const delta = Math.max(
        Math.abs(first.pixels[color] - second.pixels[other]),
        Math.abs(first.pixels[color + 1] - second.pixels[other + 1]),
        Math.abs(first.pixels[color + 2] - second.pixels[other + 2]),
      );
      const position = y * stride + 1 + x * 3;
      if (!inA || !inB || delta > 24) {
        changed++;
        rows[position] = 255;
        rows[position + 1] = inA && inB ? 50 : 170;
        rows[position + 2] = inA && inB ? 115 : 45;
      } else {
        const gray = Math.round((first.pixels[color] + first.pixels[color + 1] + first.pixels[color + 2]) / 12);
        rows.fill(gray, position, position + 3);
      }
    }
  }
  await writeFile(join(output, file), encodeRegionPng(width, height, 3, rows));
  const pixels = a.width * a.height + b.width * b.height - Math.min(a.width, b.width) * Math.min(a.height, b.height);
  return {
    ...compareScreenshots(first, second), diff: file, changedPercent: Math.round(changed / pixels * 1000) / 10,
    sizeDelta: { width: b.width - a.width, height: b.height - a.height },
  };
}

function timingError(frame, plan) {
  return Math.abs(frame.elapsedMs - frame.atMs) > plan.maxTimingDeltaMs;
}

function assertionErrors(frame) {
  return frame.assertions.filter(({ passed }) => !passed).map(({ label, expected, actual }) =>
    `${label}: expected ${expected} visible, found ${actual}`);
}

export function referenceFrameIssues(frame, plan) {
  if (frame.error) return [frame.error];
  const issues = assertionErrors(frame);
  if (timingError(frame, plan)) issues.push("Reference missed its sampling time");
  return issues;
}

async function compareFrame(plan, output, a, b, name) {
  const result = { atMs: a.atMs, reference: a, candidate: b };
  const baseline = referenceFrameIssues(a, plan);
  if (a.file && b.file) Object.assign(result, await compareRegion(output, a, b, name));
  if (baseline.length) return { ...result, status: "blocked", reasons: baseline };
  if (b.error) return { ...result, status: "failed", reasons: [b.error] };
  const reasons = assertionErrors(b);
  if (timingError(b, plan)) reasons.push("Candidate missed its sampling time");
  if (result.visual < plan.minVisual) reasons.push(`Visual score is below ${plan.minVisual}`);
  if (Object.values(result.sizeDelta).some((delta) => Math.abs(delta) > plan.maxSizeDelta)) {
    reasons.push(`Section size differs by more than ${plan.maxSizeDelta} CSS px`);
  }
  return { ...result, status: reasons.length ? "failed" : "passed", reasons };
}

function image(label, file) {
  return `<figure><figcaption>${label}</figcaption>${file
    ? `<img src="${escapeHtml(file)}" alt="${label}" loading="lazy">`
    : "<p>Unavailable</p>"}</figure>`;
}

function renderObservations(label, frame) {
  const animations = frame.animations ?? [];
  const assertions = frame.assertions ?? [];
  if (!assertions.length && !animations.length) return "";
  return `<details><summary>${label} observations</summary><ul>
    ${assertions.map((item) => `<li>${escapeHtml(item.label)} · ${item.actual}/${item.expected} visible · ${item.passed ? "passed" : "failed"}</li>`).join("")}
    ${animations.map((item) => `<li>${escapeHtml(item.name ?? "Web Animation")} · ${escapeHtml(item.target ?? "target")} · ${escapeHtml(item.durationMs ?? "unknown")} ms · ${escapeHtml(item.playState)}</li>`).join("")}
  </ul></details>`;
}

function renderState(state) {
  const reasons = (items) => items.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
  return `<article><h3>${escapeHtml(state.id)} · ${state.action} · <strong class="${state.status}">${state.status}</strong></h3>
    ${state.reasons.length ? `<ul>${reasons(state.reasons)}</ul>` : ""}
    ${state.frames.map((frame) => `<div class="frame">
      <h4>${frame.atMs} ms · <strong class="${frame.status}">${frame.status}</strong></h4>
      ${frame.diff ? `<p>Visual ${frame.visual}/100 · Changed pixels ${frame.changedPercent}% · Size delta ${frame.sizeDelta.width} × ${frame.sizeDelta.height} CSS px</p>` : ""}
      <p>Actual timing · reference ${frame.reference.elapsedMs ?? "unavailable"} · candidate ${frame.candidate.elapsedMs ?? "unavailable"} ms</p>
      ${frame.reasons.length ? `<ul>${reasons(frame.reasons)}</ul>` : ""}
      ${renderObservations("Reference", frame.reference)}${renderObservations("Candidate", frame.candidate)}
      <div class="images">${image("Reference", frame.reference.file)}${image("Candidate", frame.candidate.file)}${image("Difference", frame.diff)}</div>
    </div>`).join("")}</article>`;
}

const environmentFields = {
  browser: "Chrome", platform: "Platform", osRelease: "OS release", architecture: "Architecture",
  headless: "Headless", width: "Viewport width", height: "Viewport height",
  devicePixelRatio: "Device pixel ratio", reducedMotion: "Reduced motion",
};

function describeEnvironment(reference, candidate) {
  const differences = [];
  const rows = Object.entries(environmentFields).map(([field, label]) => {
    const a = reference[field], b = candidate[field];
    const changed = a !== b;
    if (changed) differences.push({ field, reference: a, candidate: b });
    return `<tr><th scope="row">${label}</th><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td><td>${changed ? "Different" : "Match"}</td></tr>`;
  }).join("");
  return { differences, rows };
}

export async function writeVerificationReport(plan, output, reference, candidate, sourceExport) {
  const sections = [];
  const summary = { planned: 0, evaluated: 0, passed: 0, failed: 0, blocked: 0 };
  for (const [i, section] of plan.sections.entries()) {
    const states = [];
    const layerFiles = await resolveLayerFiles(section.layers, sourceExport);
    sections.push({ id: section.id, selectors: section.selectors, layerFiles, states });
    for (const [j, state] of section.states.entries()) {
      const a = reference.sections[i][j], b = candidate.sections[i][j];
      const frames = [];
      const reasons = [a.error && `Reference: ${a.error}`, b.error && `Candidate: ${b.error}`].filter(Boolean);
      for (const [k, atMs] of state.framesMs.entries()) {
        const referenceFrame = resolveReferenceAssets(a.frames[k] ?? { atMs, error: a.error }, sourceExport);
        frames.push(await compareFrame(plan, output, referenceFrame, b.frames[k] ?? { atMs, error: b.error },
          `diff-${i + 1}-${j + 1}-${k + 1}.png`));
      }
      const status = frames.some((frame) => frame.status === "blocked") ? "blocked"
        : frames.some((frame) => frame.status === "failed") ? "failed" : "passed";
      states.push({ id: state.id, action: state.action, target: state.target, expect: state.expect, status, reasons, frames });
      summary[status]++;
      summary.planned++;
    }
  }
  summary.evaluated = summary.passed + summary.failed;
  summary.coveragePercent = Math.round(summary.evaluated / summary.planned * 1000) / 10;
  const { reference: referenceUrl, candidate: candidateUrl, viewport, minVisual, maxSizeDelta, maxTimingDeltaMs } = plan;
  const { differences, rows } = describeEnvironment(reference.environment, candidate.environment);
  const baseline = { ...reference.source, capturedAt: reference.capturedAt };
  const report = { version: 1, reference: referenceUrl, candidate: candidateUrl, viewport, minVisual, maxSizeDelta,
    maxTimingDeltaMs, reducedMotion: plan.reducedMotion, baseline,
    environment: { reference: reference.environment, candidate: candidate.environment, differences },
    candidateCapturedAt: candidate.capturedAt, planFile: "verify-plan.json",
    sourceAssets: sourceExport?.manifest, summary, sections };
  const source = baseline.type === "saved"
    ? `Saved baseline · ${escapeHtml(baseline.id)} · ${escapeHtml(baseline.manifest)}`
    : "Live reference";
  await writeFile(join(output, report.planFile), JSON.stringify(plan, null, 2) + "\n");
  await writeFile(join(output, "verify.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(output, "verify.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>PageTake verification</title>
    <style>
      *{box-sizing:border-box}body{margin:0;background:#151515;color:#f4f4f4;font:16px/1.5 system-ui,sans-serif}
      a{color:#a8d4ff}main{max-width:1500px;margin:auto;padding:24px}h1,h2,h3,h4,p{margin:0 0 12px}article,.frame{margin:18px 0;padding:16px;border:1px solid #474747;border-radius:8px}
      .images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}figure{margin:0}details{margin-bottom:8px}summary{cursor:pointer}img{display:block;max-width:100%;height:auto;margin-top:6px}
      table{border-collapse:collapse;margin:8px 0}th,td{text-align:left;padding:4px 12px;border-bottom:1px solid #474747}
      .passed{color:#80e2a2}.failed{color:#ff9bb6}.blocked{color:#ffd275}p,li{overflow-wrap:anywhere}
      @media(max-width:650px){.images{grid-template-columns:1fr}}
    </style></head><body><main>
    <h1>PageTake verification</h1>
    <p><a href="repair.md">Repair checklist</a> · <a href="verify-plan.json">Verification plan</a></p>
    <p>Reference · ${escapeHtml(referenceUrl)}<br>Candidate · ${escapeHtml(candidateUrl)}</p>
    <p>Baseline source · ${source}<br>Reference captured · ${escapeHtml(reference.capturedAt)}<br>Candidate captured · ${escapeHtml(candidate.capturedAt)}</p>
    <details${differences.length ? " open" : ""}><summary>Browser environment · ${differences.length} differences</summary>
      <table><thead><tr><th>Field</th><th>Reference</th><th>Candidate</th><th>Comparison</th></tr></thead><tbody>${rows}</tbody></table>
    </details>
    <p>Viewport ${viewport.width} × ${viewport.height} · 1× · Visual ≥ ${minVisual} · Size tolerance ${maxSizeDelta} CSS px · Timing tolerance ${maxTimingDeltaMs} ms</p>
    <p>Coverage <strong>${summary.evaluated}/${summary.planned} (${summary.coveragePercent}%)</strong> · ${summary.passed} passed · ${summary.failed} failed · ${summary.blocked} blocked</p>
    <p>Pink marks a color channel difference above 24. Amber marks pixels outside one crop. Blocked states lack a valid reference.</p>
    ${sections.map((section) => `<section><h2>${escapeHtml(section.id)}</h2>${section.states.map(renderState).join("")}</section>`).join("")}
    </main></body></html>`);
  return summary;
}
