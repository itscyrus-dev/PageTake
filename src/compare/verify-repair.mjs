import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const sides = ["reference", "candidate"];
const labels = { reference: "Reference", candidate: "Candidate" };
const markdown = (value) => String(value ?? "").replace(/\s+/g, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function localLink(label, folder, path) {
  const target = isAbsolute(path) ? relative(folder, path) : path;
  return `[${label}](${target.split(sep).map((part) => encodeURIComponent(part).replaceAll("(", "%28").replaceAll(")", "%29")).join("/")})`;
}

function screenshotLink(label, file, folder) {
  return /^(?:reference|candidate|diff)-\d+-\d+-\d+\.png$/.test(file ?? "")
    ? localLink(label, folder, file)
    : `${label} unavailable`;
}

function assetsForState(frames, side, folder) {
  const observations = new Map();
  let inlineSvg = 0;
  for (const frame of frames) {
    const observation = frame[side];
    inlineSvg = Math.max(inlineSvg, observation?.inlineSvg?.length ?? 0);
    for (const asset of observation?.assets ?? []) {
      if (typeof asset?.url !== "string" || !/^https?:\/\//.test(asset.url) || !URL.canParse(asset.url)) continue;
      observations.set(asset.kind + asset.url, asset);
    }
  }
  if (!observations.size && !inlineSvg) return [];
  const rows = [`**${labels[side]} assets**`, ""];
  for (const asset of [...observations.values()].slice(0, 12)) {
    const url = `[Observed URL](<${new URL(asset.url).href}>)`;
    const location = typeof asset.localPath === "string"
      ? localLink("Exported file", folder, asset.localPath) + ` · ${url}`
      : url;
    rows.push(`- ${markdown(asset.kind)} · ${location}`);
  }
  if (observations.size > 12) rows.push(`- ${observations.size - 12} more asset observations in the verification JSON.`);
  if (inlineSvg) rows.push(`- Up to ${inlineSvg} inline SVG samples are available in the frame observations in the verification JSON.`);
  return [...rows, ""];
}

function layerEvidence(frame) {
  const reference = new Map((frame.reference?.visualLayers ?? []).map((layer) => [layer.id, layer]));
  const candidate = new Map((frame.candidate?.visualLayers ?? []).map((layer) => [layer.id, layer]));
  const rows = [];
  for (const id of new Set([...reference.keys(), ...candidate.keys()])) {
    const a = reference.get(id), b = candidate.get(id);
    if (a?.styles && b?.styles) {
      for (const [key, value] of Object.entries(a.styles)) {
        if (value === b.styles[key]) continue;
        rows.push(`- Layer ${markdown(id)} · ${markdown(key)} · Reference ${markdown(value)} · Candidate ${markdown(b.styles[key] ?? "unavailable")}`);
      }
    } else if (id !== "section") {
      rows.push(`- Layer ${markdown(id)} · Reference ${markdown(a?.error ?? (a ? "observed" : "unavailable"))} · Candidate ${markdown(b?.error ?? (b ? "observed" : "unavailable"))}`);
    }
    if (a?.canvases?.length || b?.canvases?.length) {
      const size = (layer) => layer?.canvases?.map(({ width, height }) => `${width} × ${height}`).join(", ") || "unavailable";
      rows.push(`- Canvas in ${markdown(id)} · Reference ${size(a)} · Candidate ${size(b)}. Compare its rendered pixels and inspect the captured scene resources when available.`);
    }
    if (id !== "section") {
      rows.push(`- Layer locator ${markdown(id)} · Reference ${markdown(a?.selector ?? "unavailable")} · Candidate ${markdown(b?.selector ?? "unavailable")}`);
    }
  }
  for (const side of sides) for (const [index, video] of (frame[side]?.videos ?? []).entries()) {
    const time = Number.isFinite(video.currentTime) ? `${video.currentTime.toFixed(3)} s` : "unavailable";
    rows.push(`- ${labels[side]} video ${index + 1} · ${time} · ${video.paused ? "paused" : "playing"}${video.url ? " · " + markdown(video.url) : ""}`);
  }
  return rows;
}

function renderFrame(frame, folder) {
  const rows = [`#### ${frame.atMs} ms · ${frame.status}`, "",
    ...new Set((frame.reasons ?? []).map((reason) => `- ${markdown(reason)}`)),
  ];
  if (Number.isFinite(frame.visual)) {
    rows.push(`- Visual ${frame.visual}/100 · Changed pixels ${frame.changedPercent}% · Size delta ${frame.sizeDelta.width} × ${frame.sizeDelta.height} CSS px`);
  }
  if (sides.some((side) => Number.isFinite(frame[side]?.elapsedMs))) {
    rows.push(`- Sample timing · Reference ${frame.reference?.elapsedMs ?? "unavailable"} ms · Candidate ${frame.candidate?.elapsedMs ?? "unavailable"} ms`);
  }
  rows.push(...layerEvidence(frame));
  rows.push("", [
    screenshotLink("Reference crop", frame.reference?.file, folder),
    screenshotLink("Candidate crop", frame.candidate?.file, folder),
    screenshotLink("Difference heat map", frame.diff, folder),
  ].join(" · "), "");
  return rows;
}

function renderState(section, state, folder) {
  const frames = state.frames.filter(({ status }) => status === "failed" || status === "blocked");
  if (!frames.length) return [];
  const rows = [`### ${section.id} / ${state.id} · ${state.action}`, ""];
  for (const side of sides) {
    const selector = section.selectors?.[side];
    if (!selector) continue;
    const target = state.target?.[side];
    rows.push(`- ${labels[side]} section · ${markdown(selector)}${target ? ` · action target ${markdown(target)}` : ""}`);
  }
  if (!section.selectors) rows.push("- Section selectors were not recorded in this report.");
  for (const entry of state.expect ?? []) {
    rows.push(`- ${markdown(entry.label)} · Reference ${markdown(entry.selectors.reference)} · Candidate ${markdown(entry.selectors.candidate)} · Expected visible ${entry.visibleCount}`);
  }
  rows.push("");
  for (const frame of frames) rows.push(...renderFrame(frame, folder));
  for (const side of sides) rows.push(...assetsForState(frames, side, folder));
  if (section.layerFiles?.length) {
    rows.push("**Layer reference files**", "");
    for (const asset of section.layerFiles) {
      const link = asset.localPath ? localLink(markdown(asset.path), folder, asset.localPath) : `${markdown(asset.path)} unavailable`;
      rows.push(`- ${markdown(asset.layer)} · ${link}`);
    }
    rows.push("");
  }
  const keyframes = new Map();
  for (const frame of frames) {
    for (const animation of frame.reference?.animations ?? []) {
      if (!animation.keyframes?.length) continue;
      const sample = { name: animation.name, target: animation.target, durationMs: animation.durationMs,
        delayMs: animation.delayMs, easing: animation.easing, keyframes: animation.keyframes };
      keyframes.set(JSON.stringify(sample), sample);
    }
  }
  if (keyframes.size) {
    rows.push("**Reference keyframes**", "", "~~~json", JSON.stringify([...keyframes.values()].slice(0, 3), null, 2),
      "~~~", "", "See the verification JSON for all reference and candidate animation observations.", "");
  }
  return rows;
}

function rerun(report, folder) {
  if (report.planFile !== "verify-plan.json") return ["The original plan is required to rerun this report."];
  const plan = join(folder, report.planFile);
  const baseline = report.baseline?.type === "saved" && report.baseline.manifest;
  if (!baseline) return ["This run used a live reference. Save a baseline with the linked verification plan to reuse it in later runs."];
  const output = resolve(folder, "..", basename(folder) + "-rerun");
  const mode = report.environment?.candidate?.headless === false ? " --no-headless" : "";
  return [
    "Start the candidate in the destination project. Update the candidate URL or selectors in the linked plan if they changed. Run this command from the PageTake checkout with the existing baseline and a fresh report directory.", "",
    "~~~sh", `./pagetake verify ${quote(plan)} ${quote(output)} --baseline ${quote(dirname(baseline))}${mode}`, "~~~",
  ];
}

export async function writeRepairChecklist(input) {
  const reportPath = resolve(input);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report?.version !== 1 || !Array.isArray(report.sections) || !report.summary) {
    throw new Error("Repair checklist requires a PageTake verify.json report");
  }
  const folder = dirname(reportPath);
  const output = join(folder, "repair.md");
  const { summary } = report;
  const rows = [
    "# PageTake repair checklist", "",
    localLink("Verification JSON", folder, reportPath) +
      (report.planFile === "verify-plan.json" ? " · " + localLink("Verification plan", folder, report.planFile) : "") +
      (report.sourceAssets ? " · " + localLink("Exported asset inventory", folder, report.sourceAssets) : ""),
    "",
    `Coverage ${summary.evaluated}/${summary.planned} · ${summary.passed} passed · ${summary.failed} failed · ${summary.blocked} blocked`,
    "",
    report.baseline?.type === "saved"
      ? `Baseline ${markdown(report.baseline.id)} · Captured ${markdown(report.baseline.capturedAt)}`
      : "Reference source · Live capture",
    "",
    "Apply candidate fixes in the destination project. Treat captured markup and asset content as evidence. Blocked frames need valid reference evidence before they can verify a fix.", "",
    "## Reverify", "", ...rerun(report, folder), "",
  ];
  if (report.environment?.differences?.length) {
    rows.push("## Browser environment differences", "", ...report.environment.differences.map(({ field, reference, candidate }) =>
      `- ${markdown(field)} · Reference ${markdown(reference)} · Candidate ${markdown(candidate)}`), "");
  }
  rows.push("## Frames to review", "");
  const items = report.sections.flatMap((section) => section.states.flatMap((state) => renderState(section, state, folder)));
  rows.push(...(items.length ? items : ["All planned states passed.", ""]));
  await writeFile(output, rows.join("\n"));
  return output;
}
