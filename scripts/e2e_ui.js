// Drives the real UI code against a real agent. WebKit is covered separately by `Deadbolt ui --smoke`.
// Usage: PW=<playwright> CHROME=<binary> E2E_DIR=<empty dir> node scripts/e2e_ui.js
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require(process.env.PW);

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "dist/Deadbolt.app/Contents/MacOS/Deadbolt");
const UI = path.join(ROOT, "dist/Deadbolt.app/Contents/Resources/ui");
const DIR = process.env.E2E_DIR;
const ENV = { ...process.env, DEADBOLT_HOME: path.join(DIR, "home"), DEADBOLT_TEST_BROWSER_APP: "/nonexistent", DEADBOLT_DRY_DEVICE: "1", DEADBOLT_OPENCODE: "/nonexistent", DEADBOLT_EXPORT_DIR: DIR };
const pass = [], fail = [];
const check = (ok, name, detail = "") => { (ok ? pass : fail).push(name); console.log(`[${pass.length + fail.length}] ${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); };
const rpc = (c, a = {}) => JSON.parse(execFileSync(BIN, ["rpc", c, JSON.stringify(a)], { env: ENV, encoding: "utf8" }));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

(async () => {
  fs.mkdirSync(ENV.DEADBOLT_HOME, { recursive: true });
  const agent = spawn(BIN, ["agent"], { env: ENV, stdio: "ignore" });
  process.on("exit", () => agent.kill("SIGKILL"));
  await new Promise((r) => setTimeout(r, 800));
  const server = http.createServer((req, res) => {
    if (req.url === "/api") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { cmd, args } = JSON.parse(body);
        try {
          const out = execFileSync(BIN, ["rpc", cmd, JSON.stringify(args)], { env: ENV, encoding: "utf8" });
          let result;
          try { result = JSON.parse(out); } catch { result = out.trim(); }
          res.end(JSON.stringify({ ok: true, result }));
        } catch (e) { res.end(JSON.stringify({ ok: false, error: String(e.stdout).replace(/^Error: /, "").trim() })); }
      });
      return;
    }
    const file = path.join(UI, req.url === "/" ? "index.html" : path.normalize(req.url));
    if (!file.startsWith(UI) || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "text/plain");
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME });
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) problems.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const shot = (n) => page.screenshot({ path: path.join(DIR, `${n}.png`) });

  await page.waitForSelector("h1");
  check((await page.textContent("h1")) === "Dashboard", "dashboard renders");
  await shot("1-dashboard-empty");

  await page.click('[data-tab="blocks"]');
  await page.click("#new");
  await page.fill("#name", "Work focus");
  await page.fill("#entry", "reddit.com");
  await page.click("#add");
  await page.selectOption("#imp-list", "p:Gambling");
  await page.waitForFunction(() => document.querySelector(".entries").textContent.includes("bet365.com"));
  await page.selectOption("#imp-list", "internet");
  await page.waitForFunction(() => document.querySelector(".entries").textContent.includes("*.*"));
  await shot("2-block-editor");
  await page.click('[data-s="exceptions"]');
  await page.fill("#entry", "wikipedia.org");
  await page.click("#add");
  await page.click("#save");
  await page.waitForSelector('[data-id] .edit');
  let b = rpc("config").blocks[0];
  check(b.name === "Work focus" && b.websites.includes("reddit.com") && b.websites.includes("bet365.com") && b.exceptions.includes("wikipedia.org"), "editor saves sites, a pre-made list and exceptions to the agent");

  await page.click(".brk");
  await page.click('#kinds [data-v="allowance"]');
  await page.fill('[data-n="allowanceMinutes"]', "45");
  await page.selectOption('[data-p="period"]', "weekly");
  await shot("3-break-dialog");
  await page.click("#save");
  await page.waitForFunction(() => !document.querySelector(".modal"));
  await page.waitForFunction(() => document.body.textContent.includes("Allowance 45 min"));
  b = rpc("config").blocks[0];
  check(b.brk.kind === "allowance" && b.brk.allowanceMinutes === 45 && b.brk.period === "weekly", "break dialog saves to the agent");

  await page.click(".sched");
  await page.click("#sch");
  const day = await (await page.$('.day[data-wd="2"]')).boundingBox();
  await page.mouse.move(day.x + 20, day.y + 150);
  await page.mouse.down();
  await page.mouse.move(day.x + 20, day.y + 240, { steps: 4 });
  await page.mouse.up();
  await page.waitForSelector(".slot[data-i]");
  await shot("4-schedule");
  await page.click("#save");
  await page.waitForFunction(() => !document.querySelector(".modal"));
  b = rpc("config").blocks[0];
  check(b.scheduled && b.slots.length === 1 && b.slots[0].weekday === 2 && b.slots[0].end - b.slots[0].start === 180, "dragging on the grid creates a slot", JSON.stringify(b.slots.map((s) => [s.weekday, s.start, s.end])));

  await page.click(".sched");
  await page.click("#all");
  await page.click("#save");
  await page.waitForFunction(() => !document.querySelector(".modal"));

  await page.click(".switch input");
  await page.waitForFunction(() => document.querySelector(".switch input").checked);
  check(rpc("status").blocks[0].blocking === false || rpc("status").blocks[0].armed === true, "toggle enables the block");

  await page.click(".lock");
  await page.click('#kinds [data-v="timer"]');
  await page.selectOption("#preset", "60");
  await shot("5-lock-dialog");
  await page.click("#save");
  await page.click("#yes");
  await page.waitForFunction(() => document.querySelector(".lock").textContent.startsWith("Locked until"));
  check(rpc("status").blocks[0].locked === true, "lock dialog locks the block");
  check(await page.isDisabled(".switch input"), "locked block's toggle is disabled");
  await shot("6-blocks-locked");
  await page.click(".edit");
  await page.click('[data-rm="0"]');
  await page.click("#save");
  await page.waitForFunction(() => document.querySelector("#e").textContent.includes("locked"));
  check((await page.textContent("#e")).includes("Websites can't be removed"), "locked block refuses removing a site in the editor");
  await page.click("#cancel");

  await page.click('[data-tab="dashboard"]');
  await page.waitForFunction(() => document.body.textContent.includes("Work focus"));
  await shot("7-dashboard-active");
  check((await page.textContent("body")).includes("on allowance"), "dashboard shows the active block and its break state");

  rpc("saveBlock", { block: { ...rpc("config").blocks[0], id: "pomo", name: "Pomo", enabled: true, websites: ["pomo.test"], lock: { ...rpc("config").blocks[0].lock, kind: "none", until: null }, brk: { ...b.brk, kind: "pomodoro" } } });
  await page.click('[data-tab="blocks"]');
  await page.click('[data-id="pomo"] .reset');
  await page.click("#yes");
  const anchor = () => JSON.parse(fs.readFileSync(path.join(ENV.DEADBOLT_HOME, "state.json"), "utf8")).breaks.pomo?.pomodoroAnchor;
  await page.waitForFunction(() => !document.querySelector(".modal"));
  let anchored = false;
  for (let i = 0; i < 20 && !anchored; i++) { anchored = Math.abs(anchor() - Date.now() / 1000) < 10; await new Promise((r) => setTimeout(r, 150)); }
  check(anchored, "pomodoro reset button restarts the work period");

  await page.click('[data-tab="stats"]');
  await page.waitForSelector("#range");
  await page.click('[data-sub="app"]');
  await page.waitForSelector("#range");
  await page.selectOption("#range", "today");
  await page.waitForFunction(() => document.querySelector("#range").value === "today");
  await shot("8-stats");
  check(true, "statistics tabs render");
  await page.click("#csv");
  await page.waitForFunction(() => document.querySelector(".modal")?.textContent.includes("deadbolt-stats"));
  await page.click("#ok");
  check(fs.readdirSync(DIR).some((f) => f.startsWith("deadbolt-stats")), "CSV export writes a file");

  await page.click('[data-tab="settings"]');
  await page.waitForSelector('[data-k="theme"]');
  await page.selectOption('[data-k="theme"]', "dark");
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
  await page.waitForSelector('[data-t="Block strictness"]');
  await page.click('[data-t="Block strictness"]');
  await page.waitForSelector('[data-k="blockActivityMonitor"]');
  await page.check('[data-k="blockInactiveTabs"]');
  await page.waitForFunction(() => document.querySelector('[data-k="blockInactiveTabs"]')?.checked);
  check(rpc("config").settings.blockInactiveTabs === true && rpc("config").settings.theme === "dark", "settings save to the agent");
  await shot("9-settings-dark");
  await page.uncheck('[data-k="blockInactiveTabs"]');
  await page.waitForFunction(() => document.querySelector(".modal")?.textContent.includes("can't disable"));
  check(rpc("config").settings.blockInactiveTabs === true, "locked block keeps strict setting on through the UI");
  await page.click("#ok");

  await page.click('[data-t="Adult filter"]');
  await page.waitForSelector("#allow-host");
  await shot("9b-adult-filter");
  check((await page.isChecked('[data-k="autoBlockAdult"]')) && (await page.textContent("#view")).includes("DeepSeek"), "adult filter tab shows the toggle and what gets sent");

  await page.click('[data-t="Password"]');
  await page.fill("#p1", "pw1");
  await page.fill("#p2", "pw2");
  await page.click("#setpw");
  await page.waitForFunction(() => document.querySelector("#pe").textContent.includes("did not match"));
  check(true, "mismatched settings passwords refused");
  await page.fill("#p2", "pw1");
  await page.click("#setpw");
  await page.waitForFunction(() => document.querySelector(".modal")?.textContent.includes("password is set"));
  await page.click("#ok");
  await page.reload();
  await page.waitForSelector("h1");
  await page.click('[data-tab="settings"]');
  await page.waitForSelector("#pw");
  await page.fill("#pw", "nope");
  await page.click("#ok");
  await page.waitForFunction(() => document.querySelector("#e")?.textContent.includes("Wrong"));
  await page.fill("#pw", "pw1");
  await page.click("#ok");
  await page.waitForSelector('[data-t="Preferences"]');
  check(true, "settings tab asks for the password");

  // Quick limit: 5 minutes per hour, nothing from 10pm to 6am
  await page.click('[data-tab="blocks"]');
  await page.click("#quick");
  await page.fill("#ql-sites", "limit.test");
  await page.fill("#ql-min", "5");
  await page.check("#ql-cur");
  await page.click("#save");
  await page.waitForSelector("#kinds");
  const limit = rpc("config").blocks.find((b) => b.websites.includes("limit.test"));
  const monday = limit?.slots.filter((x) => x.weekday === 1).sort((a, z) => a.start - z.start) ?? [];
  check(limit?.scheduled && limit.slots.length === 21, "quick limit makes three slots for each of 7 days", `${limit?.slots.length} slots`);
  check(JSON.stringify(monday.map((x) => [x.start, x.end, x.brk.kind])) === JSON.stringify([[0, 360, "none"], [360, 1320, "allowance"], [1320, 1440, "none"]]), "the curfew crosses midnight and the rest is allowance", JSON.stringify(monday.map((x) => [x.start, x.end, x.brk.kind])));
  check(monday[1]?.brk.allowanceMinutes === 5 && monday[1]?.brk.period === "rolling" && monday[1]?.brk.rollingMinutes === 60, "the allowance is 5 minutes in a rolling hour");
  const lockKinds = await page.$$eval("#kinds button", (xs) => xs.map((x) => x.dataset.v));
  check(!lockKinds.includes("schedule"), "a full week schedule doesn't offer a schedule lock, which could never open");
  await page.click("#cancel");
  await page.click("#quick");
  await page.fill("#ql-sites", "plain.test");
  await page.selectOption("#ql-per", "day");
  await page.click("#save");
  await page.waitForSelector("#kinds");
  const plain = rpc("config").blocks.find((b) => b.websites.includes("plain.test"));
  check(!plain?.scheduled && plain?.brk.kind === "allowance" && plain?.brk.period === "daily" && plain?.brk.allowanceMinutes === 10, "a limit with no curfew needs no schedule");
  await page.click("#cancel");
  rpc("deleteBlock", { id: limit.id, password: "pw1" });
  rpc("deleteBlock", { id: plain.id, password: "pw1" });
  await page.evaluate(() => refresh());

  // Affected users
  await page.click(".edit");
  await page.click('[data-s="users"]');
  await page.waitForSelector("#um");
  check((await page.$$eval(".ub", (xs) => xs.length)) > 0, "the users pane lists this Mac's accounts");
  await page.click("#cancel");

  await page.setViewportSize({ width: 390, height: 800 });
  await page.click('[data-tab="blocks"]');
  await page.waitForSelector("[data-id]");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, "phone width has no horizontal page scroll");
  await shot("10-narrow");

  check(problems.length === 0, "no page errors", problems.slice(0, 3).join(" | "));
  await browser.close();
  server.close();
  console.log(`\nUI ${pass.length} passed, ${fail.length} failed`);
  fail.forEach((f) => console.log("FAILED:", f));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error("UI CRASH", e); process.exit(2); });
