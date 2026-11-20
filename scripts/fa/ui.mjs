// Браузерная проверка без зависимостей: статический сервер + headless Chrome
// по CDP. Проверяет поведение (клики, клавиатуру, мобильную ширину), а не
// только наличие элементов в HTML.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ROOT, ensureDir } from "./config.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

export function findChrome(env = process.env) {
  const candidates = [
    env.FA_CHROME_BIN,
    env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  return candidates.find((file) => existsSync(file)) || "";
}

export function startStaticServer({ root = ROOT, host = "127.0.0.1", port = 0 } = {}) {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      let file = decodeURIComponent(url.pathname);
      if (file === "/") file = "/index.html";
      const absolute = resolve(root, `.${normalize(file)}`);
      if (!absolute.startsWith(resolve(root)) || !existsSync(absolute) || !statSync(absolute).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[extname(absolute)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(readFileSync(absolute));
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error.message);
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolvePromise({
        server,
        host,
        port: address.port,
        baseUrl: `http://${host}:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

class Cdp {
  constructor(url, { timeoutMs = 30_000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message || "CDP error"} (${message.error.code})`));
        else done(message.result || {});
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket timeout")), this.timeoutMs);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket error"));
      });
    });
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error("CDP is closed"));
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // уже закрыт
    }
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForChrome(stderr, timeoutMs = 20_000) {
  const started = Date.now();
  let buffer = "";
  const timer = setInterval(() => {}, 1_000_000);
  try {
    while (Date.now() - started < timeoutMs) {
      buffer += stderr.text();
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) return match[1];
      await sleep(100);
    }
    throw new Error(`chrome did not expose DevTools in ${timeoutMs}ms${buffer ? `: ${buffer.slice(-300)}` : ""}`);
  } finally {
    clearInterval(timer);
  }
}

class Browser {
  constructor({ chrome, cdp, targetId, sessionId, server, outDir }) {
    this.chrome = chrome;
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.server = server;
    this.outDir = outDir;
    this.console = [];
    this.exceptions = [];
    this.requestsFailed = [];
  }

