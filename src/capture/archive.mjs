import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const maxResourceBytes = 20 * 1024 * 1024;
export const maxArchiveBytes = 300 * 1024 * 1024;
const bodylessStatus = new Set([204, 205, 304]);
const privateQuery = /^(?:access_token|token|auth|authorization|api[_-]?key|secret|sig(?:nature)?|policy|key-pair-id|x-amz-.+|x-goog-.+)$/i;
const excludedHeaders = /^(?:set-cookie2?|content-encoding|content-length|transfer-encoding|connection|keep-alive|proxy-.+|www-authenticate|report-to|nel|alt-svc)$/i;

export function publicUrl(input) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => privateQuery.test(key))) return null;
  url.hash = "";
  return url.href;
}

function header(headers, name) {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function headersForReplay(headers) {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (excludedHeaders.test(name)) return [];
    return String(value).split("\n").map((entry) => ({ name, value: entry }));
  });
}

function requestKey(url, range = "") {
  return `${url}\n${range}`;
}

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function recordNetwork(page, folder) {
  const entries = new Map();
  const requests = new Map();
  const bodies = new Set();
  const pending = new Set();
  const omissions = { privateOrNonGet: 0, unavailable: 0, budget: 0 };
  const issues = new Map();
  let issueLimitReached = false;
  let storedBytes = 0;
  const bodyDir = join(folder, "bodies");
  await mkdir(bodyDir);

  function note(request, reason, detail) {
    const key = JSON.stringify([request.url, request.range, reason, detail]);
    if (issues.has(key)) return;
    if (issues.size >= 500) {
      issueLimitReached = true;
      return;
    }
    issues.set(key, { ...request, reason, detail });
  }

  async function save(request, response, bytes) {
    if (bytes.length > maxResourceBytes || storedBytes + bytes.length > maxArchiveBytes) {
      omissions.budget++;
      note(request, "capture-budget");
      return;
    }
    const hash = digest(bytes);
    if (!bodies.has(hash)) {
      bodies.add(hash);
      storedBytes += bytes.length;
      await writeFile(join(bodyDir, hash), bytes);
    }
    entries.set(requestKey(request.url, request.range), {
      ...request,
      status: response.status,
      headers: headersForReplay(response.headers),
      body: hash,
      bytes: bytes.length,
    });
  }

  function track(task, request) {
    const tracked = task.catch(() => {
      omissions.unavailable++;
      note(request, "response-body-unavailable");
    });
    pending.add(tracked);
    void tracked.then(() => pending.delete(tracked));
  }

  const responses = new Map();
  page.on("Network.requestWillBeSent", ({ requestId, request, redirectResponse }) => {
    const previous = requests.get(requestId);
    if (previous && redirectResponse) track(save(previous, redirectResponse, Buffer.alloc(0)), previous);
    requests.delete(requestId);
    responses.delete(requestId);
    const url = publicUrl(request.url);
    if (!url || request.method !== "GET" || header(request.headers, "authorization")) {
      omissions.privateOrNonGet++;
      return;
    }
    requests.set(requestId, { url, range: header(request.headers, "range") ?? "" });
  });
  page.on("Network.responseReceived", ({ requestId, response }) => {
    const request = requests.get(requestId);
    if (!request) return;
    responses.set(requestId, response);
    if (response.status >= 400) note(request, "http-error", response.status);
  });
  page.on("Network.loadingFailed", ({ requestId, canceled }) => {
    const request = requests.get(requestId);
    if (requests.delete(requestId)) {
      omissions.unavailable++;
      note(request, canceled ? "request-canceled" : "network-error");
    }
    responses.delete(requestId);
  });
  page.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    const request = requests.get(requestId);
    const response = responses.get(requestId);
    requests.delete(requestId);
    responses.delete(requestId);
    if (!request || !response) return;
    if (encodedDataLength > maxResourceBytes || Number(header(response.headers, "content-length")) > maxResourceBytes) {
      omissions.budget++;
      note(request, "capture-budget");
      return;
    }
    if (bodylessStatus.has(response.status)) {
      track(save(request, response, Buffer.alloc(0)), request);
      return;
    }
    track(page.send("Network.getResponseBody", { requestId }).then(({ body, base64Encoded }) =>
      save(request, response, Buffer.from(body, base64Encoded ? "base64" : "utf8")),
    ), request);
  });
  return {
    async finish() {
      await Promise.allSettled([...pending]);
      for (const request of requests.values()) note(request, "pending-at-end");
      return { responses: [...entries.values()], omissions, storedBytes, networkIssues: [...issues.values()], issueLimitReached };
    },
  };
}

function mediaRange(range, bytes) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match || (!match[1] && !match[2]) || !bytes.length) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
  if (!Number.isSafeInteger(start) || start < 0 || start > end) return null;
  return { start, end };
}

export async function replayNetwork(page, folder, archive) {
  const entries = new Map(archive.responses.map((entry) => [requestKey(entry.url, entry.range), entry]));
  const statistics = { served: 0, missing: 0, blocked: 0, errors: 0 };

  async function respond({ requestId, request }) {
    const url = publicUrl(request.url);
    const method = request.method;
    if (!url || !["GET", "HEAD"].includes(method)) {
      statistics.blocked++;
      await page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      return;
    }
    const range = header(request.headers, "range") ?? "";
    const entry = entries.get(requestKey(url, range)) ?? entries.get(requestKey(url));
    if (!entry) {
      statistics.missing++;
      await page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      return;
    }
    if (!/^[a-f0-9]{64}$/.test(entry.body)) throw new Error("Invalid response digest");
    let bytes = await readFile(join(folder, "bodies", entry.body));
    if (digest(bytes) !== entry.body) throw new Error("Response body digest mismatch");
    let status = entry.status;
    let headers = entry.headers;
    if (range && status === 200) {
      const slice = mediaRange(range, bytes);
      headers = headers.filter(({ name }) => !/^content-range$/i.test(name));
      if (slice) {
        status = 206;
        headers.push({ name: "content-range", value: `bytes ${slice.start}-${slice.end}/${bytes.length}` });
        bytes = bytes.subarray(slice.start, slice.end + 1);
      } else {
        status = 416;
        headers.push({ name: "content-range", value: `bytes */${bytes.length}` });
        bytes = Buffer.alloc(0);
      }
    }
    const responseHeaders = [...headers];
    if (!bodylessStatus.has(status)) responseHeaders.push({ name: "content-length", value: String(bytes.length) });
    await page.send("Fetch.fulfillRequest", {
      requestId, responseCode: status, responseHeaders,
      body: method === "HEAD" ? "" : bytes.toString("base64"),
    });
    statistics.served++;
  }

  page.on("Fetch.requestPaused", (event) => {
    void respond(event).catch(() => {
      statistics.errors++;
      return page.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }).catch(() => {});
    });
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "http*" }] });
  return statistics;
}
