import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canvasClipFile } from "../capture/clips.mjs";
import { stateName } from "../capture/actions.mjs";

function header(entry, name) {
  return entry.headers.find((field) => field.name.toLowerCase() === name)?.value;
}

export const evidenceFrame = /^(?:frame-\d{2}|action-(?:[1-9]|1[0-2])-(?:before|0|25|50|75|100))\.png$/;

function mediaCoverage(entries) {
  const complete = entries.find(({ status }) => status === 200);
  if (complete) return { status: "full-response", totalBytes: complete.archiveBytes };
  const ranges = entries.map(({ contentRange, archiveBytes }) => {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
    if (!match) return null;
    const [start, end, total] = match.slice(1).map(Number);
    if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total || end - start + 1 !== archiveBytes) return null;
    return { start, end, total };
  });
  const total = ranges[0]?.total;
  if (!total || !ranges.every((range) => range?.total === total)) return { status: "unknown" };
  let coveredBytes = 0, end = -1;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    coveredBytes += Math.max(0, range.end - Math.max(end, range.start - 1));
    end = Math.max(end, range.end);
  }
  return { status: coveredBytes === total ? "all-bytes-in-ranges" : "partial", totalBytes: total, coveredBytes };
}

export async function writeEvidence(recording, output, archive, files, scenes) {
  const folder = join(output, "manifest");
  await mkdir(folder, { recursive: true });
  const motion = archive.motion;
  const write = (name, value) => writeFile(join(folder, name + ".json"), JSON.stringify({ version: 1, ...value }, null, 2));
  const actions = archive.actions ?? [];
  const startScroll = actions[0]?.frames[0]?.scrollY;
  const states = [];
  let replayable = Number.isFinite(startScroll);
  for (const [index, action] of actions.entries()) {
    replayable &&= !action.error && action.type !== "hover" && action.frames.at(-1)?.phase === 100;
    if (replayable && action.verified === true && stateName.test(action.state ?? "")) {
      states.push({
        name: action.state, viewport: archive.viewport, startScroll, expect: action.expect,
        steps: actions.slice(0, index + 1).map(({ type, selector, durationMs }) => ({ type, selector, durationMs })),
      });
    }
  }
  const clips = [];
  for (const clip of [motion?.canvasClip, ...actions.map(({ clip }) => clip)].filter(Boolean)) {
    const { file, ...info } = clip;
    const entry = { ...info };
    if (canvasClipFile.test(file ?? "")) {
      try {
        await copyFile(join(recording, file), join(folder, file));
        entry.file = file;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        entry.error = "Recorded clip file is missing";
      }
    }
    clips.push(entry);
  }
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const unavailable = actions.filter(({ state }) => stateName.test(state ?? "") && !states.some(({ name }) => name === state));
  const hasEvidenceViewer = !!(states.length || unavailable.length || clips.length || motion?.js);
  if (hasEvidenceViewer) {
    const links = states.map(({ name }) => `<li><a href="../?state=${name}">${name}</a></li>`).join("");
    const videos = clips.map((clip) => `<figure><figcaption>${escape(clip.selector)}</figcaption>${
      clip.file ? `<video controls playsinline preload="metadata" src="${clip.file}"></video>` : `<p>${escape(clip.error)}</p>`}</figure>`).join("");
    await writeFile(join(folder, "evidence.html"), `<!doctype html><html lang="en"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><title>PageTake evidence</title>
      <style>body{font:16px/1.5 system-ui;max-width:56rem;margin:2rem auto;padding:0 1rem}figure{margin:1rem 0}video{max-width:100%}</style>
      <h1>PageTake evidence</h1>
      ${links ? `<h2>Component states</h2><ul>${links}</ul>` : ""}
      ${unavailable.length ? `<p>Unavailable checkpoints: ${unavailable.map(({ state }) => state).join(", ")}.</p>` : ""}
      ${videos ? `<h2>Canvas clips</h2>${videos}` : ""}
      ${motion?.js ? '<p><a href="js-motion.json">JavaScript frame timeline</a></p>' : ""}</html>`);
  }
  const frames = [...(archive.samples ?? []), ...(archive.actions ?? []).flatMap((group) => group.frames)]
    .filter((frame) => evidenceFrame.test(frame.screenshot ?? ""));
  const copiedFrames = new Set();
  if (frames.length) {
    await mkdir(join(folder, "frames"));
    for (const { screenshot } of frames) {
      try {
        await copyFile(join(recording, screenshot), join(folder, "frames", screenshot));
        copiedFrames.add(screenshot);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  const frameData = ({ screenshot, elapsedMs, scrollY, viewport, observation, phase, error }) => ({
    frame: copiedFrames.has(screenshot) ? "frames/" + screenshot : null, elapsedMs, scrollY, viewport, observation, phase, error,
  });
  const samples = archive.samples ?? [];
  const screenshotIndex = (samples) => samples.filter(({ screenshot }) => copiedFrames.has(screenshot))
    .map(({ screenshot, elapsedMs, scrollY, viewport, phase }) => ({
      path: "manifest/frames/" + screenshot, elapsedMs, scrollY, viewport, phase,
    }));
  const pageScreenshots = screenshotIndex(samples);
  const observedPositions = samples.map(({ scrollY }) => scrollY).filter(Number.isFinite);
  const motionStatus = motion?.error ? "capture-error" : motion ? "observed" : "legacy";
  const assets = [];
  const mediaByUrl = new Map();
  const observedSources = new Set((motion?.media ?? []).map(({ source }) => source).filter(Boolean));
  for (const entry of archive.responses) {
    const type = header(entry, "content-type") ?? "application/octet-stream";
    const file = files.get(entry);
    const record = {
      url: entry.url, status: entry.status, type, requestedRange: entry.range,
      contentRange: header(entry, "content-range"), archiveSha256: entry.body, archiveBytes: entry.bytes,
      localPath: file ?? null, localBytes: file ? (await stat(join(output, file))).size : null,
    };
    assets.push(record);
    if ((observedSources.has(entry.url) || /^(?:video|audio)\//i.test(type)) && file && entry.bytes > 0) {
      if (!mediaByUrl.has(entry.url)) mediaByUrl.set(entry.url, []);
      mediaByUrl.get(entry.url).push(record);
    }
  }
  const media = (motion?.media ?? []).map((entry) => ({
    ...entry,
    localPaths: [...new Set((mediaByUrl.get(entry.source) ?? []).map((asset) => asset.localPath))],
    coverage: entry.source && mediaByUrl.has(entry.source) ? mediaCoverage(mediaByUrl.get(entry.source)) : { status: "unknown" },
  }));
  const partialMedia = [...mediaByUrl].map(([url, entries]) => ({ url, ...mediaCoverage(entries) }))
    .filter(({ status }) => ["partial", "unknown"].includes(status));
  await Promise.all([
    ...(states.length ? [write("states", { states })] : []),
    ...(clips.length ? [write("canvas-clips", { clips })] : []),
    ...(motion?.js ? [write("js-motion", {
      ...motion.js, watchedTargets: (motion.styles ?? []).filter(({ samples }) => samples.length > 1)
        .map(({ target, samples }) => ({ target, samples })),
    })] : []),
    write("page", {
      url: archive.url, viewport: archive.viewport, scroll: archive.scroll, browser: archive.browser, devicePixelRatio: archive.devicePixelRatio,
      recordedAt: archive.recordedAt, samples: (archive.samples ?? []).map(frameData),
    }),
    write("motion-manifest", {
      status: motionStatus,
      error: motion?.error, clock: motion?.clock, intervalMs: motion?.intervalMs, reducedMotion: motion?.reducedMotion,
      css: motion?.css, animations: motion?.animations ?? [], surfaces: motion?.surfaces, limitsReached: motion?.dropped,
      legacySamples: motion && !motion.error ? undefined : archive.samples?.map(({ elapsedMs, scrollY, animations }) =>
        ({ elapsedMs, scrollY, animations })),
    }),
    write("interactions", {
      clock: motion?.clock, components: motion?.components ?? [], events: motion?.events ?? [],
      scrollTrace: motion?.scrollTrace ?? [],
      actions: actions.map(({ frames, ...action }) => ({ ...action, frames: frames.map(frameData) })),
      stateLinks: states.map(({ name }) => ({ name, url: "/?state=" + name })),
    }),
    write("styles", { watchSelector: motion?.watchSelector, targets: motion?.styles ?? [] }),
    write("assets", { assets, media, repairs: archive.mediaRepairs }),
    write("missing", {
      networkDetailAvailable: Array.isArray(archive.networkIssues), omissions: archive.omissions,
      network: archive.networkIssues ?? [], networkLimitReached: archive.issueLimitReached,
      httpErrors: assets.filter(({ status }) => status >= 400).map(({ url, status }) => ({ url, status })),
      unmapped: assets.filter(({ localPath, status }) => !localPath && status < 300).map(({ url, status }) => ({ url, status })),
      partialMedia, mediaErrors: media.filter(({ errorCode }) => errorCode),
      mediaWithoutLocalBytes: media.filter(({ source, localPaths }) => source && !localPaths.length).map(({ target, source }) => ({ target, source })),
      missingFrames: [...new Set(
        frames.filter(({ screenshot }) => !copiedFrames.has(screenshot)).map(({ screenshot }) => screenshot),
      )],
    }),
    write("agent", {
      pathBase: "export-root",
      sourceUrl: archive.url,
      entrypoints: {
        instructions: "AGENTS.md", pageMap: "guide/page.md", html: "index.html", preview: "serve.mjs", routes: "routes.json",
        ...(scenes ? { sceneGuide: scenes.guide } : {}),
      },
      evidence: {
        page: "manifest/page.json", motion: "manifest/motion-manifest.json", interactions: "manifest/interactions.json",
        styles: "manifest/styles.json", assets: "manifest/assets.json", missing: "manifest/missing.json",
        ...(scenes ? { scenes: scenes.manifest } : {}),
        ...(states.length ? { states: "manifest/states.json" } : {}),
        ...(clips.length ? { canvasClips: "manifest/canvas-clips.json" } : {}),
        ...(motion?.js ? { jsMotion: "manifest/js-motion.json" } : {}),
        ...(hasEvidenceViewer ? { viewer: "manifest/evidence.html" } : {}),
      },
      coverage: {
        viewport: archive.viewport ?? null, devicePixelRatio: archive.devicePixelRatio ?? null,
        scroll: archive.scroll ?? null,
        sampledScrollY: observedPositions.length
          ? { min: Math.min(...observedPositions), max: Math.max(...observedPositions) } : null,
        pageSamples: samples.length, pageScreenshots: pageScreenshots.length,
        actions: actions.length, failedActions: actions.filter(({ error }) => error).length,
        motionStatus, reducedMotion: motion?.reducedMotion ?? null,
      },
      screenshots: {
        page: pageScreenshots,
        actions: actions.map(({ type, selector, frames, error }, index) => ({
          index: index + 1, type, selector, frames: screenshotIndex(frames), error,
        })),
      },
      verifiedStates: states.map(({ name }) => ({ name, previewQuery: "?state=" + name })),
    }),
  ]);
}
