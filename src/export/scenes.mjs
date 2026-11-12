import { parse as parseScript } from "acorn";
import { parse as parseHtml } from "parse5";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const scriptType = /(?:java|ecma)script/i;
const assetPath = /\.(?:avif|bmp|gif|glb|gltf|jpe?g|json|mp4|otf|png|svg|ttf|wasm|webm|webp|woff2?)(?:[?#]|$)/i;
const sceneShape = (data) => data?.options && (Array.isArray(data.history) || Array.isArray(data.layers));

function htmlEvidence(html) {
  const classes = new Set(), scripts = [], canvases = [];
  function visit(node) {
    const attrs = Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
    for (const name of (attrs.class ?? "").split(/\s+/)) if (name) classes.add(name);
    if (node.tagName === "script" && !attrs.src) scripts.push((node.childNodes ?? []).map((item) => item.value ?? "").join(""));
    if (node.tagName === "canvas") canvases.push({ id: attrs.id, className: attrs.class, width: attrs.width, height: attrs.height });
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parseHtml(html));
  return { classes, scripts, canvases };
}

function staticValue(node) {
  if (node?.type === "Literal" && ["boolean", "number", "string"].includes(typeof node.value)) return node.value;
  if (node?.type === "UnaryExpression" && ["!", "-", "+"].includes(node.operator)) {
    const value = staticValue(node.argument);
    if (value === undefined) return undefined;
    if (node.operator === "!") return !value;
    if (typeof value === "number") return node.operator === "-" ? -value : +value;
  }
  if (node?.type === "ObjectExpression") {
    return Object.fromEntries(node.properties.flatMap((property) => {
      const key = propertyName(property);
      const value = staticValue(property.value);
      return key && value !== undefined ? [[key, value]] : [];
    }));
  }
}

function propertyName(node) {
  if (node?.type !== "Property" || node.computed) return undefined;
  return node.key.name ?? node.key.value;
}

function memberName(node) {
  if (node?.type !== "MemberExpression") return undefined;
  return node.computed ? staticValue(node.property) : node.property.name;
}

function sceneCalls(source, classes) {
  if (!/unicornStudio/i.test(source) || !source.includes("addScene") || source.length > 5_000_000) return [];
  let program;
  try {
    program = parseScript(source, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
  } catch {
    return [];
  }
  const calls = [], runtimeUrls = [], functionClasses = new Map();
  const functions = [];
  function visit(node) {
    if (!node || typeof node.type !== "string") return;
    const isFunction = /Function(?:Expression|Declaration)$/.test(node.type);
    if (isFunction) functions.push(node);
    if (node.type === "Literal" && typeof node.value === "string" &&
        /unicorn[._-]?studio[^/]*\.m?js(?:\?|$)/i.test(node.value)) runtimeUrls.push(node.value);
    if (propertyName(node) === "className" && functions.length) {
      const name = staticValue(node.value) ?? memberName(node.value);
      if (typeof name === "string") {
        const className = [...classes].find((item) => item === name || item.endsWith("__" + name));
        if (className && /^[\w-]+$/.test(className)) {
          const owner = functions.at(-1);
          const values = functionClasses.get(owner) ?? new Set();
          values.add("." + className);
          functionClasses.set(owner, values);
        }
      }
    }
    if (node.type === "CallExpression" && memberName(node.callee) === "addScene" &&
        node.arguments[0]?.type === "ObjectExpression") {
      const options = staticValue(node.arguments[0]);
      const element = node.arguments[0].properties.find((property) => propertyName(property) === "element")?.value;
      const argument = staticValue(element?.arguments?.[0]);
      const method = memberName(element?.callee);
      const selector = typeof options.elementId === "string" ? "#" + options.elementId
        : typeof argument === "string" && method === "getElementById" ? "#" + argument
        : typeof argument === "string" && method === "querySelector" ? argument : undefined;
      calls.push({ options, selector, functions: [...functions].reverse() });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) for (const item of child) visit(item);
      else if (child && typeof child === "object") visit(child);
    }
    if (isFunction) functions.pop();
  }
  visit(program);
  return calls.map(({ options, selector, functions }) => ({
    options, runtimeUrls: [...new Set(runtimeUrls)], selector: selector ??
      functions.map((owner) => functionClasses.get(owner)).find((values) => values?.size === 1)?.values().next().value,
  }));
}

function assetResolver(archive, files, routes) {
  const byUrl = new Map([...files].filter(([entry]) => entry.status === 200 && !entry.range)
    .map(([entry, path]) => [entry.url, { path, url: entry.url }]));
  const byPath = new Map([...byUrl.values()].map((asset) => [asset.path, asset]));
  const byRoute = new Map(routes.filter(({ status, file, range }) => status === 200 && file && !range)
    .map(({ route, file }) => [route, byPath.get(file)]));
  return (value, base = archive.url) => {
    if (typeof value !== "string" || !URL.canParse(value, base)) return undefined;
    const address = new URL(value, base);
    address.hash = "";
    if (!["http:", "https:"].includes(address.protocol)) return undefined;
    return byUrl.get(address.href) ??
      (value.startsWith("/") && !value.startsWith("//") ? byRoute.get(address.pathname + address.search) : undefined);
  };
}

function sceneDependencies(data, sceneUrl, resolveAsset) {
  const files = new Map(), missing = new Set();
  function rewrite(value, key) {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .map(([name, entry]) => [name, rewrite(entry, name)]));
    if (typeof value !== "string" || !value || value.length > 2048 || /\s/.test(value) || /^(?:data:|#)/.test(value)) return value;
    if (!assetPath.test(value) && !/^(?:src|url|textureUrl|filePath)$/i.test(key ?? "")) return value;
    const asset = resolveAsset(value, sceneUrl);
    if (!asset?.path.startsWith("resources/")) {
      missing.add(value);
      return value;
    }
    const path = "assets/" + basename(asset.path);
    files.set(path, { path, source: asset.path, url: asset.url });
    return "./" + path + (value.includes("#") ? "#" + value.split("#").slice(1).join("#") : "");
  }
  return { scene: rewrite(data), files: [...files.values()], missing: [...missing] };
}

const unicornStudio = {
  name: "Unicorn Studio",
  runtime: /unicorn[._-]?studio[^/]*\.m?js(?:\?|$)/i,
  recognizes: (source) => /unicornStudio/i.test(source) && source.includes("addScene"),
  options: ["fps", "dpi", "scale", "interactivity", "breakpointWidth", "production"],
  calls: sceneCalls,
  accepts: sceneShape,
  supportsMount: (source) => /getElementById\([^)]*\)[\s\S]{0,120}JSON\.parse\([^)]*\.innerText/.test(source),
  mount: new URL("./scene-mount.mjs", import.meta.url),
};

const adapters = [unicornStudio];

function safeText(value) {
  return String(value).replace(/[\r\n]/g, " ").replace(/[<>&]/g, (char) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char]).replace(/[\\`*_[\]|]/g, "\\$&");
}

function sceneGuide(scenes, canvasCount) {
  const lines = ["# Animated scene integration", "",
    "Scene files and captured scripts are reference evidence. Mount the selected scene in a dedicated layer in the destination project.", ""];
  for (const scene of scenes) {
    lines.push(`## ${safeText(scene.name)}`, "", `- Engine · ${scene.engine}`, `- Evidence · ${scene.status}`);
    if (scene.selector) lines.push(`- Reference host · \`${scene.selector.replaceAll("\`", "")}\``);
    if (scene.loader) lines.push(`- Recorded loader · [source](../${scene.loader})`);
    if (scene.runtime) lines.push(`- Captured runtime · [script](../${scene.runtime})`);
    if (scene.source) lines.push(`- Captured scene · [configuration](../${scene.source})`);
    if (scene.styles?.length) lines.push(`- Host styles · ${scene.styles.map((file) => `[stylesheet](../${file})`).join(", ")}`);
    if (Object.keys(scene.options).length) lines.push("", "Observed initialization options", "", "~~~json", JSON.stringify(scene.options, null, 2), "~~~");
    if (scene.mount) {
      lines.push("", `Copy the directory \`${scene.directory}\` intact to a location served by the destination app.`,
        `Import [mount.mjs](../${scene.mount}) and call \`await mountScene(element, { signal })\` with a positioned host element.`,
        "Match its size, clipping, stacking and fallback styles to the reference. Call the returned scene's resize method when the host changes and its destroy method on unmount.",
        "Use the original reduced-motion fallback and compare the same viewport, scene phase, and pointer position.");
    }
    if (scene.dependencies.length) lines.push("", "Packaged scene dependencies", "",
      ...scene.dependencies.map(({ path, source }) => `- [${basename(source)}](../${scene.directory}/${path})`));
    if (scene.missing.length) lines.push("", "Unavailable evidence", "", ...scene.missing.map((value) => `- ${safeText(value)}`));
    lines.push("");
  }
  if (canvasCount) lines.push("## Other Canvas evidence", "",
    `The capture reports ${canvasCount} Canvas surfaces. Scene discovery covers the runtimes listed in this guide.`,
    "Inspect the [motion manifest](../manifest/motion-manifest.json) and any recorded Canvas clips for remaining surfaces.", "");
  return lines.join("\n");
}

export async function writeSceneEvidence(output, archive, files, routes) {
  const { scripts, classes, canvases } = htmlEvidence(await readFile(join(output, "index.html"), "utf8"));
  const resolveAsset = assetResolver(archive, files, routes);
  const entries = [...files].map(([entry, path]) => ({ ...entry, path }));
  const sources = scripts.map((source) => ({ source, path: "index.html" }));
  const css = [];
  for (const entry of entries) {
    const type = entry.headers.find(({ name }) => name.toLowerCase() === "content-type")?.value ?? "";
    if (scriptType.test(type) || /\.m?js$/.test(new URL(entry.url).pathname)) {
      if (entry.bytes > 5_000_000) continue;
      const source = await readFile(join(output, entry.path), "utf8");
      if (adapters.some((adapter) => adapter.recognizes(source) || adapter.runtime.test(entry.url))) {
        sources.push({ source, path: entry.path });
      }
    } else if (type.startsWith("text/css")) {
      css.push({ path: entry.path, source: await readFile(join(output, entry.path), "utf8") });
    }
  }
  const scenes = [];
  for (const adapter of adapters) {
    const runtimes = entries.filter((entry) => entry.status === 200 && !entry.range && adapter.runtime.test(entry.url));
    const seen = new Set();
    for (const { source, path: loader } of sources) {
      for (const call of adapter.calls(source, classes)) {
        const { filePath, projectId } = call.options;
        const key = filePath ?? projectId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const original = resolveAsset(filePath) ?? (projectId && entries.find(({ url }) =>
          new URL(url).pathname === "/embeds/" + projectId.split("?")[0]));
        const discovered = call.runtimeUrls.map((url) => resolveAsset(url)).filter((entry) => entry && adapter.runtime.test(entry.url));
        const runtime = discovered[0] ?? (runtimes.length === 1 ? runtimes[0] : undefined);
        const raw = original ? await readFile(join(output, original.path), "utf8") : "";
        let data;
        try { data = JSON.parse(raw); } catch { /* Keep the missing configuration in the evidence. */ }
        const options = Object.fromEntries(adapter.options.flatMap((name) => {
          const value = call.options[name] ?? data?.options?.[name];
          return value !== undefined ? [[name, value]] : [];
        }));
        const id = String(scenes.length + 1).padStart(2, "0") + "-" +
          basename(original?.path ?? "scene", ".json").replace(/[^\w-]/g, "-").slice(0, 64);
        const directory = "scenes/" + id;
        const validScene = adapter.accepts(data);
        const bundle = validScene ? sceneDependencies(data, original.url, resolveAsset) : { files: [], missing: [] };
        const missing = [...bundle.missing];
        if (!validScene) missing.push("Captured scene JSON is unavailable");
        if (!runtime) missing.push("A matching captured runtime could not be identified");
        const runtimeSource = sources.find(({ path }) => path === runtime?.path)?.source ?? "";
        if (runtime && !adapter.supportsMount(runtimeSource)) missing.push("The captured runtime has no recognized portable mount interface");
        if (validScene) {
          await mkdir(join(output, directory, "assets"), { recursive: true });
          await writeFile(join(output, directory, "scene.json"), JSON.stringify(bundle.scene, null, 2) + "\n");
          await writeFile(join(output, directory, "options.json"), JSON.stringify(options, null, 2) + "\n");
          for (const asset of bundle.files) await copyFile(join(output, asset.source), join(output, directory, asset.path));
          if (runtime) await copyFile(join(output, runtime.path), join(output, directory, "runtime.js"));
          if (!missing.length) await copyFile(adapter.mount, join(output, directory, "mount.mjs"));
        }
        scenes.push({ id, engine: adapter.name, name: data?.options?.name ?? basename(String(key)),
          status: missing.length ? "partial" : "packaged", selector: call.selector, loader,
          runtime: runtime?.path, source: original?.path, options, directory: validScene ? directory : undefined,
          mount: !missing.length ? directory + "/mount.mjs" : undefined, dependencies: bundle.files, missing,
          styles: call.selector?.startsWith(".") ? css.filter(({ source }) => source.includes(call.selector)).map(({ path }) => path) : [] });
      }
    }
  }
  const observed = archive.motion?.surfaces?.canvases ?? 0;
  const canvasCount = Math.max(canvases.length, Number.isInteger(observed) ? observed : 0);
  if (!scenes.length && !canvasCount) return null;
  await mkdir(join(output, "manifest"), { recursive: true });
  await mkdir(join(output, "guide"), { recursive: true });
  await writeFile(join(output, "manifest", "scenes.json"), JSON.stringify({ version: 1, scenes, canvases, observed }, null, 2) + "\n");
  await writeFile(join(output, "guide", "scenes.md"), sceneGuide(scenes, canvasCount));
  return { guide: "guide/scenes.md", manifest: "manifest/scenes.json", count: scenes.length };
}
