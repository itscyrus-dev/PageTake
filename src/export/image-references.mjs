import { parse } from "parse5";
import { publicUrl } from "../capture/archive.mjs";

const space = /[\t\n\f\r ]/;
const imageFile = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#]|$)/i;

function imageUrl(value, base) {
  const url = URL.parse(value.trim(), base);
  if (!url) return null;
  const href = publicUrl(url);
  // A Next.js optimizer's encoded source can also carry a signed URL.
  const inner = url.pathname.endsWith("/_next/image") && url.searchParams.get("url");
  const target = inner && URL.parse(inner, url);
  return href && (!inner || target && publicUrl(target)) ? { href, fragment: url.hash } : null;
}

function srcset(value, replace) {
  // URL tokens can contain commas, notably data URLs. A trailing comma ends a candidate.
  let start = 0, end = 0, output = "";
  while (end < value.length) {
    while (end < value.length && (space.test(value[end]) || value[end] === ",")) end++;
    const urlStart = end;
    while (end < value.length && !space.test(value[end])) end++;
    let urlEnd = end;
    while (urlEnd > urlStart && value[urlEnd - 1] === ",") urlEnd--;
    if (urlEnd === urlStart) break;
    output += value.slice(start, urlStart) + replace(value.slice(urlStart, urlEnd));
    start = urlEnd;
    if (urlEnd !== end) continue;
    let depth = 0;
    while (end < value.length) {
      const char = value[end++];
      if (char === "(") depth++;
      if (char === ")" && depth) depth--;
      if (char === "," && !depth) break;
    }
  }
  return output + value.slice(start);
}

function cssImages(source, replace) {
  // Consume comments and quoted strings before looking for CSS url() tokens.
  return source.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?<![\w-])url\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^\s()"'\\]+))\s*\)/gi,
    (match, doubleQuoted, singleQuoted, unquoted) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted;
      const next = value && imageFile.test(value) ? replace(value) : value;
      return next !== value ? `url(${JSON.stringify(next)})` : match;
    });
}

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function* elements(node) {
  if (node.tagName) yield node;
  for (const child of node.childNodes ?? []) yield* elements(child);
  if (node.content) yield* elements(node.content);
}

export function imageReferences(source, url, type, visit, routeForImage) {
  const replace = (value, base) => {
    if (!value || value.trim().startsWith("#")) return value;
    const image = imageUrl(value, base);
    if (!image) return value;
    visit?.(image.href);
    const route = routeForImage?.(image.href);
    return route ? route + image.fragment : value;
  };
  if (type.startsWith("text/css")) return cssImages(source, (value) => replace(value, url));

  const document = parse(source, { sourceCodeLocationInfo: !!routeForImage });
  const nodes = [...elements(document)];
  const baseValue = nodes.find((node) => node.tagName === "base" && node.attrs.some(({ name }) => name === "href"))
    ?.attrs.find(({ name }) => name === "href").value;
  const base = (baseValue && URL.parse(baseValue, url)?.href) || url;
  const edits = [];
  for (const node of nodes) {
    const attributes = new Map(node.attrs.map(({ name, value }) => [name, value]));
    const preload = node.tagName === "link" && attributes.get("as")?.toLowerCase() === "image" &&
      attributes.get("rel")?.toLowerCase().split(/\s+/).includes("preload");
    for (const [name, value] of attributes) {
      let next = value;
      const localize = (reference) => replace(reference, base);
      if (name === "style") next = cssImages(value, localize);
      if ((node.tagName === "img" && name === "src") || (preload && name === "href") ||
          (node.tagName === "video" && name === "poster")) next = localize(value);
      if ((["img", "source"].includes(node.tagName) && name === "srcset") || (preload && name === "imagesrcset")) {
        next = srcset(value, localize);
      }
      const location = node.sourceCodeLocation?.attrs?.[name];
      if (location && next !== value) edits.push({ ...location, value: `${name}="${escapeAttribute(next)}"` });
    }
    if (node.tagName === "style") {
      const text = node.childNodes[0];
      if (!text?.value) continue;
      const next = cssImages(text.value, (value) => replace(value, base));
      if (text.sourceCodeLocation && next !== text.value) edits.push({ ...text.sourceCodeLocation, value: next });
    }
  }
  for (const { startOffset, endOffset, value } of edits.sort((a, b) => b.startOffset - a.startOffset)) {
    source = source.slice(0, startOffset) + value + source.slice(endOffset);
  }
  return source;
}
