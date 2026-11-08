// Tries to escape a locked block the way a determined person would. Isolated home, throwaway browser profiles, test launchd labels.
// Usage: CHROME=<binary> PW=<playwright> E2E_DIR=<empty dir> node scripts/e2e_escape.js [files browser launchd]
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require(process.env.PW);

const ROOT = path.resolve(__dirname, "..");
const SRC_APP = path.join(ROOT, "dist/Deadbolt.app");
const BIN = path.join(SRC_APP, "Contents/MacOS/Deadbolt");
const EXT = path.join(SRC_APP, "Contents/Resources/extension");
const DIR = process.env.E2E_DIR;
const HOME = path.join(DIR, "home");
const EXT_ID = "omjmhpcjabdffmlhmolbbpgjnlpcocfo";
const TEST_APP = process.env.CHROME.split("/Contents/MacOS/")[0];
const BASE_ENV = { ...process.env, DEADBOLT_HOME: HOME, DEADBOLT_TEST_BROWSER_APP: TEST_APP, DEADBOLT_DRY_DEVICE: "1", DEADBOLT_TEST_NOT_IDLE: "1", DEADBOLT_EXPORT_DIR: DIR };
const phases = process.argv.slice(2).length ? process.argv.slice(2) : ["files", "browser", "launchd"];
const PASS = [], FAIL = [];
const start = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function result(ok, name, detail = "") {
  (ok ? PASS : FAIL).push(name);
  console.log(`[${PASS.length + FAIL.length}] ${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""} (${Math.round((Date.now() - start) / 1000)}s)`);
}
function rpcEnv(env, cmd, args = {}) {
  const out = execFileSync(BIN, ["rpc", cmd, JSON.stringify(args)], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try { return JSON.parse(out); } catch { return out.trim(); }
}
const rpc = (cmd, args) => rpcEnv(BASE_ENV, cmd, args);
async function until(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(step);
  }
  return false;
}
const brk = (o = {}) => ({ kind: "none", workMinutes: 25, breakMinutes: 5, allowanceMinutes: 60, period: "block", rollingMinutes: 60, refillMinute: 0, refillWeekday: 1, rewardMode: "working", textLength: 20, textKind: "gibberish", customText: "", hideTypos: false, keepText: true, delaySeconds: 2, sessions: 3, maxSessionMinutes: 0, ...o });
const lockCfg = (o = {}) => ({ kind: "none", autoDisable: false, text: "", textKind: "words", textLength: 20, delaySeconds: 60, passwordHash: "", passwordSalt: "", rangeStart: 540, rangeEnd: 1020, rangeDays: [1], rangeInverted: false, earlyMinutes: 0, bootId: "", ...o });
let n = 0;
const block = (o) => ({ id: `esc-${++n}`, name: `esc${n}`, kind: "content", enabled: true, websites: [], exceptions: ["file://*"], apps: [], scheduled: false, slots: [], brk: brk(), lock: lockCfg(), autostart: { kind: "none", minute: 540, days: [1], durationMinutes: 0, lockSettings: false, firedKey: "" }, action: "lock", ...o });
const nowEpoch = () => Date.now() / 1000;
function lockTimer(id, minutes = 120, env = BASE_ENV) { rpcEnv(env, "lock", { id, lock: lockCfg({ kind: "timer", until: nowEpoch() + minutes * 60 }) }); }
function saved(o, env = BASE_ENV) { const b = block(o); rpcEnv(env, "saveBlock", { block: b }); return b; }
const logText = (home = HOME) => { try { return fs.readFileSync(path.join(home, "agent.log"), "utf8"); } catch { return ""; } };

