// End-to-end run against the built app, a throwaway Chrome for Testing profile and a throwaway app.
// Usage: PW=<path to playwright> E2E_DIR=<empty dir> node scripts/e2e.js
// Never touches other browsers: DEADBOLT_TEST_BROWSER_APP limits kills to one exact app path, and the run aborts if that copy is already open.
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require(process.env.PW);

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "dist/Deadbolt.app");
const BIN = path.join(APP, "Contents/MacOS/Deadbolt");
const EXT = path.join(APP, "Contents/Resources/extension");
const DIR = process.env.E2E_DIR;
const HOME = path.join(DIR, "home");
const PROFILE = path.join(DIR, "profile");
const EXT_ID = "omjmhpcjabdffmlhmolbbpgjnlpcocfo";
const ENV = { ...process.env, DEADBOLT_HOME: HOME, DEADBOLT_TEST_BROWSER_APP: process.env.CHROME.split("/Contents/MacOS/")[0], DEADBOLT_DRY_DEVICE: "1", DEADBOLT_TEST_NOT_IDLE: "1", DEADBOLT_OPENCODE: path.join(DIR, "stub-opencode"), DEADBOLT_EXPORT_DIR: DIR };
const PASS = [], FAIL = [];
const start = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function result(ok, name, detail = "") {
  (ok ? PASS : FAIL).push(name);
  console.log(`[${PASS.length + FAIL.length}] ${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""} (${Math.round((Date.now() - start) / 1000)}s)`);
}
function rpc(cmd, args = {}) {
  const out = execFileSync(BIN, ["rpc", cmd, JSON.stringify(args)], { env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try { return JSON.parse(out); } catch { return out.trim(); }
}
function rpcFails(cmd, args = {}) {
  try { rpc(cmd, args); return null; } catch (e) { return String(e.stdout || e.message).trim(); }
}
const brk = (o = {}) => ({ kind: "none", workMinutes: 25, breakMinutes: 5, allowanceMinutes: 60, period: "block", rollingMinutes: 60, refillMinute: 0, refillWeekday: 1, rewardMode: "working", textLength: 20, textKind: "gibberish", customText: "", hideTypos: false, keepText: true, delaySeconds: 2, sessions: 3, maxSessionMinutes: 0, ...o });
const lockNone = () => ({ kind: "none", autoDisable: false, text: "", textKind: "words", textLength: 20, delaySeconds: 60, passwordHash: "", passwordSalt: "", rangeStart: 540, rangeEnd: 1020, rangeDays: [1], rangeInverted: false, earlyMinutes: 0, bootId: "" });
let n = 0;
function block(o) {
  return { id: `e2e-${++n}`, name: `b${n}`, kind: "content", enabled: true, websites: [], exceptions: ["file://*"], apps: [], scheduled: false, slots: [], brk: brk(), lock: lockNone(),
    autostart: { kind: "none", minute: 540, days: [1], durationMinutes: 0, lockSettings: false, firedKey: "" }, action: "lock", ...o };
}
function save(b) { rpc("saveBlock", { block: b }); return b; }
function off(b) { rpc("deleteBlock", { id: b.id }); }

async function until(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(step);
  }
  return false;
}
const isBlockPage = (u) => u.startsWith(`chrome-extension://${EXT_ID}/block.html`);

function startAgent() {
  const out = fs.openSync(path.join(DIR, "agent.stdout"), "a");
  const p = spawn(BIN, ["agent"], { env: ENV, stdio: ["ignore", out, out], detached: false });
  return p;
}
async function agentUp() { return until(() => rpc("ping").pid, 5000); }

function logHas(text) { return fs.existsSync(path.join(HOME, "agent.log")) && fs.readFileSync(path.join(HOME, "agent.log"), "utf8").includes(text); }

function procsNamed(exe) {
  try { return execFileSync("/usr/bin/pgrep", ["-f", exe], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; }
}

async function main() {
  if (procsNamed(process.env.CHROME).length) throw new Error("test browser copy already running, refusing to continue");
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.join(PROFILE, "NativeMessagingHosts"), { recursive: true });
  const wrapper = path.join(DIR, "nmh.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport DEADBOLT_HOME="${HOME}"\nexec "${BIN}" nmh\n`);
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(path.join(PROFILE, "NativeMessagingHosts/com.deadbolt.blocker.json"), JSON.stringify({ name: "com.deadbolt.blocker", description: "t", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }));

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    const host = (req.headers.host || "").split(":")[0];
    if (req.url.startsWith("/frame")) { res.end(`<!doctype html><title>outer</title><p>outer</p><iframe id="f" src="http://blocked-frame.test:${server.address().port}/inner"></iframe>`); return; }
    if (host === "adult-meta.test") { res.end(`<!doctype html><meta name="rating" content="RTA-5042-1996-1400-1577-RTA"><title>rated</title>rated`); return; }
    if (host.startsWith("titled-")) { res.end(`<!doctype html><title>Hot XXX videos</title><p id="ok">${host}</p>`); return; }
    res.end(`<!doctype html><title>${host}</title><p id="ok">${host}${req.url}</p>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = (h, p = "/") => `http://${h}:${port}${p}`;

  // Stands in for the model so these runs are deterministic and spend nothing. scripts/live_adult.js covers the real one.
  const STUB_LOG = path.join(DIR, "stub-calls.log");
  fs.writeFileSync(ENV.DEADBOLT_OPENCODE, `#!/bin/sh
echo "$(pwd) | $OPENCODE_CONFIG_CONTENT | $*" >> "${STUB_LOG}"
case "$*" in *titled-slow*) sleep 2;; esac
case "$*" in *titled-fail*) exit 1;; *model-adult*) echo ADULT;; *) printf 'CLEAN\\n\\n> build\\n';; esac
`, { mode: 0o755 });
  const stubCalls = (needle) => (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, "utf8").split("\n").filter((l) => l.includes(needle)) : []);

  let agent = startAgent();
  result(!!(await agentUp()), "agent starts and answers on its socket");
  result(rpc("config").settings.autoBlockAdult === true, "adult filter is on by default");
  rpc("saveSettings", { settings: { ...rpc("config").settings, autoBlockAdult: false } });

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: process.env.CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP *.test 127.0.0.1", "--no-first-run"],
    env: { ...ENV },
  });
  const browserPid = procsNamed(PROFILE)[0];
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  result(sw.url().includes(EXT_ID), "extension loads with the fixed id", sw.url());

  // Turn on incognito access the way a person would, through the browser's own extension API.
  const admin = await ctx.newPage();
  await admin.goto("chrome://extensions/");
  await admin.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await admin.evaluate(async (id) => { await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, incognitoAccess: true }); }, EXT_ID);
  const extInfo = await until(() => admin.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id).then((i) => i.state + ":" + i.incognitoAccess.isActive), EXT_ID), 15000);
  console.log("extension after incognito toggle:", extInfo);
  const ctl = await ctx.newPage();
  const ctlReady = await until(() => ctl.goto(`chrome-extension://${EXT_ID}/popup.html`).then(() => true), 15000, 500);
  if (!ctlReady) throw new Error(`extension page never opened, state ${extInfo}`);
  await admin.close();

  const connected = await until(() => {
    const log = fs.readFileSync(path.join(HOME, "agent.log"), "utf8");
    return log.includes("browser connected") && log.includes("Google Chrome for Testing.app");
  }, 12000);
  result(!!connected, "native host connects and names its parent browser bundle");

  const page = await ctx.newPage();
  await page.goto(url("open.test"));
  result((await page.textContent("#ok")).includes("open.test"), "unblocked site loads with no block set");

  // ---- Websites, exceptions, wildcards
  const site = save(block({ websites: ["blocked.test", "paths.test/secret", "*needle*", "wild.test/*q=*cats*"], exceptions: ["file://*", "ok.blocked.test"] }));
  await sleep(1500);
  const nav = async (u) => { await page.goto(u).catch(() => {}); await sleep(500); return page.url(); };
  result(isBlockPage(await nav(url("blocked.test"))), "domain blocked");
  result(isBlockPage(await nav(url("sub.blocked.test", "/x"))), "subdomain blocked");
  result(!isBlockPage(await nav(url("ok.blocked.test"))), "exception opens a subdomain");
  result(isBlockPage(await nav(url("paths.test", "/secret/page"))), "path entry blocked");
  result(!isBlockPage(await nav(url("paths.test", "/public"))), "other path open");
  result(isBlockPage(await nav(url("any.test", "/a-needle-b"))), "url keyword wildcard blocked");
  result(isBlockPage(await nav(url("wild.test", "/s?q=big+cats"))), "search wildcard blocked");
  result(!isBlockPage(await nav(url("wild.test", "/s?q=dogs"))), "search wildcard spares other searches");

  // SPA navigation
  await nav(url("paths.test", "/public"));
  await page.evaluate(() => history.pushState({}, "", "/secret/spa"));
  result(!!(await until(() => isBlockPage(page.url()))), "history.pushState into a blocked path gets blocked");

  // Incognito
  const incognitoAllowed = await ctl.evaluate(() => chrome.extension.isAllowedIncognitoAccess());
  result(incognitoAllowed === true, "extension has incognito access");
  await ctl.evaluate(async (u) => { await chrome.windows.create({ incognito: true, url: u }); }, url("blocked.test"));
  const incog = await until(async () => {
    const tabs = await ctl.evaluate(() => chrome.tabs.query({}).then((t) => t.filter((x) => x.incognito).map((x) => x.url)));
    return tabs.find(isBlockPage);
  });
  result(!!incog, "incognito window blocked");
  await ctl.evaluate(async () => { for (const t of await chrome.tabs.query({})) if (t.incognito) await chrome.tabs.remove(t.id); });

  // Blocked counts reached stats
  const today = new Date().toLocaleDateString("en-CA");
  await sleep(500);
  const st0 = rpc("stats", { from: today, to: today });
  result(st0.blocked.some((b) => b.item === "blocked.test" && b.count >= 1), "block events recorded in statistics", JSON.stringify(st0.blocked.slice(0, 3)));

  // Toggle off restores the original page
  await nav(url("blocked.test", "/restore-me"));
  rpc("setEnabled", { id: site.id, enabled: false });
  result(!!(await until(() => page.url() === url("blocked.test", "/restore-me"))), "disabling a block returns the tab to its original page");
  off(site);

  // ---- Inactive tabs and embedded content
  const bg = await ctx.newPage();
  await bg.goto(url("bg.test"), { waitUntil: "commit" }).catch(() => {});
  await page.bringToFront();
  await nav(url("outer.test", "/frame"));
  const inactive = save(block({ websites: ["bg.test", "blocked-frame.test"] }));
  await sleep(2500);
  result(!isBlockPage(bg.url()), "inactive tab stays open while that setting is off");
  const frameBlank = async () => {
    const f = page.frames().find((x) => x !== page.mainFrame());
    return f && f.url() === "about:blank" && (await f.evaluate(() => document.documentElement.textContent === ""));
  };
  result(!(await frameBlank()), "embedded content stays while that setting is off");
  const s = rpc("config").settings;
  rpc("saveSettings", { settings: { ...s, blockInactiveTabs: true, blockEmbedded: true } });
  result(!!(await until(() => isBlockPage(bg.url()))), "inactive tab blocked once that setting is on");
  result(!!(await until(frameBlank)), "frame loaded before the setting changed gets emptied");
  await bg.close();
  await nav(url("outer.test", "/frame"));
  const frameEmpty = await until(frameBlank);
  const frameInfo = await Promise.all(page.frames().map(async (f) => [f === page.mainFrame() ? "main" : "child", f.url(), await f.evaluate(() => document.documentElement.outerHTML.slice(0, 120)).catch((e) => "ERR " + e.message.slice(0, 80))]));
  result(!!frameEmpty, "embedded frame from a blocked site emptied", frameEmpty ? "" : JSON.stringify(frameInfo));
  result((await page.textContent("body")).includes("outer"), "outer page survives");
  off(inactive);

  // ---- Adult rating meta
  const adult = save(block({ websites: ["*.xxx"] }));
  await sleep(1500);
  result(isBlockPage(await nav(url("site.xxx"))) , "*.xxx blocks the literal domain");
  await page.goto(url("adult-meta.test")).catch(() => {});
  result(!!(await until(() => isBlockPage(page.url()))), "*.xxx blocks a page that declares an adult rating");
  let adultNavs = 0;
  const countNav = (f) => { if (f === page.mainFrame()) adultNavs++; };
  page.on("framenavigated", countNav);
  await sleep(3000);
  page.off("framenavigated", countNav);
  result(isBlockPage(page.url()) && adultNavs === 0, "adult-rated page stays on the block page", `${adultNavs} navigations in 3s`);
  off(adult);
  await sleep(1200);

  // ---- Adult site filter
  rpc("saveSettings", { settings: { ...rpc("config").settings, autoBlockAdult: true } });
  await sleep(1500);
  result(isBlockPage(await nav(url("pornhub.com"))), "known adult site blocked before it loads");
  result(stubCalls("pornhub").length === 0, "known adult site never reaches the model");
  result(isBlockPage(await nav(url("clips.xxx"))), "adult domain ending blocked");
  await page.goto(url("model-adult.test")).catch(() => {});
  result(!!(await until(() => isBlockPage(page.url()))), "unfamiliar site blocked after the model says adult");
  await page.waitForFunction(() => document.getElementById("title")?.textContent === "Adult site filter").catch(() => {});
  result((await page.textContent("#title")) === "Adult site filter", "block page names the filter");
  const firstCall = stubCalls(" | run --standalone --archived")[0] || "";
  result(firstCall.includes(path.join(HOME, "classifier-cwd")) && firstCall.includes('"permission":{"*":"deny"') && firstCall.includes("--standalone"), "model runs with all tools denied in an empty folder");
  result(isBlockPage(await nav(url("sub.model-adult.test"))), "subdomains of an adult verdict blocked");
  await nav(url("model-adult.test"));
  await sleep(500);
  const adultCalls = stubCalls("model-adult").length;
  result(adultCalls === 1, "verdict is cached and covers subdomains", `${adultCalls} model calls`);
  await page.goto(url("plain-clean.test")).catch(() => {});
  await until(() => rpc("adultSites").cleanCount >= 1);
  await sleep(1500);
  result(page.url() === url("plain-clean.test"), "clean site stays open");
  await page.goto(url("titled-slow.test")).catch(() => {});
  result(!!(await until(() => isBlockPage(page.url()), 1800)), "page with adult words held while the model decides");
  result(!!(await until(() => page.url() === url("titled-slow.test"))), "held page returns when the model says clean");
  await page.goto(url("titled-fail.test")).catch(() => {});
  result(!!(await until(() => isBlockPage(page.url()))), "held page blocked when the model is unavailable");
  await until(() => rpc("adultSites").lastError);
  await sleep(1500);
  result(isBlockPage(page.url()) && String(rpc("adultSites").lastError).includes("exited"), "model failure keeps the block and is reported");
  const beforeRated = stubCalls("adult-meta").length;
  await page.goto(url("adult-meta.test")).catch(() => {});
  result(!!(await until(() => isBlockPage(page.url()))) && stubCalls("adult-meta").length === beforeRated, "RTA-rated page blocked without the model");
  const filterLock = save(block({ websites: ["filter-lock.test"] }));
  rpc("lock", { id: filterLock.id, lock: { ...lockNone(), kind: "password" }, newPassword: "filter-pw" });
  result(!!rpcFails("saveSettings", { settings: { ...rpc("config").settings, autoBlockAdult: false } }), "filter can't be turned off during a locked block");
  result(!!rpcFails("adultAllow", { host: "model-adult.test" }), "site can't be allowed during a locked block");
  result(!!rpcFails("adultForget", { host: "model-adult.test" }), "verdict can't be rechecked during a locked block");
  rpc("unlock", { id: filterLock.id, password: "filter-pw" });
  off(filterLock);
  await nav(url("model-adult.test"));
  rpc("adultAllow", { host: "model-adult.test" });
  result(!!(await until(() => page.url() === url("model-adult.test"))), "allowing a wrongly blocked site reopens it");
  rpc("adultAllow", { host: "pornhub.com" });
  await sleep(300);
  await nav(url("pornhub.com"));
  result(!isBlockPage(page.url()), "allow also overrides the built-in list");
  rpc("adultForget", { host: "pornhub.com" });
  rpc("saveSettings", { settings: { ...rpc("config").settings, autoBlockAdult: false } });
  await sleep(1500);

  // ---- Delay break through the real block page
  const delay = save(block({ websites: ["delay.test"], brk: brk({ kind: "delay", delaySeconds: 2, breakMinutes: 1 }) }));
  await sleep(1500);
  result(isBlockPage(await nav(url("delay.test"))), "delay break starts blocked");
  await page.click("button.primary");
  result(!!(await until(() => page.url() === url("delay.test"), 9000)), "unblock button, countdown, then the tab reopens");
  rpc("cancelBreak", { id: delay.id });
  result(!!(await until(() => isBlockPage(page.url()))), "ending the break blocks again");
  off(delay);

  // ---- Random text break through the real block page
  const text = save(block({ websites: ["text.test"], brk: brk({ kind: "randomText", textLength: 12, textKind: "gibberish", breakMinutes: 1 }) }));
  await sleep(1500);
  await nav(url("text.test"));
  await page.click("button.primary");
  await page.waitForSelector("#challenge", { timeout: 5000 });
  const challenge = await page.textContent("#challenge");
  await page.fill("textarea", "wrong");
  await page.click("button.primary");
  await sleep(600);
  result(isBlockPage(page.url()) && (await page.textContent(".err")).length > 0, "wrong text keeps the block");
  await page.fill("textarea", challenge);
  await page.click("button.primary");
  result(!!(await until(() => page.url() === url("text.test"))), "correct text starts the break", `challenge length ${challenge.length}`);
  off(text);

  // ---- Allowance drains on real time, then blocks
  rpc("saveSettings", { settings: { ...rpc("config").settings, countInactive: true } });
  const allowance = save(block({ websites: ["allow.test"], brk: brk({ kind: "allowance", allowanceMinutes: 1, period: "block" }) }));
  await sleep(1500);
  await nav(url("allow.test"));
  result(!isBlockPage(page.url()), "allowance starts open");
  const t0 = Date.now();
  const spent = await until(() => isBlockPage(page.url()), 90000, 500);
  result(!!spent, "allowance runs out and blocks", `after ${Math.round((Date.now() - t0) / 1000)}s of a 60s allowance`);
  off(allowance);
  rpc("saveSettings", { settings: { ...rpc("config").settings, countInactive: false } });

  // ---- Focused use: only the frontmost browser window spends allowance and writes website statistics
  // Switching back to the test browser itself would never leave it, so Finder stands in.
  const front = (() => { try { const id = execFileSync("/bin/sh", ["-c", "lsappinfo info -only bundleID $(lsappinfo front)"], { encoding: "utf8" }).split('"')[3]; return id === "com.google.chrome.for.testing" ? "com.apple.finder" : id; } catch { return null; } })();
  const focusBlock = save(block({ websites: ["focus.test"], brk: brk({ kind: "allowance", allowanceMinutes: 60, period: "block" }) }));
  await sleep(1500);
  await nav(url("focus.test"));
  await page.bringToFront();
  execFileSync("/usr/bin/open", ["-a", process.env.CHROME.split("/Contents/MacOS/")[0]]);
  const leftBefore = 3600;
  const focusSpent = await until(() => { const b = rpc("status").blocks.find((x) => x.id === focusBlock.id); return b.leftSeconds < leftBefore - 1 ? b.leftSeconds : false; }, 15000, 500);
  if (front) execFileSync("/usr/bin/open", ["-b", front]);
  result(!!focusSpent, "focused tab on a limited site spends allowance", `left ${focusSpent}`);
  await sleep(2500);
  const leftAway = rpc("status").blocks.find((x) => x.id === focusBlock.id).leftSeconds;
  await sleep(3000);
  const leftLater = rpc("status").blocks.find((x) => x.id === focusBlock.id).leftSeconds;
  result(!front || leftLater === leftAway, "allowance stops when the browser is not frontmost", `${leftAway} then ${leftLater}, front app ${front}`);
  const fg = await page.context().newPage();
  await fg.goto(url("elsewhere.test"));
  await fg.bringToFront();
  execFileSync("/usr/bin/open", ["-a", process.env.CHROME.split("/Contents/MacOS/")[0]]);
  await sleep(2500);
  const leftBg = rpc("status").blocks.find((x) => x.id === focusBlock.id).leftSeconds;
  await sleep(3000);
  const leftBgLater = rpc("status").blocks.find((x) => x.id === focusBlock.id).leftSeconds;
  if (front) execFileSync("/usr/bin/open", ["-b", front]);
  await fg.close();
  result(leftBgLater === leftBg, "silent background tab of a limited site spends no allowance", `${leftBg} then ${leftBgLater}`);
  const webUsage = rpc("stats", { from: today, to: today }).usage;
  result(webUsage.some((u) => u.kind === "web" && u.item === "focus.test" && u.seconds >= 1), "website time recorded in statistics");
  result(webUsage.some((u) => u.kind === "app"), "app time recorded in statistics", JSON.stringify(webUsage.filter((u) => u.kind === "app").slice(0, 2)));
  off(focusBlock);

  // ---- Unblock press before usage based breaks
  rpc("saveSettings", { settings: { ...rpc("config").settings, requireUnblockPress: true } });
  const press = save(block({ websites: ["press.test"], brk: brk({ kind: "allowance", allowanceMinutes: 30, period: "block" }) }));
  await sleep(1500);
  result(isBlockPage(await nav(url("press.test"))), "usage based break starts at the block page when that setting is on");
  await page.click("button.primary");
  result(!!(await until(() => page.url() === url("press.test"))), "Unblock press opens the site");
  off(press);
  rpc("saveSettings", { settings: { ...rpc("config").settings, requireUnblockPress: false } });

  // ---- Typos on the block page
  const typo = save(block({ websites: ["typo.test"], brk: brk({ kind: "randomText", textLength: 12, textKind: "gibberish", breakMinutes: 1, keepText: false }) }));
  await sleep(1500);
  await nav(url("typo.test"));
  await page.click("button.primary");
  await page.waitForSelector("#challenge");
  await page.fill("textarea", "!");
  await page.click("button.primary");
  await page.waitForFunction(() => document.querySelector(".err")?.textContent.includes("character 1"));
  result((await page.inputValue("textarea")) === "", "typo position shown and text cleared per break settings");
  off(typo);

  // ---- Autostart settings lock
  const held = save(block({ enabled: false, websites: ["held.test"], autostart: { kind: "oneTime", at: Date.now() / 1000 + 3600, minute: 0, days: [1], durationMinutes: 0, lockSettings: true, firedKey: "" } }));
  result(!!rpcFails("deleteBlock", { id: held.id }) && !!rpcFails("saveBlock", { block: { ...held, websites: [] } }), "locked autostart settings refuse edits until the block starts");

  // ---- Schedule
  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  const safe = m + 3 < 1440 && m > 2;
  if (safe) {
    const slot = { weekday: d.getDay(), start: m - 1, end: m + 3, brk: brk() };
    const inside = save(block({ websites: ["sched.test"], scheduled: true, slots: [slot] }));
    const outside = save(block({ websites: ["later.test"], scheduled: true, slots: [{ ...slot, start: m + 2, end: m + 3 }] }));
    await sleep(1500);
    result(isBlockPage(await nav(url("sched.test"))), "scheduled block active inside its slot");
    result(!isBlockPage(await nav(url("later.test"))), "scheduled block quiet outside its slot");
    const overlap = rpcFails("saveBlock", { block: { ...inside, slots: [slot, { ...slot, start: m, end: m + 2 }] } });
    result(!!overlap && overlap.includes("overlapping"), "overlapping slots refused", overlap);
    off(inside); off(outside);
  } else {
    result(true, "schedule check skipped: too close to midnight");
  }

  // ---- Locks
  const lockBlock = save(block({ websites: ["locked.test"] }));
  const until10 = Date.now() / 1000 + 600;
  rpc("lock", { id: lockBlock.id, lock: { ...lockNone(), kind: "timer", until: until10 } });
  const lb = rpc("config").blocks.find((b) => b.id === lockBlock.id);
  result(!!rpcFails("setEnabled", { id: lb.id, enabled: false }), "timer lock refuses disable");
  result(!!rpcFails("deleteBlock", { id: lb.id }), "timer lock refuses delete");
  result(!!rpcFails("saveBlock", { block: { ...lb, websites: [] } }), "timer lock refuses removing a site");
  result(!rpcFails("saveBlock", { block: { ...lb, websites: ["locked.test", "extra.test"] } }), "timer lock allows adding a site");
  const lb2 = rpc("config").blocks.find((b) => b.id === lockBlock.id);
  result(!!rpcFails("saveBlock", { block: { ...lb2, exceptions: [...lb2.exceptions, "locked.test"] } }), "timer lock refuses an exception into a locked site");
  result(!!rpcFails("lock", { id: lb.id, lock: { ...lb2.lock, until: until10 - 300 } }), "timer lock refuses shortening");
  result(!rpcFails("lock", { id: lb.id, lock: { ...lb2.lock, until: until10 + 300 } }), "timer lock allows extending");
  const flags = { ...rpc("config").settings, blockActivityMonitor: true };
  rpc("saveSettings", { settings: flags });
  const flagOff = rpcFails("saveSettings", { settings: { ...flags, blockActivityMonitor: false } });
  result(!!flagOff, "locked block keeps bypass settings on", flagOff);
  const uninstallRefused = (() => { try { execFileSync(BIN, ["uninstall"], { env: ENV, stdio: "pipe" }); return false; } catch (e) { return String(e.stdout).includes("refused"); } })();
  result(uninstallRefused, "uninstall refuses during a lock");

  const wasRunning = procsNamed("Activity Monitor.app/Contents/MacOS/Activity Monitor").length > 0;
  if (wasRunning) result(true, "Activity Monitor check skipped: already open, not touching it");
  else {
    execFileSync("/usr/bin/open", ["-g", "-j", "-a", "Activity Monitor"]);
    await sleep(500);
    const gone = await until(() => procsNamed("Activity Monitor.app/Contents/MacOS/Activity Monitor").length === 0 && logHas("closed Activity Monitor"), 10000);
    result(!!gone, "Activity Monitor closed during an active block");
  }

  const randomLock = save(block({ websites: ["rl.test"] }));
  rpc("lock", { id: randomLock.id, lock: { ...lockNone(), kind: "randomText", textKind: "gibberish", textLength: 30 } });
  const rl = rpc("config").blocks.find((b) => b.id === randomLock.id);
  result(rl.lock.text.length === 30, "random text lock generates the requested length");
  result(!!rpcFails("unlock", { id: rl.id, text: "nope" }), "wrong text refused");
  result(!rpcFails("unlock", { id: rl.id, text: rl.lock.text }), "right text unlocks");
  result(!rpcFails("setEnabled", { id: rl.id, enabled: false }), "unlocked block can be disabled");
  off(rl);

  const pwLock = save(block({ websites: ["pl.test"] }));
  rpc("lock", { id: pwLock.id, lock: { ...lockNone(), kind: "password" }, newPassword: "s3cret" });
  const pl = rpc("config").blocks.find((b) => b.id === pwLock.id);
  result(pl.lock.passwordHash === "" && !fs.readFileSync(path.join(HOME, "config.json"), "utf8").includes("s3cret"), "password stays hashed and out of API replies");
  result(!!rpcFails("unlock", { id: pl.id, password: "bad" }), "wrong password refused");
  result(!rpcFails("unlock", { id: pl.id, password: "s3cret" }), "right password unlocks");
  off(pwLock);

  const restartLock = save(block({ websites: ["rs.test"] }));
  rpc("lock", { id: restartLock.id, lock: { ...lockNone(), kind: "restart" } });
  result(!!rpcFails("unlock", { id: restartLock.id }), "restart lock can't be opened on the same boot");

  const delayLock = save(block({ websites: ["dl.test"] }));
  rpc("lock", { id: delayLock.id, lock: { ...lockNone(), kind: "delay", delaySeconds: 60 } });
  result(!!rpcFails("setEnabled", { id: delayLock.id, enabled: false }), "delay lock holds before countdown");
  rpc("startUnlock", { id: delayLock.id });
  rpc("cancelUnlock", { id: delayLock.id });
  result(rpc("status").blocks.find((b) => b.id === delayLock.id).unlockAt == null, "delay countdown cancels");

  // ---- Apps
  const appDir = path.join(DIR, "DeadboltE2EVictim.app/Contents/MacOS");
  fs.mkdirSync(appDir, { recursive: true });
  execFileSync("/bin/cp", ["/bin/sleep", path.join(appDir, "victim")]);
  fs.writeFileSync(path.join(DIR, "DeadboltE2EVictim.app/Contents/Info.plist"), `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>victim</string><key>CFBundleIdentifier</key><string>com.deadbolt.e2e.victim</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", path.join(DIR, "DeadboltE2EVictim.app")]);
  const victimExe = path.join(appDir, "victim");
  const appPath = path.join(DIR, "DeadboltE2EVictim.app");
  const runVictim = () => execFileSync("/usr/bin/open", ["-g", "-j", "-a", appPath, "--args", "300"]);
  const appBlock = save(block({ apps: [{ path: path.resolve(appPath), bundleId: "com.deadbolt.e2e.victim", isFolder: false, isBinary: false }] }));
  await sleep(1200);
  runVictim();
  const killed = await until(() => logHas("killed app com.deadbolt.e2e.victim"), 8000);
  result(!!killed, "blocked app force closed after launch");
  rpc("setEnabled", { id: appBlock.id, enabled: false });
  off(appBlock);

  const binPath = path.join(DIR, "victim-bin");
  execFileSync("/bin/cp", ["/bin/sleep", binPath]);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binPath]);
  const binChild = spawn(binPath, ["300"], { stdio: "ignore" });
  const binBlock = save(block({ apps: [{ path: path.resolve(binPath), isFolder: false, isBinary: true }] }));
  const binKilled = await until(() => binChild.exitCode !== null || binChild.signalCode !== null, 6000);
  result(!!binKilled, "blocked binary killed", `signal ${binChild.signalCode}`);
  off(binBlock);

  // ---- Device block, dry run
  const device = save(block({ kind: "device", action: "signOut" }));
  const acted = await until(() => logHas("device action (dry): signOut"), 6000);
  result(!!acted, "device block fires its action (dry run, no real sign out)");
  off(device);

  // ---- Autostart
  const auto = save(block({ enabled: false, websites: ["auto.test"], autostart: { kind: "oneTime", at: Date.now() / 1000 + 2, minute: 0, days: [1], durationMinutes: 5, lockSettings: false, firedKey: "" } }));
  const started = await until(() => rpc("config").blocks.find((b) => b.id === auto.id).enabled, 7000);
  const autoRow = rpc("config").blocks.find((b) => b.id === auto.id);
  result(!!started && autoRow.lock.kind === "timer", "one time autostart enables and timer locks the block");

  const signin = save(block({ enabled: false, websites: ["signin.test"], autostart: { kind: "signIn", minute: 0, days: [1], durationMinutes: 0, lockSettings: false, firedKey: "" } }));

  // ---- Fail closed: rules survive agent death
  agent.kill("SIGKILL");
  await sleep(800);
  const autoRule = await nav(url("locked.test"));
  result(isBlockPage(autoRule), "with the agent dead, the browser still blocks");
  agent = startAgent();
  await agentUp();
  result(rpc("config").blocks.find((b) => b.id === signin.id).enabled === true, "sign-in autostart fires on agent start");
  const stillLocked = rpc("status").blocks.find((b) => b.id === lockBlock.id);
  result(stillLocked.locked && stillLocked.enabled, "locks survive an agent restart");
  result(!!(await until(() => fs.readFileSync(path.join(HOME, "agent.log"), "utf8").split("agent started").pop().includes("browser connected"), 9000)), "native host reconnects after agent restart");

  // ---- Import and export
  const exported = rpc("exportBlocks", {});
  const parsed = JSON.parse(fs.readFileSync(exported, "utf8"));
  result(parsed.length > 0 && parsed.every((b) => !b.enabled && b.lock.kind === "none"), "export strips enabled state and locks");
  const imported = rpc("importBlocks", { blocks: parsed.slice(0, 1) });
  const names = rpc("config").blocks.map((b) => b.name);
  result(imported === 1 && names.some((x) => x.endsWith("(2)")), "import adds a renamed disabled copy");
  const csv = fs.readFileSync(rpc("exportStats", { from: today, to: today }), "utf8");
  result(csv.startsWith("day,type,item,value") && csv.includes("blocked.test"), "statistics export to CSV");

  // ---- Settings password
  rpc("setPassword", { newPassword: "gate" });
  result(!!rpcFails("saveSettings", { settings: rpc("config").settings }), "settings need the password");
  result(!rpcFails("saveSettings", { settings: rpc("config").settings, password: "gate" }), "right password opens settings");

  // ---- Extension removal closes the browser after the grace period
  rpc("saveSettings", { settings: { ...rpc("config").settings, extensionGraceSeconds: 4 }, password: "gate" });
  const ext = await ctx.newPage();
  await ext.goto("chrome://extensions/");
  await ext.evaluate((id) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, incognitoAccess: false }), EXT_ID);
  const browserGone = await until(() => browserPid && procsNamed(PROFILE).length === 0 && logHas("closed browser without extension"), 25000, 500);
  const extAfter = browserGone ? "" : await ext.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id).then((i) => i.state + " incognito=" + i.incognitoAccess.isActive), EXT_ID).catch((e) => e.message.slice(0, 100));
  result(!!browserGone, "browser closed when its extension loses incognito access during a lock", extAfter + (browserGone ? "" : " " + JSON.stringify(rpc("browsers")).slice(0, 300)));
  await ctx.close().catch(() => {});

  agent.kill("SIGKILL");
  server.close();
  console.log(`\nE2E ${PASS.length} passed, ${FAIL.length} failed in ${Math.round((Date.now() - start) / 1000)}s`);
  for (const f of FAIL) console.log("FAILED:", f);
  process.exit(FAIL.length ? 1 : 0);
}

process.on("exit", () => { try { execFileSync("/usr/bin/pkill", ["-f", `${BIN} agent`]); } catch {} });
main().catch((e) => { console.error("E2E CRASH", e); process.exit(2); });
