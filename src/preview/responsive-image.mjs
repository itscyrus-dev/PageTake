export function responsiveImage(url) {
  const thumbnail = /^(\?imageMogr2(?:\/[^/?&#]+)*\/thumbnail\/)([1-9]\d*)x(?=[/&]|$)/.exec(url.search);
  if (thumbnail) {
    const [match, prefix, pixels] = thumbnail;
    const width = Number(pixels);
    if (!Number.isSafeInteger(width)) return null;
    return { key: url.pathname + prefix + "{width}x" + url.search.slice(match.length), width };
  }
  if (!url.pathname.endsWith("/_next/image")) return null;
  const params = new URLSearchParams(url.searchParams);
  const width = Number(params.get("w"));
  if (!Number.isSafeInteger(width) || width < 1 || !/^\d+$/.test(params.get("w") ?? "") ||
      params.getAll("w").length !== 1 || params.getAll("url").length !== 1 || !params.get("url")) return null;
  params.delete("w");
  params.sort();
  return { key: url.pathname + "?" + params, width };
}