let agent = null;
function startAgent(env = BASE_ENV) {
  const out = fs.openSync(path.join(DIR, "agent.stdout"), "a");
  agent = spawn(BIN, ["agent"], { env, stdio: ["ignore", out, out] });
  return agent;
}
async function stopAgent() {
  if (!agent) return;
  const a = agent;
  a.kill("SIGKILL");
  if (a.exitCode === null && a.signalCode === null) await new Promise((r) => a.once("exit", r));
  agent = null;
}
const agentUp = (env = BASE_ENV) => until(() => rpcEnv(env, "ping").pid, 6000);
async function freshHome() {
  await stopAgent();
  for (const d of [HOME, HOME + "-backup"]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  startAgent();
  await agentUp();
  rpc("saveSettings", { settings: { ...rpc("config").settings, autoBlockAdult: false } });
}
function pidsMatching(s) {
  try { return execFileSync("/usr/bin/pgrep", ["-f", s], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; }
}
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

// ---- Files and clock: no browser needed
async function filesPhase() {
  await freshHome();
  const b = saved({ websites: ["locked.test"] });
  lockTimer(b.id);
  await sleep(1200);

  // Route 8: rewrite config with the agent up
  const cfgPath = path.join(HOME, "config.json");
  const open = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  open.blocks = [];
  fs.writeFileSync(cfgPath, JSON.stringify(open));
  const healed = await until(() => JSON.parse(fs.readFileSync(cfgPath, "utf8")).blocks.length === 1, 5000);
  result(!!healed, "running agent restores an edited config file");

  // Route 8: edit, then restart
  await stopAgent();
  fs.writeFileSync(cfgPath, JSON.stringify(open));
  startAgent(); await agentUp();
  result(rpc("status").blocks.some((x) => x.id === b.id && x.locked), "an edited config is rejected at start");

  // Route 8: delete everything visible in the home folder
  await stopAgent();
  for (const f of ["config.json", "state.json"]) fs.rmSync(path.join(HOME, f), { force: true });
  startAgent(); await agentUp();
  result(rpc("status").blocks.some((x) => x.id === b.id && x.locked), "deleted config and state come back with the lock");

  // Route 8: delete the home folder entirely
  await stopAgent();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  startAgent(); await agentUp();
  result(rpc("status").blocks.some((x) => x.id === b.id && x.locked), "deleting the whole home folder keeps the lock");

  // Route 8: replay an old copy
  await stopAgent();
  const oldVault = path.join(HOME, "vault-config.json");
  const replay = fs.existsSync(oldVault) ? fs.readFileSync(oldVault) : null;
  startAgent(); await agentUp();
  const b2 = saved({ websites: ["second.test"] });
  lockTimer(b2.id);
  await sleep(300);
  await stopAgent();
  if (replay) fs.writeFileSync(oldVault, replay);
  startAgent(); await agentUp();
  result(rpc("status").blocks.some((x) => x.id === b2.id && x.locked), "replaying an older vault doesn't drop a newer lock");

  // Route 17: an older schema must not drop locks, with no vault to save it
  await stopAgent();
  const oldCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  delete oldCfg.settings.theme;
  delete oldCfg.blocks[0].action;
  delete oldCfg.blocks[0].brk.sessions;
  fs.writeFileSync(cfgPath, JSON.stringify(oldCfg));
  for (const d of [HOME, HOME + "-backup"]) for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) if (f.startsWith("vault-")) fs.rmSync(path.join(d, f));
  startAgent(); await agentUp();
  result(rpc("status").blocks.some((x) => x.id === b.id && x.locked), "older JSON missing fields keeps its blocks and locks");

  // Route 9: kill faster than the old 5s save
  await freshHome();
  const dev = saved({ kind: "device", brk: brk({ kind: "allowance", allowanceMinutes: 30, period: "daily" }) });
  await sleep(3600);
  await stopAgent();
  const used = JSON.parse(fs.readFileSync(path.join(HOME, "state.json"), "utf8")).breaks[dev.id]?.usedSeconds ?? 0;
  result(used >= 2, "allowance use survives a kill within seconds", `saved ${used.toFixed(1)}s of about 3.6s`);
  startAgent(); await agentUp();
  rpc("deleteBlock", { id: dev.id });

  // Route 10: clock jumped forward while the agent is down, same boot
  const c = saved({ websites: ["clock.test"] });
  lockTimer(c.id, 30);
  await sleep(1200);
  await stopAgent();
  const jumped = { ...BASE_ENV, DEADBOLT_TEST_WALL_OFFSET: String(365 * 86400) };
  startAgent(jumped); await agentUp(jumped);
  await sleep(1500);
  result(rpcEnv(jumped, "status").blocks.some((x) => x.id === c.id && x.locked), "clock forward with the agent down, same boot, keeps a timer lock");
  await stopAgent();

  // Route 10: same, but after a reboot, so only network time can tell
  const rebooted = { ...jumped, DEADBOLT_TEST_BOOT_ID: "another-boot" };
  startAgent(rebooted); await agentUp(rebooted);
  await sleep(1500);
  const st = rpcEnv(rebooted, "status");
  result(st.blocks.some((x) => x.id === c.id && x.locked), "clock forward across a reboot is corrected from network time", `now off by ${Math.round(st.now - nowEpoch())}s`);
  await stopAgent();

  // Route 11: time zone change to dodge a curfew
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(HOME + "-backup", { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const kolkata = { ...BASE_ENV, TZ: "Asia/Kolkata" };
  startAgent(kolkata); await agentUp(kolkata);
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const slot = { weekday: d.getUTCDay(), start: Math.max(0, minute - 5), end: Math.min(1440, minute + 30), brk: brk() };
  const tz = saved({ websites: ["tz.test"], scheduled: true, slots: [slot] }, kolkata);
  lockTimer(tz.id, 120, kolkata);
  await sleep(1200);
  result(rpcEnv(kolkata, "status").blocks.find((x) => x.id === tz.id).armed, "curfew armed in the original zone");
  await stopAgent();
  const away = { ...BASE_ENV, TZ: "Pacific/Pago_Pago" };
  startAgent(away); await agentUp(away);
  await sleep(1500);
  const moved = rpcEnv(away, "status");
  result(moved.blocks.find((x) => x.id === tz.id).armed, "changing the time zone doesn't lift a locked curfew");
  result(moved.zoneChanged === true, "the pinned zone is surfaced to the UI");
  await stopAgent();

  // Route 12: test seams must be dead under the production launchd label
  const seam = execFileSync(BIN, ["home"], { env: { ...BASE_ENV, XPC_SERVICE_NAME: "com.deadbolt.agent" }, encoding: "utf8" }).trim();
  result(!seam.startsWith(DIR), "DEADBOLT_HOME is ignored under the production label", seam);

  // Route 13: uninstall with the agent dead and a lock on file
  await freshHome();
  const u = saved({ websites: ["u.test"] });
  lockTimer(u.id);
  await sleep(2500);
  await stopAgent();
  let refused = false;
  try { execFileSync(BIN, ["uninstall"], { env: BASE_ENV, stdio: "pipe" }); } catch (e) { refused = String(e.stdout).includes("refused"); }
  result(refused, "uninstall refuses with the agent dead and a lock on file");
  let reinstall = false;
  try { execFileSync(BIN, ["install"], { env: BASE_ENV, stdio: "pipe" }); } catch (e) { reinstall = String(e.stdout).includes("a block is locked"); }
  result(reinstall, "install refuses to replace a locked setup");

  // Custom user selection: two people, one shared config
  await sharedUsers();
}

async function sharedUsers() {
  await stopAgent();
  const shared = path.join(DIR, "shared");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, ".allusers"), "");
  const alice = { ...BASE_ENV, DEADBOLT_HOME: shared, DEADBOLT_TEST_USER: "alice" };
  const bob = { ...BASE_ENV, DEADBOLT_HOME: shared, DEADBOLT_TEST_USER: "bob" };
  const out = fs.openSync(path.join(DIR, "agent.stdout"), "a");
  const a = spawn(BIN, ["agent"], { env: alice, stdio: ["ignore", out, out] });
  const b = spawn(BIN, ["agent"], { env: bob, stdio: ["ignore", out, out] });
  await agentUp(alice); await agentUp(bob);
  const only = saved({ websites: ["only.test"], usersMode: "only", users: ["alice"] }, alice);
  const except = saved({ websites: ["except.test"], usersMode: "except", users: ["alice"] }, alice);
  const arm = (env, id) => rpcEnv(env, "status").blocks.find((x) => x.id === id)?.armed;
  const synced = await until(() => rpcEnv(bob, "config").blocks.length === 2, 6000);
  result(!!synced, "a block saved by one user reaches the other user's agent");
  result(arm(alice, only.id) === true && arm(bob, only.id) === false, "only-these-users block applies to the listed user only");
  result(arm(alice, except.id) === false && arm(bob, except.id) === true, "all-except block skips the listed user");
  lockTimer(only.id, 120, alice);
  await until(() => rpcEnv(bob, "config").blocks.find((x) => x.id === only.id).lock.kind === "timer", 6000);
  const shrink = { ...rpcEnv(alice, "config").blocks.find((x) => x.id === only.id), users: [] , usersMode: "only" };
  let stopped = false;
  try { rpcEnv(alice, "saveBlock", { block: shrink }); } catch (e) { stopped = String(e.stdout).includes("locked"); }
  result(stopped, "a locked block can't drop its users");
  const widen = { ...rpcEnv(alice, "config").blocks.find((x) => x.id === only.id), users: ["alice", "bob"] };
  let widened = true;
  try { rpcEnv(alice, "saveBlock", { block: widen }); } catch { widened = false; }
  result(widened, "a locked block can add users");
  const states = fs.readdirSync(shared).filter((f) => f.startsWith("state"));
  result(states.includes("state-alice.json") && states.includes("state-bob.json"), "break state stays per user", states.join(","));
  a.kill("SIGKILL"); b.kill("SIGKILL");
  await sleep(300);
}

// ---- Browser
async function launchChrome(name, { extension = true, args = [] } = {}) {
  const profile = path.join(DIR, `profile-${name}`);
  fs.mkdirSync(path.join(profile, "NativeMessagingHosts"), { recursive: true });
  const wrapper = path.join(DIR, "nmh.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport DEADBOLT_HOME="${HOME}"\nexec "${BIN}" nmh\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(profile, "NativeMessagingHosts/com.deadbolt.blocker.json"), JSON.stringify({ name: "com.deadbolt.blocker", description: "t", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }));
  const flags = ["--host-resolver-rules=MAP *.test 127.0.0.1", "--no-first-run", "--autoplay-policy=no-user-gesture-required", ...args];
  if (extension) flags.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
  const opts = { headless: false, executablePath: process.env.CHROME, args: flags, env: { ...BASE_ENV } };
  if (!extension) opts.ignoreDefaultArgs = ["--disable-extensions"];
  const ctx = await chromium.launchPersistentContext(profile, opts);
  const pid = pidsMatching(`user-data-dir=${profile}`)[0];
  if (extension) {
    await (ctx.serviceWorkers()[0] || ctx.waitForEvent("serviceworker", { timeout: 15000 }));
    const admin = await ctx.newPage();
    await admin.goto("chrome://extensions/");
    await admin.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    await admin.evaluate((id) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, incognitoAccess: true }), EXT_ID);
    await admin.close();
    await until(() => (rpc("browsers"), logText().includes("browser connected")), 15000);
  }
  return { ctx, pid, profile };
}
const chromeRunning = (profile) => pidsMatching(`user-data-dir=${profile}`).length > 0;

