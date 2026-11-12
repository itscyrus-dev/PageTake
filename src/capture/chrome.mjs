import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

class Connection {
  #socket;
  #next = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", ({ data }) => this.#receive(JSON.parse(data)));
    socket.addEventListener("close", () => {
      for (const { reject } of this.#pending.values()) reject(new Error("Chrome disconnected"));
      this.#pending.clear();
    });
  }

  #receive(message) {
    if (message.id) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    for (const callback of this.#listeners.get(message.method) ?? []) callback(message.params);
  }

  async send(method, params = {}) {
    const id = ++this.#next;
    const result = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    try {
      this.#socket.send(JSON.stringify({ id, method, params }));
      return await result;
    } finally {
      this.#pending.delete(id);
    }
  }

  on(method, callback) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(callback);
    this.#listeners.set(method, listeners);
  }

  close() {
    this.#socket.close();
  }
}

async function denyProxy() {
  // Send replay traffic to the local deny proxy.
  const server = createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  server.on("connect", (_request, socket) => {
    socket.on("error", () => socket.destroy());
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, close: () => server.close() };
}

async function findPage(profile, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("Chrome exited before opening DevTools");
    const port = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    if (port) {
      const endpoint = `http://127.0.0.1:${port.split("\n")[0]}/json/list`;
      const pages = await fetch(endpoint, { signal: AbortSignal.timeout(500) })
        .then((response) => response.json())
        .catch(() => []);
      const page = pages.find((candidate) => candidate.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools did not become available");
}

export async function launchChrome({ executable, headless, offline, width, height }) {
  const profile = await mkdtemp(join(tmpdir(), "web-replay-chrome-"));
  let proxy;
  let child;
  let connection;
  const close = async () => {
    connection?.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await Promise.race([exited, delay(2000, null, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    proxy?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  };
  try {
    if (offline) proxy = await denyProxy();
    const args = [
      `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
      "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
      "--disable-quic", `--window-size=${width},${height}`,
    ];
    if (headless) args.push("--headless=new");
    if (proxy) args.push(`--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>");
    child = spawn(executable, [...args, "about:blank"], { stdio: "ignore" });
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    await once(child, "spawn");
    if (spawnError) throw spawnError;
    const socket = new WebSocket(await findPage(profile, child));
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    connection = new Connection(socket);
    await connection.send("Page.enable");
    await connection.send("Network.enable", {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: 20 * 1024 * 1024,
    });
    await connection.send("Network.setBypassServiceWorker", { bypass: true });
    await connection.send("Network.setCacheDisabled", { cacheDisabled: true });
    await connection.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    return { page: connection, close };
  } catch (error) {
    await close();
    throw error;
  }
}
