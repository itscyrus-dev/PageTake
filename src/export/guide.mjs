import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse } from "parse5";

const skipped = new Set(["script", "style", "noscript", "template", "svg", "iframe"]);
const landmarks = new Set(["header", "nav", "main", "section", "article", "aside", "footer"]);
const elements = new Set(["form", "button", "a", "label", "input", "textarea", "select", "img", "picture", "video", "canvas"]);
const outline = /^h[12]$/;
const heading = /^h[1-6]$/;
const roles = new Set(["tab", "tablist", "tabpanel", "button", "dialog"]);

function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value ?? "";
}

function ignored(node) {
  return skipped.has(node.tagName) || node.attrs?.some(({ name }) => name === "hidden");
}

function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (ignored(node)) continue;
    yield node;
    for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index--) {
      stack.push(node.childNodes[index]);
    }
  }
}

function clean(value, limit = 100) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function textOf(node) {
  let text = "";
  for (const child of walk(node)) {
    if (child.nodeName === "#text") text += child.value;
    if (text.length >= 200) break;
  }
  return clean(text);
}

function inline(value) {
  return String(value).replace(/[&<>]/g, (letter) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[letter])
    .replace(/[\\`*_[\]|]/g, "\\$&");
}

function label(node) {
  return clean(attribute(node, "aria-label") || attribute(node, "alt") || attribute(node, "placeholder")) ||
    (node.tagName === "video" || node.tagName === "canvas" ? "" : textOf(node));
}

function topSections(root) {
  const sections = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (ignored(node)) continue;
    if (node !== root && ["section", "article"].includes(node.tagName)) {
      sections.push(node);
      continue;
    }
    for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index--) {
      stack.push(node.childNodes[index]);
    }
  }
  return sections;
}

function splitByHeading(nodes) {
  const groups = [];
  for (const node of nodes) {
    if (!groups.length || outline.test(node.tagName)) groups.push([]);
    groups.at(-1).push(node);
  }
  return groups.filter((group) => group.some((node) => heading.test(node.tagName) || elements.has(node.tagName) || node.nodeName === "#text" && clean(node.value)));
}

function sectionsFrom(document) {
  const body = [...walk(document)].find((node) => node.tagName === "body");
  const all = [...walk(body)];
  const main = all.find((node) => node.tagName === "main" || attribute(node, "role") === "main");
  const header = all.find((node) => node.tagName === "header") ?? all.find((node) => node.tagName === "nav");
  const footer = all.find((node) => node.tagName === "footer");
  const root = main ?? body;
  const regions = new Map(topSections(root).map((node) => [node, [...walk(node)]]));
  const groups = [];
  let pending = [];
  for (const node of walk(root)) {
    if (node === header || node === footer) continue;
    if (regions.has(node)) {
      groups.push(...splitByHeading(pending), regions.get(node));
      pending = [];
      continue;
    }
    if (ancestorIn(node, [header, footer], regions)) continue;
    pending.push(node);
  }
  groups.push(...splitByHeading(pending));
  const outlineNodes = all.filter((node) => outline.test(node.tagName));
  return {
    outlineNodes,
    groups: [
      ...(header ? [{ nodes: [...walk(header)], kind: "Header" }] : []),
      ...groups.map((nodes) => ({ nodes, kind: "Content" })),
      ...(footer ? [{ nodes: [...walk(footer)], kind: "Footer" }] : []),
    ].slice(0, 40),
  };
}

function ancestorIn(node, excluded, regions) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (excluded.includes(parent) || regions.has(parent)) return true;
  }
  return false;
}

function nameSections(groups) {
  const used = new Set();
  return groups.map(({ nodes, kind }, index) => {
    const headings = nodes.filter((node) => heading.test(node.tagName) && textOf(node));
    const first = headings[0];
    const title = first && kind === "Content" ? textOf(first) : kind;
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 55).replace(/-$/, "");
    const suffix = first?.tagName === "h1" ? "hero" : slug || "section";
    const name = used.has(suffix) ? `${index + 1}-${suffix}` : suffix;
    used.add(name);
    return { nodes, headings, title, kind, file: `${String(index + 1).padStart(2, "0")}-${name}.md` };
  });
}

function describeStructure(section) {
  const descriptions = [];
  const seen = new Set();
  const depths = new Map();
  for (const node of section.nodes) {
    const tag = node.tagName;
    const role = attribute(node, "role");
    if (!heading.test(tag) && !landmarks.has(tag) && !elements.has(tag) && !roles.has(role)) continue;
    const attributes = ["type", "role", "aria-selected", "aria-expanded"].flatMap((key) => {
      const value = clean(attribute(node, key), 32);
      return value ? [`${key}=${value}`] : [];
    });
    const name = landmarks.has(tag) || roles.has(role) && role !== "tab" && role !== "button"
      ? clean(attribute(node, "aria-label")) : label(node);
    let parent = node.parentNode;
    while (parent && !depths.has(parent)) parent = parent.parentNode;
    const depth = parent ? depths.get(parent) + 1 : 0;
    depths.set(node, depth);
    const line = `${"  ".repeat(Math.min(5, depth))}- ${inline([tag, ...attributes].join(" "))}${name ? ` · ${inline(name)}` : ""}`;
    if (seen.has(line)) continue;
    seen.add(line);
    descriptions.push(line);
  }
  return descriptions.slice(0, 36);
}

function assetMap(routes) {
  return new Map(routes.filter(({ file, type }) => file?.startsWith("resources/") && /^(image|video|audio)\//.test(type)).map((entry) => [entry.route, entry]));
}

function assetsFor(nodes, assets, pageUrl) {
  const result = new Map();
  for (const node of nodes) {
    const candidates = ["src", "poster"].map((name) => attribute(node, name));
    candidates.push(...attribute(node, "srcset").split(/,\s+/).map((part) => part.trim().split(/\s+/)[0]));
    for (const candidate of candidates) {
      if (!candidate) continue;
      const url = URL.parse(candidate, pageUrl);
      if (!url || !["http:", "https:"].includes(url.protocol)) continue;
      const entry = assets.get(candidate) ?? (url.origin === pageUrl.origin ? assets.get(url.pathname + url.search) : null);
      if (entry) result.set(entry.file, entry.type.startsWith("video/") ? 0 : entry.type.startsWith("image/svg") ? 2 : 1);
    }
  }
  return [...result.entries()].sort((first, second) => first[1] - second[1]).slice(0, 18).map(([file]) => file);
}

function sectionMeasurements(section, outlineNodes, sample) {
  return section.headings.flatMap((node) => {
    if (!outline.test(node.tagName)) return [];
    const tag = node.tagName.toUpperCase();
    const rows = (sample.layout ?? []).filter((row) => row.tag === tag);
    const explicit = rows.find((row) => row.label === textOf(node));
    const expected = outlineNodes.filter((item) => item.tagName === node.tagName);
    const row = explicit ?? (rows.length === expected.length ? rows[expected.indexOf(node)] : undefined);
    return row?.box?.length === 4 ? [{ ...row, matchedBy: explicit ? "text" : "heading order" }] : [];
  });
}

function screenshotLink(folder, recording, sample) {
  if (!/^frame-\d+\.png$/.test(sample.screenshot ?? "")) return "Screenshot unavailable";
  const path = relative(folder, join(recording, sample.screenshot));
  const target = path.split("/").map(encodeURIComponent).join("/");
  return `[${sample.screenshot}](${target})`;
}

function sampleLine(folder, recording, sample) {
  return `${screenshotLink(folder, recording, sample)} · ${sample.elapsedMs} ms · scroll Y ${sample.scrollY} px · ${sample.viewport?.join(" × ") ?? "dimensions unavailable"}`;
}

function animationLines(samples, names) {
  const seen = new Set();
  return samples.flatMap((sample) => (sample.animations ?? []).flatMap((animation) => {
    if (names && !names.has(animation.section)) return [];
    const key = JSON.stringify([animation.name, animation.duration, animation.easing, animation.delay, animation.iterations]);
    if (!animation.name || seen.has(key)) return [];
    seen.add(key);
    return [`- ${inline(clean(animation.name))} · ${typeof animation.duration === "number" ? animation.duration + " ms" : "duration unavailable"}${animation.easing ? ` · ${inline(animation.easing)}` : ""}${animation.delay ? ` · delay ${animation.delay} ms` : ""}`];
  })).slice(0, 24);
}

function sectionGuide(section, next, evidence) {
  const { samples, outlineNodes, folder, recording, assets, pageUrl, motion } = evidence;
  const structure = describeStructure(section);
  const files = assetsFor(section.nodes, assets, pageUrl);
  const measurements = samples.map((sample) => sectionMeasurements(section, outlineNodes, sample));
  const previews = samples.filter((sample, index) => {
    const row = measurements[index][0];
    if (!row || !sample.viewport?.[1]) return false;
    const nextRow = next ? sectionMeasurements(next, outlineNodes, sample)[0] : null;
    return row.box[1] < sample.viewport[1] && (nextRow ? nextRow.box[1] > 0 : row.box[1] + row.box[3] > 0);
  }).slice(0, 4);
  const headings = new Set(section.headings.map(textOf));
  const animations = animationLines(samples, headings);
  const motionTargets = (motion?.animations ?? []).filter(({ target }) => headings.has(target.section)).slice(0, 8);
  const stateTargets = (motion?.components ?? []).filter(({ target, transitions }) =>
    headings.has(target.section) && transitions.length > 1).slice(0, 8);
  const layout = (previews[0]?.layout ?? []).filter((row) => headings.has(row.section) && row.css).slice(0, 10);
  const measured = measurements.findIndex((rows) => rows.length);
  return [
    `# ${inline(section.title)}`, "", "[Back to page map](page.md)", "",
    "## DOM outline", "", ...(structure.length ? structure : ["The entry document has no extractable semantic elements."]), "",
    "## Layout and assets", "",
    ...(measured >= 0 ? [
      `Heading measurements come from ${sampleLine(folder, recording, samples[measured])}. Values are viewport x / y / width / height.`, "",
      ...measurements[measured].map((row) => `- ${row.tag} · ${row.box.join(" / ")} px · font size ${row.fontSize} · border radius ${row.borderRadius} · matched by ${row.matchedBy}`),
    ] : ["Inspect computed styles in the preview when layout samples are unavailable."]), "",
    ...layout.map((row) => `- ${inline(row.tag)}${row.label ? " · " + inline(row.label) : ""} · ${row.box.join(" / ")} px · ${Object.entries(row.css).map(([property, value]) => inline(property + "=" + value)).join(" · ")}`),
    ...(layout.length ? [""] : []),
    ...(files.length ? files.map((file) => `- [${inline(file.split("/").at(-1))}](../${file})`) : ["Inspect network requests in the preview for CSS backgrounds and dynamically loaded media."]), "",
    "## Screenshots and interactions", "",
    ...(previews.length ? previews.map((sample) => `- ${sampleLine(folder, recording, sample)} (matched by nearby headings)`) : ["Find screenshots in the [page map](page.md) or locate the section in the preview."]),
    ...(animations.length ? ["", "Observed animations", "", ...animations] : []),
    ...(motionTargets.length ? ["", "Targets in the [motion manifest](../manifest/motion-manifest.json)", "",
      ...motionTargets.map(({ id, target, name }) => `- ${id} · ${inline(name || target.tag)} · ${inline(target.selector ?? "selector unavailable")}`),
    ] : []),
    ...(stateTargets.length ? ["", "State changes in the [interaction manifest](../manifest/interactions.json)", "",
      ...stateTargets.map(({ target, states }) => `- ${target.id} · ${inline(target.label || target.selector || target.tag)} · ${states.length} states`),
    ] : []),
    "", "Use the preview to inspect triggers and interaction states. Capture timing, easing, and the final state before adapting the design.", "",
  ].join("\n");
}

/** Build section guides from exported markup and available capture samples. */
export async function writeGuide(recordingPath, outputPath, { packaged = false } = {}) {
  const recording = resolve(recordingPath);
  const output = resolve(outputPath);
  const folder = join(output, "guide");
  const [html, manifest, mapping] = await Promise.all([
    readFile(join(output, "index.html"), "utf8"),
    readFile(join(recording, "manifest.json"), "utf8").then(JSON.parse),
    readFile(join(output, "routes.json"), "utf8").then(JSON.parse),
  ]);
  const document = parse(html);
  const { groups, outlineNodes } = sectionsFrom(document);
  const sections = nameSections(groups);
  const samples = (manifest.samples ?? []).filter((sample) => Number.isFinite(sample.scrollY));
  const screenshotDir = packaged ? join(output, "manifest", "frames") : recording;
  const evidence = {
    samples, outlineNodes, folder, recording: screenshotDir, assets: assetMap(mapping.routes),
    pageUrl: new URL(manifest.url), motion: packaged ? manifest.motion : undefined,
  };
  const globalMotion = animationLines(samples);
  await mkdir(folder);
  for (const [index, section] of sections.entries()) {
    await writeFile(join(folder, section.file), sectionGuide(section, sections[index + 1], evidence), { flag: "wx" });
  }
  const map = [
    "# Page map", "", "[Integration guide](../AGENTS.md)", "",
    "Choose a section to integrate. Layout and motion come from capture samples. DOM and static assets come from the entry document. Use the preview for dynamic content.", "",
    "## Sections", "",
    ...sections.map((section) => `- [${inline(section.title)}](${encodeURIComponent(section.file)})`),
    "", "## Captured screenshots", "",
    ...(samples.length ? samples.map((sample) => `- ${sampleLine(folder, screenshotDir, sample)}`) : ["This archive contains no screenshot samples."]),
    ...(packaged ? [
      "", "## Structured evidence", "",
      "- [Agent manifest](../manifest/agent.json)",
      "- [Motion timeline](../manifest/motion-manifest.json) · [Interaction states and action frames](../manifest/interactions.json) · [Computed styles and SVG geometry](../manifest/styles.json)",
      "- [Assets and media](../manifest/assets.json) · [Missing evidence](../manifest/missing.json) · [Viewport and sample positions](../manifest/page.json)",
      ...(manifest.motion?.js || manifest.motion?.canvasClip || manifest.actions?.some(({ clip, state }) => clip || state)
        ? ["- [Component state links, Canvas clips and JavaScript timeline](../manifest/evidence.html)"] : []),
      ...(!manifest.motion || manifest.motion.error ? ["", "This archive contains the original page-level samples."] : []),
    ] : []),
    "", "## Page-level motion", "",
    "These samples are deduplicated. Use the preview or manifests to check playback, triggers, and targets.", "",
    ...(globalMotion.length ? globalMotion : ["No animations were observed."]), "",
  ];
  await writeFile(join(folder, "page.md"), map.join("\n"), { flag: "wx" });
  return folder;
}