async function browserPhase() {
  if (pidsMatching(process.env.CHROME).length) throw new Error("test browser copy already running, refusing to continue");
  await freshHome();
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url.startsWith("/audio")) { res.end(`<!doctype html><title>audio</title><script>const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();g.gain.value=0.001;o.connect(g).connect(c.destination);o.start();</script>`); return; }
    res.end(`<!doctype html><title>${req.headers.host}</title><p id="ok">ok</p>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = (h, p = "/") => `http://${h}:${server.address().port}${p}`;
  const isBlockPage = (u) => u.startsWith(`chrome-extension://${EXT_ID}/block.html`);

  rpc("saveSettings", { settings: { ...rpc("config").settings, extensionGraceSeconds: 20 } });
  const locked = saved({ websites: ["locked.test"] });
  lockTimer(locked.id);

  // Route 2: second instance without the extension while the first has it
  const main = await launchChrome("main");
  const page = await main.ctx.newPage();
  const nav = async (u) => { await page.goto(u, { timeout: 8000 }).catch(() => {}); await sleep(600); return page.url(); };
  result(isBlockPage(await nav(url("locked.test"))), "locked site blocked in the connected browser");

  // Route 14: URL tricks reach the extension
  result(isBlockPage(await nav(`http://locked.test.:${server.address().port}/`)), "trailing dot host is still blocked");
  result(isBlockPage(await nav(`view-source:${url("locked.test")}`)), "view-source is still blocked");

  rpc("saveSettings", { settings: { ...rpc("config").settings, extensionGraceSeconds: 6 } });
  const second = await launchChrome("second", { extension: false });
  const secondGone = await until(() => !chromeRunning(second.profile), 20000, 500);
  result(!!secondGone, "second browser instance with no extension is closed");
  result(chromeRunning(main.profile), "the connected instance is left alone");
  await second.ctx.close().catch(() => {});

  // Route 4: Brave Tor
  const torDir = path.join(DIR, "BraveSoftware/Brave-Browser/tor");
  fs.mkdirSync(torDir, { recursive: true });
  const tor = path.join(torDir, "tor-0.4.8.13-darwin-brave-0");
  execFileSync("/bin/cp", ["/bin/sleep", tor]);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", tor]);
  const torProc = spawn(tor, ["120"], { stdio: "ignore" });
  const torDead = await until(() => torProc.exitCode !== null || torProc.signalCode !== null, 6000);
  result(!!torDead, "Brave Tor process is stopped during a lock");
  if (!torDead) torProc.kill("SIGKILL");

  // Route 3: guest window in the same browser process. Two normal windows must not trigger it.
  const w2 = await main.ctx.newPage();
  await w2.evaluate(() => window.open("about:blank", "_blank", "width=700,height=500")).catch(() => {});
  await sleep(9000);
  result(chromeRunning(main.profile), "extra windows the extension can see aren't punished");
  // Full screen adds its own AppKit windows, which must not look like a hidden window.
  await page.bringToFront();
  await page.click("body").catch(() => {});
  await page.evaluate(() => document.documentElement.requestFullscreen()).catch(() => {});
  await sleep(9000);
  result(chromeRunning(main.profile), "a full screen window isn't punished");
  await page.evaluate(() => document.exitFullscreen()).catch(() => {});
  // A forwarded --guest opened no window in Chrome for Testing (measured), so the extension is made to under-report by one, which is what a guest window looks like to the agent.
  const sw = main.ctx.serviceWorkers()[0];
  await sw.evaluate(() => { const real = chrome.windows.getAll.bind(chrome.windows); chrome.windows.getAll = async (o) => (await real(o)).slice(1); });
  await (await main.ctx.newPage()).goto("about:blank").catch(() => {}); // a tab event sends the next report now
  const guestClosed = await until(() => logText().includes("window the extension can't see"), 25000, 500);
  result(!!guestClosed, "a window the extension can't report gets the browser closed");
  await main.ctx.close().catch(() => {});
  for (const p of pidsMatching(main.profile)) { try { process.kill(Number(p), "SIGKILL"); } catch {} }
  await sleep(1500);

  // Route 1: reopening the browser doesn't earn a fresh grace period. Grace can't grow during a lock, so this starts over.
  await freshHome();
  rpc("saveSettings", { settings: { ...rpc("config").settings, extensionGraceSeconds: 20 } });
  lockTimer(saved({ websites: ["locked.test"] }).id);
  const t0 = Date.now();
  const noext = await launchChrome("noext-1", { extension: false });
  await sleep(10000);
  await stopAgent();
  startAgent(); await agentUp();
  const killed1 = await until(() => !chromeRunning(noext.profile), 30000, 250);
  const first = (Date.now() - t0) / 1000;
  result(killed1 && first < 26, "restarting the agent doesn't restart the grace period", `closed after ${first.toFixed(0)}s of 20s grace`);
  await noext.ctx.close().catch(() => {});
  const t1 = Date.now();
  const again = await launchChrome("noext-1", { extension: false });
  const killed2 = await until(() => !chromeRunning(again.profile), 30000, 250);
  const secondRun = (Date.now() - t1) / 1000;
  result(killed2 && secondRun < 18.5, "the next launch gets a shorter grace period", `closed after ${secondRun.toFixed(0)}s`);
  await again.ctx.close().catch(() => {});

  // Route 5 and the limit: agent dead, stale rules must not stay open
  await freshHome();
  rpc("saveSettings", { settings: { ...rpc("config").settings, extensionGraceSeconds: 60 } });
  const d = new Date();
  const later = (d.getHours() * 60 + d.getMinutes() + 120) % 1380;
  const curfew = saved({ websites: ["curfew.test"], scheduled: true, slots: [{ weekday: d.getDay(), start: later, end: later + 30, brk: brk() }] });
  lockTimer(curfew.id);
  const limit = saved({ websites: ["limit.test"], brk: brk({ kind: "allowance", allowanceMinutes: 5, period: "rolling", rollingMinutes: 60 }) });
  lockTimer(limit.id);
  const fresh = await launchChrome("offline");
  const p = await fresh.ctx.newPage();
  const go = async (u) => { await p.goto(u, { timeout: 8000 }).catch(() => {}); await sleep(500); return p.url(); };
  await until(() => logText().split("browser connected").length > 1, 5000);
  result(!isBlockPage(await go(url("curfew.test"))), "site is open before its curfew");
  result(!isBlockPage(await go(url("limit.test"))), "site is open with limit left");

  // Route: background audio spends the limit
  const left = () => rpc("status").blocks.find((x) => x.id === limit.id).leftSeconds;
  await p.goto(url("limit.test", "/audio")).catch(() => {});
  const other = await fresh.ctx.newPage();
  await other.goto(url("other.test")).catch(() => {});
  await other.bringToFront();
  await sleep(3000); // Chrome marks a tab audible a moment after sound starts
  const before = left();
  await sleep(5000);
  const after = left();
  result(after <= before - 4, "background audio on a limited site spends the limit", `${before.toFixed(0)}s to ${after.toFixed(0)}s`);

  await other.close();
  await p.bringToFront();
  await go(url("curfew.test"));
  await stopAgent();
  await sleep(1500);
  const offlineBlocked = await until(async () => isBlockPage(await go(url("curfew.test"))), 25000, 1500);
  result(!!offlineBlocked, "agent dead: locked block with a future curfew closes instead of staying open");
  const limitBlocked = await until(async () => isBlockPage(await go(url("limit.test"))), 3000, 800);
  result(!!limitBlocked, "agent dead: locked limit closes instead of staying open");
  startAgent(); await agentUp();
  const reopened = await until(async () => { await sleep(600); return !isBlockPage(p.url()); }, 15000, 800);
  result(!!offlineBlocked && !!reopened, "agent back: the site reopens by itself");
  await fresh.ctx.close().catch(() => {});
  server.close();
}

