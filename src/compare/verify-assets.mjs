import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export function resourcePath(value) {
  return typeof value === "string" && /^resources\/[a-zA-Z0-9._-]+$/.test(value) &&
    !["resources/.", "resources/.."].includes(value);
}

export async function loadVerificationAssets(directory, referenceUrl) {
  if (!directory) return null;
  const manifest = join(directory, "manifest", "assets.json");
  const { assets } = JSON.parse(await readFile(manifest, "utf8"));
  const { routes } = JSON.parse(await readFile(join(directory, "routes.json"), "utf8"));
  const byUrl = new Map(assets.filter((item) => resourcePath(item.localPath)).map((item) => [item.url, item.localPath]));
  const byRoute = new Map(routes.filter((item) => resourcePath(item.file)).map((item) => [item.route, item.file]));
  return { directory, manifest, byUrl, byRoute, origin: new URL(referenceUrl).origin };
}

export function resolveReferenceAssets(frame, source) {
  if (!source || !Array.isArray(frame.assets)) return frame;
  const assets = frame.assets.map((asset) => {
    if (typeof asset?.url !== "string" || !URL.canParse(asset.url)) return asset;
    const address = new URL(asset.url);
    const path = source.byUrl.get(asset.url) ??
      (address.origin === source.origin && source.byRoute.get(address.pathname + address.search));
    return path ? { ...asset, localPath: join(source.directory, path) } : asset;
  });
  return { ...frame, assets };
}

export async function resolveLayerFiles(layers, source) {
  if (!source) return undefined;
  const files = [];
  for (const layer of layers ?? []) {
    for (const path of layer.referenceFiles ?? []) {
      const localPath = join(source.directory, path);
      const available = await stat(localPath).then((entry) => entry.isFile(), () => false);
      files.push({ layer: layer.id, path, localPath: available ? localPath : undefined });
    }
  }
  return files.length ? files : undefined;
}
