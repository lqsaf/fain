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
        "cache-control": "no-store",
        "connection": "close"
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
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        })
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
      { stdio: ["ignore", "ignore", "pipe"], env, detached: true }
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
      // Snap-сборки Chromium могут запрещать сигналы из чужого namespace.
      // Закрываем пайпы и отпускаем handle, чтобы тест не висел до таймаута.
      try { child.stderr?.destroy(); } catch {}
      try { child.stdout?.destroy(); } catch {}
      try { child.stdin?.destroy(); } catch {}
      try { child.unref(); } catch {}
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
      Home: { code: "Home", windowsVirtualKeyCode: 36 },
      End: { code: "End", windowsVirtualKeyCode: 35 },
      Space: { code: "Space", key: " ", windowsVirtualKeyCode: 32 }
    };
    const info = codes[key];
    if (!info) throw new Error(`unsupported key: ${key}`);
    const eventKey = info.key || key;
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: eventKey, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode },
      this.sessionId
    );
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: eventKey, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode },
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

function getTaskId({ task, env = process.env } = {}) {
  if (task?.id) return task.id;
  if (env.FA_TASK_ID) return env.FA_TASK_ID;
  return null;
}

function isT04Task(taskId) {
  return taskId === "T04";
}

export async function runUiSmoke({
  task = null,
  outDir = join(ROOT, "fa/tmp/ui"),
  env = process.env,
  requireBrowser = false,
  timeoutMs = 30_000
} = {}) {
  const taskId = getTaskId({ task, env });
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
  const accordionSelector = '#settings-content button[aria-expanded][aria-controls]:not([role="combobox"]):not([aria-haspopup])';

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
    const chooseSettingOption = async ({
      name,
      terms,
      targetValue,
      targetText,
      storageKey,
      expectedAttribute,
      interaction = "keyboard"
    }) => {
      const marker = `fa-smoke-${name}`;
      const selector = `[data-fa-smoke-control="${marker}"]`;
      const control = await browser.evaluate(`(() => {
        const root = document.getElementById("settings-content");
        const controls = [...document.querySelectorAll('#settings-content [role="combobox"], #settings-content [aria-haspopup="listbox"]')];
        const terms = ${JSON.stringify(terms)};
        const element = controls.find((candidate) => {
          const names = [candidate.getAttribute("aria-label") || ""];
          const labelledBy = candidate.getAttribute("aria-labelledby") || "";
          for (const id of labelledBy.split(/\\s+/).filter(Boolean)) {
            names.push(document.getElementById(id)?.textContent || "");
          }
          let node = candidate;
          for (let depth = 0; node && node !== root && depth < 5; depth += 1, node = node.parentElement) {
            names.push(node.textContent || "");
            const text = names.join(" ").toLowerCase();
            if (terms.some((term) => text.includes(term))) return true;
          }
          return false;
        });
        if (!element) return null;
        element.setAttribute("data-fa-smoke-control", ${JSON.stringify(marker)});
        const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean);
        return {
          role: element.getAttribute("role"),
          haspopup: element.getAttribute("aria-haspopup"),
          expanded: element.getAttribute("aria-expanded"),
          labelledBy,
          nameParts: labelledBy.map((id) => document.getElementById(id)?.textContent?.trim() || "")
        };
      })()`);
      if (!control) throw new Error(`custom ${name} dropdown with an accessible label was not found`);
      if (control.role !== "combobox" || control.haspopup !== "listbox") {
        throw new Error(`${name} trigger must expose combobox/listbox semantics`);
      }
      if (
        control.labelledBy.length < 2 ||
        control.nameParts.some((part) => !part) ||
        !control.nameParts.some((part) => terms.some((term) => part.toLowerCase().includes(term)))
      ) {
        throw new Error(`${name} trigger accessible name must reference its visible label and selected value`);
      }

      const focus = async () => browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
      await focus();
      if (interaction === "pointer") await browser.click(selector);
      else await browser.press("Enter");
      const opened = await browser.evaluate(`(() => {
        const control = document.querySelector(${JSON.stringify(selector)});
        const list = document.getElementById(control?.getAttribute("aria-controls")) ||
          [...document.querySelectorAll('[role="listbox"]')].find((item) => !item.hidden);
        if (!control || !list) return null;
        const triggerRect = control.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        const terms = ${JSON.stringify(terms)};
        return {
          expanded: control.getAttribute("aria-expanded"),
          visible: !list.hidden && getComputedStyle(list).display !== "none" && getComputedStyle(list).visibility !== "hidden",
          below: listRect.top >= triggerRect.bottom - 2,
          role: list.getAttribute("role"),
          labelledBy: list.getAttribute("aria-labelledby"),
          labelExists: (list.getAttribute("aria-labelledby") || "")
            .split(/\s+/)
            .filter(Boolean)
            .some((id) => {
              const label = document.getElementById(id)?.textContent?.toLowerCase() || "";
              return terms.some((term) => label.includes(term));
            })
        };
      })()`);
      if (!opened?.visible || opened.expanded !== "true") throw new Error(`${name} dropdown did not open`);
      if (opened.role !== "listbox" || !opened.labelledBy || !opened.labelExists) {
        throw new Error(`${name} popup must expose an accessibly labelled listbox`);
      }
      if (!opened.below) throw new Error(`${name} dropdown did not expand inline below its trigger`);

      const savedBeforeEscape = await browser.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`);
      await browser.evaluate("document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))");
      const outsideClick = await browser.evaluate(`({
        expanded: document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-expanded"),
        value: localStorage.getItem(${JSON.stringify(storageKey)})
      })`);
      if (outsideClick.expanded === "true" || outsideClick.value !== savedBeforeEscape) {
        throw new Error(`${name} dropdown did not close on outside click without changing its value`);
      }

      await focus();
      await browser.press("Enter");
      const reopened = await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-expanded")`);
      if (reopened !== "true") throw new Error(`${name} dropdown did not reopen from the keyboard`);
      await browser.press("Escape");
      const escaped = await browser.evaluate(`({
        expanded: document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-expanded"),
        activeDescendant: document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-activedescendant"),
        value: localStorage.getItem(${JSON.stringify(storageKey)})
      })`);
      if (escaped.expanded === "true" || escaped.value !== savedBeforeEscape) {
        throw new Error(`${name} dropdown Escape did not close without changing the value`);
      }
      if (escaped.activeDescendant) throw new Error(`${name} dropdown kept aria-activedescendant after close`);

      await focus();
      if (interaction === "pointer") await browser.click(selector);
      else await browser.press("Space");
      const navigation = await browser.evaluate(`(() => {
        const control = document.querySelector(${JSON.stringify(selector)});
        const list = document.getElementById(control?.getAttribute("aria-controls")) ||
          [...document.querySelectorAll('[role="listbox"]')].find((item) => !item.hidden);
        if (!control || !list) return null;
        const options = [...list.querySelectorAll('[role="option"]')];
        const targetText = new RegExp(${JSON.stringify(targetText)}, "iu");
        const target = options.findIndex((option) =>
          [option.dataset.value, option.getAttribute("value")].some((value) => value?.toLowerCase() === ${JSON.stringify(targetValue)}) ||
          targetText.test(option.textContent || option.getAttribute("aria-label") || "")
        );
        const activeIndex = () => {
          const activeId = control.getAttribute("aria-activedescendant");
          const active = activeId ? document.getElementById(activeId) : document.activeElement;
          return options.indexOf(active);
        };
        return {
          optionCount: options.length,
          selectedCount: options.filter((option) => option.getAttribute("aria-selected") === "true").length,
          target,
          activeIndex: activeIndex(),
          listVisible: !list.hidden && getComputedStyle(list).display !== "none",
          focusOnControl: document.activeElement === control,
          activeDescendantIsOption: Boolean(
            control.getAttribute("aria-activedescendant") &&
              options.some((option) => option.id === control.getAttribute("aria-activedescendant"))
          ),
          allOptionsNamed: options.every((option) => option.textContent?.trim() && option.id)
        };
      })()`);
      if (!navigation?.listVisible || navigation.optionCount < 2 || navigation.selectedCount !== 1 || navigation.target < 0) {
        throw new Error(`${name} dropdown has no accessible listbox options for ${targetValue}`);
      }
      if (!navigation.focusOnControl || !navigation.activeDescendantIsOption || !navigation.allOptionsNamed) {
        throw new Error(`${name} combobox must retain focus and identify its active, named option`);
      }

      if (interaction === "pointer") {
        await browser.evaluate(`(() => {
          const control = document.querySelector(${JSON.stringify(selector)});
          const list = document.getElementById(control?.getAttribute("aria-controls")) ||
            [...document.querySelectorAll('[role="listbox"]')].find((item) => !item.hidden);
          list?.querySelectorAll('[role="option"]')[${navigation.target}]?.setAttribute(
            "data-fa-smoke-option",
            ${JSON.stringify(marker)}
          );
        })()`);
        await browser.click(`[data-fa-smoke-option="${marker}"]`);
      } else {
        await browser.press("End");
        const endIndex = await browser.evaluate(`(() => {
          const control = document.querySelector(${JSON.stringify(selector)});
          const list = document.getElementById(control?.getAttribute("aria-controls")) ||
            [...document.querySelectorAll('[role="listbox"]')].find((item) => !item.hidden);
          const options = [...(list?.querySelectorAll('[role="option"]') || [])];
          const activeId = control?.getAttribute("aria-activedescendant");
          return options.indexOf(activeId ? document.getElementById(activeId) : document.activeElement);
        })()`);
        if (endIndex !== navigation.optionCount - 1) throw new Error(`${name} dropdown End key did not move to the last option`);
        await browser.press("Home");
        const homeIndex = await browser.evaluate(`(() => {
          const control = document.querySelector(${JSON.stringify(selector)});
          const list = document.getElementById(control?.getAttribute("aria-controls")) ||
            [...document.querySelectorAll('[role="listbox"]')].find((item) => !item.hidden);
          const options = [...(list?.querySelectorAll('[role="option"]') || [])];
          const activeId = control?.getAttribute("aria-activedescendant");
          return options.indexOf(activeId ? document.getElementById(activeId) : document.activeElement);
        })()`);
        if (homeIndex !== 0) throw new Error(`${name} dropdown Home key did not move to the first option`);
        for (let index = 0; index < navigation.target; index += 1) await browser.press("ArrowDown");
        await browser.press("Enter");
      }

      const selected = await browser.evaluate(`({
        expanded: document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-expanded"),
        value: localStorage.getItem(${JSON.stringify(storageKey)}),
        attribute: document.documentElement.getAttribute(${JSON.stringify(expectedAttribute)})
      })`);
      if (selected.expanded === "true") throw new Error(`${name} dropdown did not close after selection`);
      if (selected.value !== targetValue) throw new Error(`${name} dropdown did not persist ${targetValue}`);
      if (selected.attribute !== targetValue) throw new Error(`${name} preference did not apply ${targetValue}`);
    };

    // Base checks that run for all tasks
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

    // index.mobile: horizontal overflow for all tasks; tap target only for non-T04 (T25/T26)
    await check("index.mobile", async () => {
      await browser.setViewport(390, 844);
      await browser.goto("index.html");
      const overflow = await browser.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      if (overflow > 1) throw new Error(`horizontal overflow ${overflow}px at 390px`);
      if (!isT04Task(taskId)) {
        const tap = await browser.evaluate(`(() => {
          const el = document.getElementById("nav-settings-link");
          const r = el.getBoundingClientRect();
          return { w: r.width, h: r.height };
        })()`);
        if (tap.w < 40 || tap.h < 40) throw new Error(`settings tap target is ${tap.w}x${tap.h}`);
      }
      await browser.setViewport(1280, 800);
    });

    // index.keyboard: only for non-T04 (T25)
    if (!isT04Task(taskId)) {
      await check("index.keyboard", async () => {
        await browser.goto("index.html");
        await browser.evaluate("document.body.focus()");
        await browser.press("Tab");
        const id = await browser.evaluate("document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : ''");
        if (!id) throw new Error("Tab did not move focus");
      });
    }

    // T04 checks: settings accordion, theme, language, ASCII, customCss, persistence
    await check("settings.load", async () => {
      await load("settings.html");
      const info = await browser.evaluate(`({
        nativeSelects: document.querySelectorAll("#settings-content select").length,
        dropdowns: document.querySelectorAll('#settings-content [role="combobox"], #settings-content [aria-haspopup="listbox"]').length,
        accordions: [...document.querySelectorAll(${JSON.stringify(accordionSelector)})].map((button) => {
          const panel = document.getElementById(button.getAttribute("aria-controls"));
          const content = panel?.querySelector(".accordion-panel-content") || panel;
          const contentStyle = content ? getComputedStyle(content) : null;
          const contentRect = content?.getBoundingClientRect();
          return {
            expanded: button.getAttribute("aria-expanded") === "true",
            panelExists: Boolean(panel),
            panelHidden: Boolean(panel?.hidden || panel?.getAttribute("aria-hidden") === "true"),
            panelVisible: Boolean(
              panel && !panel.hidden &&
                contentRect && contentRect.height > 0 && contentRect.width > 0 &&
                contentStyle.display !== "none" &&
                contentStyle.visibility !== "hidden" &&
                contentStyle.opacity !== "0"
            ),
            panelFocusable: Boolean(panel && !panel.hidden &&
              getComputedStyle(panel).display !== "none" &&
              [...panel.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")].some((item) => item.tabIndex >= 0))
          };
        }),
        title: document.title,
        hasContent: Boolean(document.getElementById("settings-content")?.children.length)
      })`);
      if (!info.hasContent) throw new Error("#settings-content is empty");
      if (info.nativeSelects > 0) throw new Error(`found ${info.nativeSelects} native select elements; settings require custom dropdowns`);
      if (info.dropdowns < 3) throw new Error(`expected at least 3 accessible custom dropdowns, got ${info.dropdowns}`);
      if (info.accordions.length < 3 || info.accordions.some((item) => !item.panelExists)) {
        throw new Error(`expected 3 accessible accordion sections with controlled panels, got ${info.accordions.length}`);
      }
      if (info.accordions.filter((item) => item.expanded).length !== 1 || !info.accordions[0].expanded) {
        throw new Error("the first accordion section must be open by default and the others closed");
      }
      if (!info.accordions[0].panelVisible) {
        throw new Error("the open accordion panel is not visible: its content is clipped or transparent (check max-height/opacity and the initial open class)");
      }
      if (info.accordions.slice(1).some((item) => !item.panelHidden)) {
        throw new Error("collapsed accordion panels must be hidden from assistive technology");
      }
      if (info.accordions.slice(1).some((item) => item.panelFocusable)) {
        throw new Error("collapsed accordion panels contain keyboard-focusable controls");
      }
      if (!info.title) throw new Error("document.title is empty");
    });

    await check("settings.accordion", async () => {
      await load("settings.html");
      await browser.evaluate("localStorage.setItem('fain_settings_sections_v1', '{invalid')");
      await browser.goto("settings.html");
      await browser.evaluate(`(() => {
        return new Promise(resolve => {
          const check = () => {
            const buttons = document.querySelectorAll(${JSON.stringify(accordionSelector)});
            if (buttons.length === 3) resolve();
            else requestAnimationFrame(check);
          };
          check();
        });
      })()`);
      const recovered = await browser.evaluate(`({
        sections: [...document.querySelectorAll(${JSON.stringify(accordionSelector)})]
          .map((button) => button.getAttribute("aria-expanded") === "true")
      })`);
      if (recovered.sections.length !== 3 || !recovered.sections[0] || recovered.sections.slice(1).some(Boolean)) {
        throw new Error("invalid accordion storage did not recover to [interface]");
      }

      await browser.evaluate("localStorage.setItem('fain_settings_sections_v1', '[\"interface\",\"unknown\"]')");
      await browser.goto("settings.html");
      await browser.evaluate(`(() => {
        return new Promise(resolve => {
          const check = () => {
            const buttons = document.querySelectorAll(${JSON.stringify(accordionSelector)});
            if (buttons.length === 3) resolve();
            else requestAnimationFrame(check);
          };
          check();
        });
      })()`);
      const filtered = await browser.evaluate(`[
        ...document.querySelectorAll(${JSON.stringify(accordionSelector)})
      ].map((button) => button.getAttribute("aria-expanded") === "true")`);
      if (filtered.length !== 3 || !filtered[0] || filtered.slice(1).some(Boolean)) {
        throw new Error("accordion storage did not discard unknown section IDs");
      }

      const selector = await browser.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(accordionSelector + '[aria-expanded="true"]')});
        if (!button) return "";
        button.setAttribute("data-fa-smoke-accordion", "first");
        return '[aria-controls="' + CSS.escape(button.getAttribute("aria-controls")) + '"]';
      })()`);
      if (!selector) throw new Error("default-open accordion button was not found");
      await browser.click('[data-fa-smoke-accordion="first"]');
      const collapsed = await browser.evaluate(`new Promise((resolve) => {
        const started = performance.now();
        const check = () => {
          const button = document.querySelector(${JSON.stringify(selector)});
          const panel = document.getElementById(button?.getAttribute("aria-controls"));
          const done = button?.getAttribute("aria-expanded") === "false" &&
            Boolean(panel?.hidden || panel?.getAttribute("aria-hidden") === "true");
          if (done) resolve(true);
          else if (performance.now() - started > 1500) resolve(false);
          else requestAnimationFrame(check);
        };
        check();
      })`);
      if (!collapsed) throw new Error("accordion click did not collapse and hide its panel");
      await browser.goto("settings.html");
      await browser.evaluate(`(() => {
        return new Promise(resolve => {
          const check = () => {
            const buttons = document.querySelectorAll(${JSON.stringify(accordionSelector)});
            if (buttons.length === 3) resolve();
            else requestAnimationFrame(check);
          };
          check();
        });
      })()`);
      const persisted = await browser.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        return button?.getAttribute("aria-expanded") === "false";
      })()`);
      if (!persisted) throw new Error("collapsed accordion state did not persist after reload");
      await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
      await browser.press("Space");
      const expanded = await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-expanded")`);
      if (expanded !== "true") throw new Error("accordion did not expand with the Space key");
    });

    await check("settings.theme", async () => {
      await load("settings.html");
      await browser.evaluate(`(() => {
        return new Promise(resolve => {
          const check = () => {
            const controls = document.querySelectorAll('#settings-content [role="combobox"], #settings-content [aria-haspopup="listbox"]');
            if (controls.length >= 3) resolve();
            else requestAnimationFrame(check);
          };
          check();
        });
      })()`);
      await chooseSettingOption({
        name: "theme",
        terms: ["theme", "тема", "主题"],
        targetValue: "light",
        targetText: "(?:\\blight\\b|свет|浅色)",
        storageKey: "fain_theme_v1",
        expectedAttribute: "data-theme"
      });
      await browser.goto("settings.html");
      await browser.evaluate(`(() => {
        return new Promise(resolve => {
          const check = () => {
            const buttons = document.querySelectorAll(${JSON.stringify(accordionSelector)});
            if (buttons.length === 3) resolve();
            else requestAnimationFrame(check);
          };
          check();
        });
      })()`);
      const persisted = await browser.evaluate(`({
        theme: document.documentElement.getAttribute("data-theme"),
        value: localStorage.getItem("fain_theme_v1")
      })`);
      if (persisted.theme !== "light" || persisted.value !== "light") throw new Error("theme did not persist after reload");
    });

    await check("settings.lang", async () => {
      await load("settings.html");
      await browser.evaluate("localStorage.setItem('fain_lang_v1', 'ru')");
      await browser.goto("settings.html");
      const before = await browser.evaluate("document.documentElement.lang");
      const beforeTitle = await browser.evaluate("document.title");
      await browser.evaluate(`(() => {
        const buttons = document.querySelectorAll(${JSON.stringify(accordionSelector)});
        if (buttons[1]) buttons[1].click();
      })()`);
      await browser.evaluate(`(() => {
        return new Promise(resolve => {
          const check = () => {
            const buttons = document.querySelectorAll(${JSON.stringify(accordionSelector)});
            if (buttons[1]?.getAttribute("aria-expanded") === "true") resolve();
            else requestAnimationFrame(check);
          };
          check();
        });
      })()`);
      await browser.evaluate(`(() => {
        return new Promise(resolve => {
          const check = () => {
            const controls = document.querySelectorAll('#settings-content [role="combobox"], #settings-content [aria-haspopup="listbox"]');
            if (controls.length >= 3) resolve();
            else requestAnimationFrame(check);
          };
          check();
        });
      })()`);
      await chooseSettingOption({
        name: "language",
        terms: ["language", "язык", "语言"],
        targetValue: "en",
        targetText: "(?:\\ben\\b|english|англ|英语)",
        storageKey: "fain_lang_v1",
        expectedAttribute: "lang",
        interaction: "pointer"
      });
      if (before !== "ru") throw new Error("language smoke test did not start in Russian");
      const title = await browser.evaluate("document.title");
      if (!title || title === beforeTitle) throw new Error("document.title did not change after switching to en");
      await browser.goto("settings.html");
      const persisted = await browser.evaluate(`({
        lang: document.documentElement.lang,
        value: localStorage.getItem("fain_lang_v1")
      })`);
      if (persisted.lang !== "en" || persisted.value !== "en") throw new Error("language did not persist after reload");
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
export { Browser };