  static async launch({ chrome, outDir, env = process.env, timeoutMs = 30_000 }) {
    const userDataDir = join(outDir, `chrome-${process.pid}-${Date.now()}`);
    ensureDir(userDataDir);
    const stderr = { text: () => "" };
    let buffer = "";
    const child = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        "--hide-scrollbars",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: ["ignore", "ignore", "pipe"], env }
    );
    stderr.text = () => buffer;
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // уже завершён
        }
      }
    };
    try {
      const wsUrl = await waitForChrome(stderr, timeoutMs);
      const cdp = new Cdp(wsUrl, { timeoutMs });
      await cdp.open();
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const browser = new Browser({ chrome, cdp, targetId, sessionId, server: null, outDir });
      browser.child = child;
      browser.userDataDir = userDataDir;
      browser.kill = kill;
      await browser.init();
      return browser;
    } catch (error) {
      kill();
      throw error;
    }
  }

  async init() {
    const send = (method, params) => this.cdp.send(method, params, this.sessionId);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    // Внешний воркер в тестах не нужен: подменяем только его, не весь fetch.
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const realFetch = window.fetch ? window.fetch.bind(window) : null;
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input && input.url;
          if (url && /workers\\.dev|\\/api\\/feed/.test(url)) {
            return Promise.resolve(new Response(JSON.stringify({ items: [], updatedAt: new Date().toISOString() }), {
              status: 200,
              headers: { "content-type": "application/json" }
            }));
          }
          return realFetch ? realFetch(input, init) : Promise.reject(new Error("fetch is unavailable"));
        };
      })();`
    });

    this.cdp.on((message) => {
      if (message.sessionId && message.sessionId !== this.sessionId) return;
      if (message.method === "Runtime.consoleAPICalled") {
        const type = message.params.type;
        if (type === "error" || type === "assert") {
          const args = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
          this.console.push({ type, text: String(args).slice(0, 800) });
        }
      }
      if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params.exceptionDetails || {};
        this.exceptions.push({
          text: String(detail.exception?.description || detail.text || "uncaught exception").slice(0, 800)
        });
      }
      if (message.method === "Log.entryAdded") {
        const entry = message.params.entry || {};
        if (entry.level === "error") this.console.push({ type: "log", text: String(entry.text || "").slice(0, 800) });
      }
      if (message.method === "Network.loadingFailed") {
        const failure = message.params;
        if (!failure.canceled) this.requestsFailed.push({ error: failure.errorText, type: failure.type });
      }
    });
  }

  async goto(page) {
    const url = page.startsWith("http") ? page : `${this.server.baseUrl}/${page.replace(/^\//, "")}`;
    await this.cdp.send("Page.navigate", { url }, this.sessionId);
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const state = await this.evaluate("document.readyState");
      if (state === "complete") {
        await sleep(120);
        return url;
      }
      await sleep(50);
    }
    throw new Error(`page ${page} did not finish loading`);
  }

  async evaluate(expression) {
    const result = await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      this.sessionId
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || "evaluate failed");
    }
    return result.result?.value;
  }

  async setViewport(width, height) {
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: width < 600 },
      this.sessionId
    );
    await sleep(80);
  }

  async click(selector) {
    const rect = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!rect) throw new Error(`click: selector not found: ${selector}`);
    if (rect.w < 1 || rect.h < 1) throw new Error(`click: element is not visible: ${selector}`);
    const params = { x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...params }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...params }, this.sessionId);
    await sleep(60);
  }

  async press(key) {
    const codes = {
      Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
      Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
      Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
      ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
      ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
      Space: { code: "Space", windowsVirtualKeyCode: 32 }
    };
    const info = codes[key];
    if (!info) throw new Error(`unsupported key: ${key}`);
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode },
      this.sessionId
    );
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode },
      this.sessionId
    );
    await sleep(60);
  }

  async screenshot(name) {
    const safe = String(name || "screen").replace(/[^A-Za-z0-9._-]/g, "_");
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" }, this.sessionId);
    const file = join(this.outDir, `${safe}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  async close() {
    this.cdp.close();
    this.kill();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

function parseSteps(text) {
  const steps = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    steps.push(line);
  }
  return steps;
}

async function runSteps(browser, steps, state) {
  const failures = [];
  for (const line of steps) {
    const [action, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    try {
      if (action === "goto") await browser.goto(arg);
      else if (action === "viewport") {
        const [width, height] = arg.split("x").map(Number);
        if (!width || !height) throw new Error("viewport expects WxH");
        await browser.setViewport(width, height);
      } else if (action === "click") await browser.click(arg);
      else if (action === "press") await browser.press(arg);
      else if (action === "select") {
        const [selector, ...valueParts] = rest;
        const value = valueParts.join(" ");
        const ok = await browser.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        if (!ok) throw new Error(`select: selector not found: ${selector}`);
      } else if (action === "fill") {
        const [selector, ...valueParts] = rest;
        const value = valueParts.join(" ");
        const ok = await browser.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        if (!ok) throw new Error(`fill: selector not found: ${selector}`);
      } else if (action === "wait") await sleep(Math.min(3000, Number(arg) || 0));
      else if (action === "screenshot") state.screenshots.push(await browser.screenshot(arg));
      else if (action === "expect-text") {
        const text = await browser.evaluate("document.body ? document.body.innerText : ''");
        if (!String(text).includes(arg)) throw new Error(`text not found: ${arg}`);
      } else if (action === "expect-no-text") {
        const text = await browser.evaluate("document.body ? document.body.innerText : ''");
        if (String(text).includes(arg)) throw new Error(`unexpected text: ${arg}`);
      } else if (action === "expect-visible") {
        const visible = await browser.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(arg)});
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })()`);
        if (!visible) throw new Error(`not visible: ${arg}`);
      } else if (action === "expect-hidden") {
        const visible = await browser.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(arg)});
          if (!el) return true;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })()`);
        if (visible) throw new Error(`still visible: ${arg}`);
      } else if (action === "expect-count") {
        const [selector, count] = [rest[0], Number(rest[1])];
        const actual = await browser.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
        if (actual !== count) throw new Error(`count ${selector}: expected ${count}, got ${actual}`);
      } else if (action === "expect-attr") {
        const [selector, name, ...value] = rest;
        const actual = await browser.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`
        );
        if (String(actual) !== value.join(" ")) throw new Error(`attr ${selector}[${name}]: expected "${value.join(" ")}", got "${actual}"`);
      } else if (action === "expect-eval") {
        const result = await browser.evaluate(arg);
        if (!result) throw new Error(`expression is false: ${arg}`);
      } else if (action === "expect-no-horizontal-overflow") {
        const overflow = await browser.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
        if (overflow > 1) throw new Error(`horizontal overflow: ${overflow}px`);
      } else {
        throw new Error(`unknown ui step: ${line}`);
      }
    } catch (error) {
      failures.push(`${line} — ${error.message}`);
      state.screenshots.push(await browser.screenshot(`fail-${failures.length}`).catch(() => ""));
      break;
    }
  }
  return failures;
}