// ---- launchd, with test labels and a copied app
const launchctl = (...a) => { try { return execFileSync("/bin/launchctl", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return null; } };
async function launchdPhase() {
  await stopAgent();
  const uid = process.getuid();
  const lhome = path.join(DIR, "lhome");
  const agentsDir = path.join(DIR, "LaunchAgents");
  const appCopy = path.join(DIR, "apps/Deadbolt.app");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(path.dirname(appCopy), { recursive: true });
  execFileSync("/usr/bin/ditto", [SRC_APP, appCopy]);
  const bin = path.join(appCopy, "Contents/MacOS/Deadbolt");
  const stamp = `com.deadbolt.test-${process.pid}`;
  const agentLabel = `${stamp}.agent`, guardLabel = `${stamp}.guardian`;
  const env = { ...BASE_ENV, DEADBOLT_HOME: lhome, DEADBOLT_LABEL: stamp, DEADBOLT_AGENTS_DIR: agentsDir, DEADBOLT_SKIP_HOSTS: "1" };
  const loaded = (l) => launchctl("print", `gui/${uid}/${l}`) !== null;
  const pidOf = (l) => { const m = (launchctl("print", `gui/${uid}/${l}`) || "").match(/\bpid = (\d+)/); return m ? Number(m[1]) : 0; };
  const cleanup = () => { for (const l of [guardLabel, agentLabel]) launchctl("bootout", `gui/${uid}/${l}`); };
  process.on("exit", cleanup);
  const lrpc = (cmd, args) => rpcEnv(env, cmd, args);
  try {
    const out = execFileSync(bin, ["install"], { env, encoding: "utf8" });
    result(out.includes("running"), "install starts the agent and guardian", out.split("\n")[0]);
    const up = await until(() => lrpc("ping").pid, 8000);
    result(!!up && !!(await until(() => loaded(guardLabel), 5000)), "both jobs are loaded");

    // launchd itself sets the service name, so a spoofed environment can't dodge the seam check
    const nameFile = path.join(DIR, "xpc-name");
    const probe = path.join(agentsDir, `${stamp}.probe.plist`);
    fs.writeFileSync(probe, `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${stamp}.probe</string><key>EnvironmentVariables</key><dict><key>XPC_SERVICE_NAME</key><string>spoof</string></dict><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>echo "$XPC_SERVICE_NAME" > ${nameFile}</string></array><key>RunAtLoad</key><true/></dict></plist>`);
    launchctl("bootstrap", `gui/${uid}`, probe);
    await until(() => fs.existsSync(nameFile), 4000);
    launchctl("bootout", `gui/${uid}/${stamp}.probe`);
    fs.rmSync(probe);
    const seen = fs.existsSync(nameFile) ? fs.readFileSync(nameFile, "utf8").trim() : "";
    result(seen === `${stamp}.probe`, "launchd sets XPC_SERVICE_NAME itself and can't be spoofed from the plist", `got ${seen}`);

    // Unlocked: leaving is allowed, nothing fights back
    const b = block({ websites: ["locked.test"] });
    lrpc("saveBlock", { block: b });
    launchctl("bootout", `gui/${uid}/${agentLabel}`);
    await sleep(4000);
    result(!loaded(agentLabel), "with no lock, stopping the agent stays stopped");
    launchctl("bootstrap", `gui/${uid}`, path.join(agentsDir, `${agentLabel}.plist`));
    await until(() => lrpc("ping").pid, 8000);

    lrpc("lock", { id: b.id, lock: lockCfg({ kind: "password" }), newPassword: "out" });
    await sleep(2500);

    const before = pidOf(agentLabel);
    process.kill(before, "SIGKILL");
    const t = Date.now();
    const respawn = await until(() => { const p = pidOf(agentLabel); return p && p !== before && lrpc("ping").pid; }, 15000, 100);
    result(!!respawn && Date.now() - t < 4000, "killed agent is back within seconds", `${((Date.now() - t) / 1000).toFixed(1)}s`);

    // A stopped process still accepts connections, and launchd sees nothing wrong
    const frozen = pidOf(agentLabel);
    process.kill(frozen, "SIGSTOP");
    const thawed = await until(() => { const p = pidOf(agentLabel); return p && p !== frozen; }, 20000, 300);
    result(!!thawed, "a frozen agent is replaced by the guardian");
    await until(() => lrpc("ping").pid, 8000);

    launchctl("bootout", `gui/${uid}/${agentLabel}`);
    const back = await until(() => loaded(agentLabel) && lrpc("ping").pid, 12000, 200);
    result(!!back, "launchctl bootout of the agent is undone by the guardian");

    launchctl("bootout", `gui/${uid}/${guardLabel}`);
    const guardBack = await until(() => loaded(guardLabel) && pidOf(guardLabel), 15000, 300);
    result(!!guardBack, "launchctl bootout of the guardian is undone by the agent");

    fs.rmSync(path.join(agentsDir, `${agentLabel}.plist`));
    fs.rmSync(path.join(agentsDir, `${guardLabel}.plist`));
    const plistBack = await until(() => fs.existsSync(path.join(agentsDir, `${agentLabel}.plist`)) && fs.existsSync(path.join(agentsDir, `${guardLabel}.plist`)), 10000);
    result(!!plistBack, "deleted launch plists come back");

    const edited = path.join(agentsDir, `${agentLabel}.plist`);
    const good = fs.readFileSync(edited, "utf8");
    fs.writeFileSync(edited, good.replace("<key>KeepAlive</key>", "<key>Disabled</key><true/><key>KeepAlive</key>"));
    const unedited = await until(() => fs.readFileSync(edited, "utf8") === good, 10000);
    result(!!unedited, "an edited launch plist is rewritten");

    fs.rmSync(appCopy, { recursive: true, force: true });
    const appBack = await until(() => fs.existsSync(path.join(appCopy, "Contents/MacOS/Deadbolt")), 10000);
    result(!!appBack, "a deleted app is restored from its spare copy");
    let verifies = false;
    if (appBack) { try { execFileSync("/usr/bin/codesign", ["--verify", appCopy]); verifies = true; } catch {} }
    result(verifies, "the restored app still has a valid signature");

    // Both jobs out together: the native host is the third way back
    const spareBin = path.join(lhome, "app/Deadbolt.app/Contents/MacOS/Deadbolt");
    launchctl("bootout", `gui/${uid}/${guardLabel}`);
    launchctl("bootout", `gui/${uid}/${agentLabel}`);
    const host = spawn(spareBin, ["nmh"], { env, stdio: ["pipe", "ignore", "ignore"] });
    const hostBack = await until(() => loaded(agentLabel) && lrpc("ping").pid, 15000, 300);
    result(!!hostBack, "with both jobs out, a browser's native host brings them back");
    host.kill("SIGKILL");

    // Pointing the home at an empty folder must not pass the lock check and then remove the real jobs
    const emptyHome = { ...BASE_ENV, DEADBOLT_HOME: path.join(DIR, "empty-home") };
    let notTouched = false;
    try { execFileSync(spareBin, ["uninstall"], { env: emptyHome, stdio: "pipe" }); } catch (e) { notTouched = String(e.stdout).includes("Refused"); }
    result(notTouched, "uninstall with a decoy home is refused");

    let refused = false;
    try { execFileSync(spareBin, ["uninstall"], { env, stdio: "pipe" }); } catch (e) { refused = String(e.stdout).includes("refused"); }
    result(refused && loaded(agentLabel), "uninstall refuses during a lock");

    // Finish the lock, then the clean way out must work
    lrpc("unlock", { id: b.id, password: "out" });
    await sleep(1500);
    const out2 = execFileSync(spareBin, ["uninstall"], { env, encoding: "utf8" });
    await sleep(4000);
    result(out2.includes("removed") && !loaded(agentLabel) && !loaded(guardLabel), "uninstall after the lock ends leaves nothing running", out2.trim());
    result(!fs.existsSync(path.join(agentsDir, `${agentLabel}.plist`)), "uninstall removes the plists");
  } finally { cleanup(); }

  // install --all-users writes what Cold Turkey writes, into a fake root, without sudo
  const fakeRoot = path.join(DIR, "fakeroot");
  fs.mkdirSync(path.join(fakeRoot, "Library/LaunchAgents"), { recursive: true });
  fs.mkdirSync(path.join(fakeRoot, "Applications"), { recursive: true });
  fs.mkdirSync(path.join(fakeRoot, "Users/Shared"), { recursive: true });
  const sysOut = execFileSync(BIN, ["install", "--all-users"], { env: { ...BASE_ENV, DEADBOLT_SYSTEM_ROOT: fakeRoot, DEADBOLT_SKIP_HOSTS: "1" }, encoding: "utf8" });
  const sysPlist = path.join(fakeRoot, "Library/LaunchAgents/com.deadbolt.agent.plist");
  const plistOk = fs.existsSync(sysPlist) && fs.readFileSync(sysPlist, "utf8").includes(path.join(fakeRoot, "Applications/Deadbolt.app/Contents/MacOS/Deadbolt"));
  result(plistOk && fs.existsSync(path.join(fakeRoot, "Users/Shared/Deadbolt/.allusers")) && fs.existsSync(path.join(fakeRoot, "Applications/Deadbolt.app")), "install --all-users lays out plist, app and shared folder", sysOut.split("\n")[0]);
  const refusedNoRoot = (() => { try { execFileSync(BIN, ["install", "--all-users"], { env: { ...BASE_ENV, DEADBOLT_SKIP_HOSTS: "1" }, stdio: "pipe" }); return false; } catch (e) { return String(e.stdout).includes("sudo"); } })();
  result(refusedNoRoot, "install --all-users without root asks for sudo");
}

process.on("exit", () => { try { agent?.kill("SIGKILL"); } catch {} });
(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  if (phases.includes("files")) await filesPhase();
  if (phases.includes("browser")) await browserPhase();
  if (phases.includes("launchd")) await launchdPhase();
  console.log(`\nESCAPE ${PASS.length} passed, ${FAIL.length} failed in ${Math.round((Date.now() - start) / 1000)}s`);
  for (const f of FAIL) console.log("FAILED:", f);
  process.exit(FAIL.length ? 1 : 0);
})().catch((e) => { console.error("ESCAPE CRASH", e); process.exit(2); });