function consoleFailures(browser) {
  const ignored = /favicon|Failed to load resource|net::ERR_/i;
  return [
    ...browser.console.filter((item) => !ignored.test(item.text)).map((item) => `console.${item.type}: ${item.text}`),
    ...browser.exceptions.map((item) => `exception: ${item.text}`)
  ];
}

export async function runUiSmoke({
  task = null,
  outDir = join(ROOT, "fa/tmp/ui"),
  env = process.env,
  requireBrowser = false,
  timeoutMs = 30_000
} = {}) {
  const chrome = findChrome(env);
  if (!chrome) {
    const result = {
      ok: !requireBrowser,
      skipped: true,
      reason: "headless Chrome not found (set FA_CHROME_BIN to enable)",
      checks: [],
      errors: requireBrowser ? ["headless Chrome not found"] : [],
      screenshots: []
    };
    return result;
  }

  ensureDir(outDir);
  const server = await startStaticServer({ root: ROOT });
  let browser = null;
  const checks = [];
  const errors = [];
  const screenshots = [];

  const check = async (name, fn) => {
    try {
      await fn();
      checks.push({ name, status: "ok" });
    } catch (error) {
      checks.push({ name, status: "fail", detail: error.message });
      errors.push(`${name}: ${error.message}`);
      if (browser) screenshots.push(await browser.screenshot(`fail-${checks.length}`).catch(() => ""));
    }
  };

  try {
    browser = await Browser.launch({ chrome, outDir, env, timeoutMs });
    browser.server = server;
    const state = { screenshots };
    const load = async (page) => {
      await browser.goto(page);
      await browser.evaluate("localStorage.clear()");
      await browser.goto(page);
    };

    await check("index.load", async () => {
      await load("index.html");
      const info = await browser.evaluate(`({
        title: document.title,
        feed: Boolean(document.getElementById("news-feed")),
        theme: document.documentElement.getAttribute("data-theme"),
        lang: document.documentElement.lang,
        settingsLabel: document.getElementById("nav-settings-link")?.getAttribute("aria-label") || ""
      })`);
      if (!info.feed) throw new Error("#news-feed is missing");
      if (!info.title) throw new Error("document.title is empty");
      if (!["dark", "light", "amber", "phosphor"].includes(info.theme)) throw new Error(`invalid theme ${info.theme}`);
      if (!["ru", "en", "zh"].includes(info.lang)) throw new Error(`invalid lang ${info.lang}`);
      if (!info.settingsLabel) throw new Error("settings link has no aria-label");
    });

    await check("index.console", async () => {
      const failures = consoleFailures(browser);
      if (failures.length > 0) throw new Error(failures.slice(0, 4).join(" | "));
    });

    await check("index.mobile", async () => {
      await browser.setViewport(390, 844);
      await browser.goto("index.html");
      const overflow = await browser.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      if (overflow > 1) throw new Error(`horizontal overflow ${overflow}px at 390px`);
      const tap = await browser.evaluate(`(() => {
        const el = document.getElementById("nav-settings-link");
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      })()`);
      if (tap.w < 40 || tap.h < 40) throw new Error(`settings tap target is ${tap.w}x${tap.h}`);
      await browser.setViewport(1280, 800);
    });

    await check("index.keyboard", async () => {
      await browser.goto("index.html");
      await browser.evaluate("document.body.focus()");
      await browser.press("Tab");
      const id = await browser.evaluate("document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : ''");
      if (!id) throw new Error("Tab did not move focus");
    });

    await check("settings.load", async () => {
      await load("settings.html");
      const info = await browser.evaluate(`({
        selects: document.querySelectorAll("#settings-content select").length,
        title: document.title,
        hasContent: Boolean(document.getElementById("settings-content")?.children.length)
      })`);
      if (!info.hasContent) throw new Error("#settings-content is empty");
      if (info.selects < 3) throw new Error(`expected at least 3 selects, got ${info.selects}`);
      if (!info.title) throw new Error("document.title is empty");
    });

    await check("settings.theme", async () => {
      await browser.goto("settings.html");
      const ok = await browser.evaluate(`(() => {
        const select = document.querySelectorAll("#settings-content select")[0];
        if (!select) return false;
        select.value = "light";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return document.documentElement.getAttribute("data-theme") === "light" && localStorage.getItem("fain_theme_v1") === "light";
      })()`);
      if (!ok) throw new Error("theme select did not apply light theme");
      await browser.goto("settings.html");
      const persisted = await browser.evaluate(`document.documentElement.getAttribute("data-theme")`);
      if (persisted !== "light") throw new Error("theme did not persist after reload");
      await browser.evaluate(`(() => {
        const select = document.querySelectorAll("#settings-content select")[0];
        select.value = "dark";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
    });

    await check("settings.lang", async () => {
      await browser.goto("settings.html");
      const before = await browser.evaluate("document.documentElement.lang");
      const ok = await browser.evaluate(`(() => {
        const select = document.querySelectorAll("#settings-content select")[2];
        if (!select) return false;
        select.value = "en";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return document.documentElement.lang === "en";
      })()`);
      if (!ok) throw new Error("language select did not switch to en");
      const title = await browser.evaluate("document.title");
      if (!title || title === before) throw new Error("document.title did not change for en");
      await browser.evaluate(`(() => {
        const select = document.querySelectorAll("#settings-content select")[2];
        select.value = "ru";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
    });

    await check("settings.customCss", async () => {
      await browser.goto("settings.html");
      const ok = await browser.evaluate(`(() => {
        const area = document.querySelector(".custom-css-area");
        const button = document.querySelector(".settings-options .term-btn");
        if (!area || !button) return false;
        area.value = "body { outline: 1px solid rgb(1, 2, 3); }";
        button.click();
        const style = document.getElementById("fain-custom-css");
        return Boolean(style) && style.textContent.includes("rgb(1, 2, 3)");
      })()`);
      if (!ok) throw new Error("custom CSS was not applied");
      await browser.evaluate("localStorage.removeItem('fain_custom_css_v1')");
    });

    await check("settings.mobile", async () => {
      await browser.setViewport(390, 844);
      await browser.goto("settings.html");
      const overflow = await browser.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      if (overflow > 1) throw new Error(`horizontal overflow ${overflow}px at 390px`);
      await browser.setViewport(1280, 800);
    });

    if (task?.fields?.ui) {
      await check("task.ui", async () => {
        await browser.goto("index.html");
        const failures = await runSteps(browser, parseSteps(task.fields.ui), state);
        if (failures.length > 0) throw new Error(failures.join(" | "));
      });
    }

    if (errors.length === 0) {
      const failures = consoleFailures(browser);
      if (failures.length > 0) {
        errors.push(...failures.map((item) => `console: ${item}`));
        checks.push({ name: "console.final", status: "fail", detail: failures.slice(0, 3).join(" | ") });
      } else {
        checks.push({ name: "console.final", status: "ok" });
      }
    }

    return {
      ok: errors.length === 0,
      skipped: false,
      chrome,
      checks,
      errors,
      screenshots: screenshots.filter(Boolean)
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      chrome,
      checks,
      errors: [...errors, `ui harness: ${error.message}`],
      screenshots: screenshots.filter(Boolean)
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export function uiSummary(result) {
  if (result.skipped) return `ui: skipped (${result.reason})`;
  const passed = result.checks.filter((item) => item.status === "ok").length;
  return `ui: ${result.ok ? "PASS" : "FAIL"} — ${passed}/${result.checks.length} checks`;
}
