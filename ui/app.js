const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let settingsPassword = "";

async function api(cmd, args = {}) {
  if (settingsPassword && args.password === undefined) args = { ...args, password: settingsPassword };
  if (window.webkit?.messageHandlers?.api) return window.webkit.messageHandlers.api.postMessage({ cmd, args });
  const r = await fetch("/api", { method: "POST", body: JSON.stringify({ cmd, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
const errorText = (e) => String(e?.message ?? e).replace(/^Error:\s*/, "");

let cfg = { blocks: [], settings: {}, hasPassword: false };
let status = { blocks: [], browsers: [] };
let tab = "dashboard";
let blockKind = "content";
let statsSub = "blocked";
let statsRange = "last7";
let statsTop = 10;
let statsSearch = "";
let customFrom = "", customTo = "";

async function load() {
  [cfg, status] = await Promise.all([api("config"), api("status")]);
  applyTheme();
}

function applyTheme() {
  const t = cfg.settings.theme;
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

function statusOf(id) { return status.blocks.find((b) => b.id === id) || {}; }

function fmtTime(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (cfg.settings.use24h) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 || h === 24 ? "AM" : "PM"}`;
}
function fmtDate(epoch) { return epoch ? new Date(epoch * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short", hour12: !cfg.settings.use24h }) : ""; }
function fmtSpan(seconds) {
  const s = Math.max(0, Math.round(seconds)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
const parseTime = (v) => { const [h, m] = v.split(":").map(Number); return h * 60 + m; };
const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

async function render() {
  $$("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  ({ dashboard: renderDashboard, blocks: renderBlocks, stats: renderStats, settings: renderSettings }[tab])();
}

function needsPassword(t) {
  if (!cfg.hasPassword || settingsPassword) return false;
  const s = cfg.settings;
  return t === "settings" || (t === "dashboard" && s.passwordRestrictDashboard) || (t === "blocks" && s.passwordRestrictBlocks) || (t === "stats" && s.passwordRestrictStats);
}

async function go(t) {
  if (needsPassword(t)) {
    const ok = await askPassword();
    if (!ok) return;
  }
  tab = t;
  await load();
  render();
}

// ---------- Modals

function modal(html, { wide = false } = {}) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  $("#modal-root").append(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  const first = $("input,select,textarea,button", scrim);
  if (first) first.focus();
  return { el: scrim, close };
}

function confirmBox(title, body, yes = "Continue") {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><div>${body}</div><div class="foot"><button class="btn" id="no">Cancel</button><button class="btn primary" id="yes">${esc(yes)}</button></div>`);
    $("#no", m.el).onclick = () => { m.close(); resolve(false); };
    $("#yes", m.el).onclick = () => { m.close(); resolve(true); };
  });
}

function alertBox(title, body) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><div>${body}</div><div class="foot"><button class="btn primary" id="ok">OK</button></div>`);
    $("#ok", m.el).onclick = () => { m.close(); resolve(); };
  });
}

function askPassword() {
  return new Promise((resolve) => {
    const m = modal(`<h2>Settings password</h2><input type="password" id="pw" style="width:100%" aria-label="Password"><p class="err" id="e"></p><div class="foot"><button class="btn" id="no">Cancel</button><button class="btn primary" id="ok">Open</button></div>`);
    $("#no", m.el).onclick = () => { m.close(); resolve(false); };
    $("#ok", m.el).onclick = async () => {
      const v = $("#pw", m.el).value;
      try { await api("verifyPassword", { password: v }); settingsPassword = v; m.close(); resolve(true); }
      catch (e) { $("#e", m.el).textContent = "Wrong password."; }
    };
  });
}

function reportError(e) { alertBox("That didn't work", esc(errorText(e))); }

// ---------- Dashboard

function renderDashboard() {
  const blocks = status.blocks.filter((b) => b.enabled);
  const active = blocks.filter((b) => b.armed);
  const today = new Date().getDay();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const upcoming = cfg.blocks.filter((b) => b.enabled && b.scheduled).flatMap((b) => b.slots.filter((s) => s.weekday === today && s.start > nowMin).map((s) => ({ b, s }))).sort((x, y) => x.s.start - y.s.start);
  const warnings = [];
  const missing = status.browsers.filter((b) => b.supported && (!b.connected || !b.incognitoAllowed));
  if (missing.length && cfg.settings.extensionErrorDialog) warnings.push(`Extension needed in ${missing.map((b) => esc(b.name)).join(", ")}. <button class="link" id="fix-ext">Fix extensions</button>`);
  const unsupported = status.browsers.filter((b) => !b.supported).map((b) => esc(b.name));
  if (unsupported.length) warnings.push(`Installed browsers Deadbolt can't enforce in: ${unsupported.join(", ")}. Turn on unsupported browser blocking in Settings to close them during a block.`);
  const paneFlags = ["blockDateTime", "blockUsersGroups", "blockLoginItems", "blockScreenTime"].some((k) => cfg.settings[k]);
  if (paneFlags && !status.accessibility) warnings.push(`System Settings blocking needs Accessibility permission for Deadbolt. <button class="link" id="grant-ax">Grant access</button>`);
  if (status.zoneChanged) warnings.push("The time zone changed. Locked schedules keep the zone they were locked in until the lock ends.");
  if (status.tampered) warnings.push("The system clock was changed. Deadbolt is ignoring the change and keeping real time.");
  if (cfg.settings.noLockHint && blocks.length && !blocks.some((b) => b.locked)) warnings.push(`There are enabled blocks, but none is locked. <button class="link" id="to-blocks">Lock a block</button>`);
  if (cfg.settings.emptyScheduleHint) {
    const empty = cfg.blocks.filter((b) => b.enabled && b.scheduled && !b.slots.length).map((b) => esc(b.name));
    if (empty.length) warnings.push(`Scheduled but with no times set: ${empty.join(", ")}.`);
  }
  $("#view").innerHTML = `<h1>Dashboard</h1>
    ${warnings.map((w) => `<div class="panel warn">${w}</div>`).join("")}
    <h2>Active blocks</h2>
    ${active.length ? active.map(activeCard).join("") : `<div class="panel mute">Nothing is blocking right now.</div>`}
    <h2>Today's upcoming blocks</h2>
    ${upcoming.length ? upcoming.map(({ b, s }) => `<div class="panel row spread"><span>${esc(b.name)}</span><span class="mute">${fmtTime(s.start)} to ${fmtTime(s.end)}</span></div>`).join("") : `<div class="panel mute">Nothing else today.</div>`}`;
  $("#fix-ext")?.addEventListener("click", extensionHelp);
  $("#grant-ax")?.addEventListener("click", async () => { await api("requestAccessibility"); });
  $("#to-blocks")?.addEventListener("click", () => go("blocks"));
}

function activeCard(s) {
  const bits = [s.reason];
  if (s.leftSeconds != null) bits.push(`${fmtSpan(s.leftSeconds)} left`);
  if (s.sessionsLeft != null) bits.push(`${s.sessionsLeft} sessions left`);
  if (s.until) bits.push(`changes at ${new Date(s.until * 1000).toLocaleTimeString([], { timeStyle: "short" })}`);
  return `<div class="panel row spread"><span><b>${esc(s.name)}</b> <span class="mute">${s.kind === "device" ? "device block" : ""}</span></span><span class="mute">${esc(bits.join(", "))}${s.locked ? ", locked" : ""}</span></div>`;
}

function extensionHelp() {
  const rows = status.browsers.map((b) => {
    if (!b.supported) return `<div class="row spread"><span>${esc(b.name)}</span><span class="mute">Not supported</span></div>`;
    const state = !b.connected ? "Extension not connected" : !b.incognitoAllowed ? "Allow in incognito needed" : "Connected";
    return `<div class="row spread"><span>${esc(b.name)}</span><span class="${b.connected && b.incognitoAllowed ? "" : "err"}">${state}</span></div>`;
  }).join("");
  alertBox("Browser extensions", `<p>A locked block closes any supported browser whose extension is off. In each browser:</p>
    <ol><li>Open its extensions page and turn on Developer mode.</li><li>Choose Load unpacked, then pick the <code>extension</code> folder in Deadbolt.app/Contents/Resources.</li><li>Open the extension's Details and turn on Allow in Incognito.</li></ol>${rows}`);
}

// ---------- Blocks list

const blockTemplate = (kind) => ({
  id: crypto.randomUUID(), name: "", kind, enabled: false, websites: [], exceptions: ["file://*"], apps: [], scheduled: false, slots: [],
  brk: defaultBreak(), lock: defaultLock(), autostart: { kind: "none", minute: 540, days: [1, 2, 3, 4, 5], durationMinutes: 0, lockSettings: false, firedKey: "" }, action: "lock", usersMode: "all", users: [],
});
const defaultBreak = () => ({ kind: "none", workMinutes: 25, breakMinutes: 5, allowanceMinutes: 60, period: "block", rollingMinutes: 60, refillMinute: 0, refillWeekday: 1, rewardMode: "working", textLength: 100, textKind: "words", customText: "", hideTypos: false, keepText: true, delaySeconds: 300, sessions: 3, maxSessionMinutes: 0 });
const defaultLock = () => ({ kind: "none", autoDisable: false, text: "", textKind: "words", textLength: 100, delaySeconds: 300, passwordHash: "", passwordSalt: "", rangeStart: 540, rangeEnd: 1020, rangeDays: [1, 2, 3, 4, 5], rangeInverted: false, earlyMinutes: 0, bootId: "" });

function lockText(b) {
  const st = statusOf(b.id), l = b.lock;
  switch (l.kind) {
    case "none": return "No lock set";
    case "timer": return `Locked until ${fmtDate(l.until)}`;
    case "randomText": return "Locked with random text";
    case "delay": return st.unlockAt ? `Unlocks at ${fmtDate(st.unlockAt)}` : `Locked with a ${fmtSpan(l.delaySeconds)} delay`;
    case "password": return "Locked with a password";
    case "timeRange": return `${l.rangeInverted ? "Unlocked" : "Locked"} ${fmtTime(l.rangeStart)} to ${fmtTime(l.rangeEnd)}, ${st.locked ? "locked now" : "open now"}`;
    case "schedule": return `Locked during schedule${l.earlyMinutes ? ` and ${l.earlyMinutes} min before` : ""}`;
    case "restart": return "Locked until restart";
  }
  return "";
}

function breakText(c) {
  switch (c.kind) {
    case "none": return "No breaks";
    case "pomodoro": return `Pomodoro ${c.workMinutes}/${c.breakMinutes}`;
    case "allowance": return `Allowance ${c.allowanceMinutes} min ${c.period === "rolling" ? `per ${c.rollingMinutes} min` : `per ${c.period}`}`;
    case "reward": return `Reward ${c.breakMinutes} min per ${c.workMinutes} min ${c.rewardMode}`;
    case "randomText": return `${c.breakMinutes} min break after typing`;
    case "delay": return `${c.breakMinutes} min break after ${fmtSpan(c.delaySeconds)} wait`;
    case "sessions": return `${c.sessions} sessions per ${c.period === "rolling" ? `${c.rollingMinutes} min` : c.period}`;
  }
  return "";
}

function autostartText(a) {
  switch (a.kind) {
    case "none": return "No autostart";
    case "oneTime": return `Starts ${fmtDate(a.at)}`;
    case "timeOfDay": return `Starts ${fmtTime(a.minute)} on ${a.days.map((d) => DAYS[d]).join(" ")}`;
    case "signIn": return "Starts at sign in";
    case "schedule": return "Starts at next scheduled block";
  }
  return "";
}

// Free time as allowance slots and curfew as plain slots. Rolling and daily usage carry across slots.
function limitSchedule(allowance, curfew) {
  const brk = allowance ? { ...defaultBreak(), kind: "allowance", ...allowance } : defaultBreak();
  if (!curfew) return { scheduled: false, slots: [], brk };
  const { from, to } = curfew;
  const closed = from < to ? [[from, to]] : [[0, to], [from, 1440]].filter(([a, z]) => a < z);
  const open = [];
  let at = 0;
  for (const [a, z] of closed) { if (at < a) open.push([at, a]); at = z; }
  if (at < 1440) open.push([at, 1440]);
  const slots = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (const [start, end] of closed) slots.push({ weekday, start, end, brk: defaultBreak() });
    if (allowance) for (const [start, end] of open) slots.push({ weekday, start, end, brk: structuredClone(brk) });
  }
  return { scheduled: true, slots, brk: defaultBreak() };
}

function quickLimitDialog() {
  const m = modal(`<h2>Quick limit</h2>
    <label>Sites, one per line <textarea id="ql-sites" placeholder="reddit.com" aria-label="Sites" style="width:100%"></textarea></label>
    <label class="check"><input type="checkbox" id="ql-use" checked> Limit use to</label>
    <div class="row"><input type="number" id="ql-min" value="10" min="1" max="1440" aria-label="Minutes"> minutes per <select id="ql-per" aria-label="Period"><option value="hour">hour</option><option value="day">day</option></select></div>
    <label class="check"><input type="checkbox" id="ql-cur"> Block completely</label>
    <div class="row"><label>From <input type="time" id="ql-from" value="22:00"></label><label>to <input type="time" id="ql-to" value="06:00"></label></div>
    <p class="err" id="e"></p>
    <div class="foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Create and lock...</button></div>`);
  $("#cancel", m.el).onclick = m.close;
  $("#save", m.el).onclick = async () => {
    const sites = $("#ql-sites", m.el).value.split(/\s+/).filter(Boolean);
    const use = $("#ql-use", m.el).checked, cur = $("#ql-cur", m.el).checked;
    const minutes = Number($("#ql-min", m.el).value);
    const from = parseTime($("#ql-from", m.el).value), to = parseTime($("#ql-to", m.el).value);
    const say = (t) => { $("#e", m.el).textContent = t; };
    if (!sites.length) return say("Add at least one site.");
    if (!use && !cur) return say("Choose a limit, a block time, or both.");
    if (use && !(minutes >= 1)) return say("Enter the minutes allowed.");
    if (cur && from === to) return say("The block needs different start and end times.");
    const allowance = use ? ($("#ql-per", m.el).value === "hour" ? { allowanceMinutes: minutes, period: "rolling", rollingMinutes: 60 } : { allowanceMinutes: minutes, period: "daily" }) : null;
    const b = { ...blockTemplate("content"), name: uniqueName(`Limit ${sites[0]}`), enabled: true, websites: sites, ...limitSchedule(allowance, cur ? { from, to } : null) };
    try {
      await api("saveBlock", { block: b });
      m.close();
      await refresh();
      lockDialog(cfg.blocks.find((x) => x.id === b.id) || b);
    } catch (e) { say(errorText(e)); }
  };
}

function renderBlocks() {
  const items = cfg.blocks.filter((b) => b.kind === blockKind);
  $("#view").innerHTML = `<div class="row spread"><h1 style="margin:0">Blocks</h1>
      <div class="row"><button class="btn" id="imp">Import...</button><button class="btn" id="exp">Export all...</button><button class="btn" id="del">Delete disabled</button>${blockKind === "content" ? `<button class="btn" id="quick">Quick limit...</button>` : ""}<button class="btn primary" id="new">New ${blockKind === "device" ? "device " : ""}block</button></div></div>
    <input type="file" id="imp-file" accept=".json" hidden>
    <div class="tabs" style="margin-top:14px"><button data-k="content" class="${blockKind === "content" ? "on" : ""}">Website &amp; app blocks</button><button data-k="device" class="${blockKind === "device" ? "on" : ""}">Device blocks</button></div>
    ${items.length ? items.map(blockRow).join("") : `<div class="panel mute">No blocks yet.</div>`}`;
  $$(".tabs [data-k]").forEach((b) => (b.onclick = () => { blockKind = b.dataset.k; renderBlocks(); }));
  $("#new").onclick = () => editBlock(blockTemplate(blockKind), true);
  $("#quick")?.addEventListener("click", quickLimitDialog);
  $("#exp").onclick = async () => { try { alertBox("Exported", esc(await api("exportBlocks", { kind: blockKind }))); } catch (e) { reportError(e); } };
  $("#del").onclick = async () => {
    if (await confirmBox("Delete all disabled blocks?", "You lose their websites, apps and exceptions.", "Delete")) { await api("deleteDisabled", { kind: blockKind }); await refresh(); }
  };
  $("#imp").onclick = () => $("#imp-file").click();
  $("#imp-file").onchange = async (e) => {
    try {
      const n = await api("importBlocks", { blocks: JSON.parse(await e.target.files[0].text()) });
      alertBox("Imported", `${n} block(s) added, all disabled.`);
      await refresh();
    } catch (err) { reportError(err); }
  };
  for (const b of items) wireRow(b);
}

function blockRow(b) {
  const st = statusOf(b.id);
  return `<div class="panel" data-id="${esc(b.id)}"><div class="row spread">
    <div class="grow"><button class="link edit" style="font-weight:600;font-size:15px;text-decoration:none;color:inherit">${esc(b.name)}</button>
      <div class="small mute">${b.kind === "device" ? esc({ lock: "Lock screen", signOut: "Sign out", shutDown: "Shut down" }[b.action]) + " · " : `${b.websites.length} sites · ${b.apps.length} apps · `}${b.scheduled ? `${b.slots.length} scheduled slots` : "At all times"}${b.scheduled ? "" : " · " + esc(breakText(b.brk))}</div>
      <div class="row small" style="margin-top:4px;gap:14px">
        <button class="link lock">${esc(lockText(b))}</button>
        <button class="link sched">${b.scheduled ? "Edit schedule" : "Set schedule"}</button>
        ${b.scheduled ? "" : `<button class="link brk">Breaks</button>`}
        <button class="link auto">${esc(autostartText(b.autostart))}</button>
        ${b.enabled && [b.brk, ...b.slots.map((s) => s.brk)].some((c) => c.kind === "pomodoro") ? `<button class="link reset" ${st.locked ? "disabled" : ""}>Reset pomodoro</button>` : ""}
      </div></div>
    <div class="row"><button class="btn small dup">Duplicate</button><button class="btn small remove" ${st.locked ? "disabled" : ""}>Delete</button>
    <label class="switch" title="${st.locked ? "Locked" : "Enable"}"><input type="checkbox" aria-label="Enable ${esc(b.name)}" ${b.enabled ? "checked" : ""} ${st.locked ? "disabled" : ""}><span></span></label></div>
  </div></div>`;
}

function wireRow(b) {
  const root = $(`[data-id="${CSS.escape(b.id)}"]`);
  $(".edit", root).onclick = () => editBlock(structuredClone(b));
  $(".lock", root).onclick = () => lockDialog(b);
  $(".sched", root).onclick = () => scheduleDialog(structuredClone(b));
  $(".brk", root)?.addEventListener("click", () => breakDialog(b.brk, b.kind, async (c) => { const n = structuredClone(b); n.brk = c; await saveBlock(n); }));
  $(".auto", root).onclick = () => autostartDialog(structuredClone(b));
  $(".reset", root)?.addEventListener("click", async () => {
    if (await confirmBox("Reset the pomodoro timer?", "You start at the beginning of a new work period.", "Reset")) await api("resetPomodoro", { id: b.id });
  });
  $(".dup", root).onclick = async () => {
    const n = structuredClone(b);
    n.id = crypto.randomUUID(); n.name = uniqueName(`${b.name} copy`); n.enabled = false; n.lock = defaultLock(); n.autostart = blockTemplate(b.kind).autostart;
    await saveBlock(n);
  };
  $(".remove", root).onclick = async () => {
    if (await confirmBox(`Delete ${b.name}?`, "You lose its websites, apps and exceptions.", "Delete")) {
      try { await api("deleteBlock", { id: b.id }); await refresh(); } catch (e) { reportError(e); }
    }
  };
  $(".switch input", root).onchange = async (e) => {
    const on = e.target.checked;
    if (on && b.kind === "device") {
      const ok = await confirmBox("Start this device block?", "Deadbolt will act on this Mac as soon as the block applies. Note the end time now.", "Start");
      if (!ok) { e.target.checked = false; return; }
    }
    try { await api("setEnabled", { id: b.id, enabled: on }); } catch (err) { reportError(err); }
    await refresh();
  };
}

function uniqueName(base) {
  let name = base, n = 2;
  while (cfg.blocks.some((b) => b.name === name)) name = `${base} ${n++}`;
  return name;
}

async function saveBlock(b) {
  try { await api("saveBlock", { block: b }); await refresh(); return true; }
  catch (e) { reportError(e); return false; }
}

async function refresh() { await load(); render(); }

// ---------- Block editor

function editBlock(b, isNew = false) {
  if (isNew) b.name = uniqueName(b.kind === "device" ? "New device block" : "New block");
  let sub = "websites";
  const m = modal(`<h2>${isNew ? "New block" : esc(b.name)}</h2>
    <label>Name <input type="text" id="name" value="${esc(b.name)}" style="width:100%"></label>
    <div id="body" style="margin-top:12px"></div>
    <p class="err" id="e"></p>
    <div class="foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`);
  const body = $("#body", m.el);

  const list = (key, label) => {
    body.innerHTML = `<div class="tabs"><button data-s="websites" class="${sub === "websites" ? "on" : ""}">Websites</button><button data-s="exceptions" class="${sub === "exceptions" ? "on" : ""}">Website exceptions</button><button data-s="apps" class="${sub === "apps" ? "on" : ""}">Apps</button><button data-s="users">Users</button></div>
      <div class="row"><input type="text" id="entry" class="grow" placeholder="${esc(label)}" aria-label="${esc(label)}"><button class="btn" id="add">Add</button>
      <select id="imp-list" aria-label="Import"><option value="">Import...</option><option value="file">Text file...</option><option value="search">All searches containing...</option><option value="url">All URLs containing...</option><option value="adult">All adult websites</option><option value="internet">The entire internet</option><optgroup label="Pre-made list">${Object.keys(PREMADE).map((k) => `<option value="p:${esc(k)}">${esc(k)}</option>`).join("")}</optgroup></select>
      <button class="btn" id="exp-list">Export...</button></div>
      <input type="file" id="txt" accept=".txt" hidden>
      <div class="entries">${b[key].length ? b[key].map((v, i) => `<div><span>${esc(v)}</span><button data-rm="${i}" aria-label="Remove ${esc(v)}">Remove</button></div>`).join("") : `<div class="mute">Nothing here yet.</div>`}</div>`;
    const add = () => {
      const v = $("#entry", body).value.trim();
      if (!v || v.includes("\\")) return;
      if (!b[key].includes(v)) b[key].push(v);
      draw();
    };
    $("#add", body).onclick = add;
    $("#entry", body).onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } };
    $$("[data-rm]", body).forEach((x) => (x.onclick = () => { b[key].splice(Number(x.dataset.rm), 1); draw(); }));
    $("#exp-list", body).onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([b[key].join("\n")], { type: "text/plain" }));
      a.download = `${b.name}-${key}.txt`;
      a.click();
    };
    $("#txt", body).onchange = async (e) => {
      const lines = (await e.target.files[0].text()).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length > 5000) { $("#e", m.el).textContent = "Only 5000 entries can be added at a time."; return; }
      b[key] = [...new Set([...b[key], ...lines])];
      draw();
    };
    $("#imp-list", body).onchange = async (e) => {
      const v = e.target.value;
      e.target.value = "";
      const addAll = (xs) => { b[key] = [...new Set([...b[key], ...xs])]; draw(); };
      if (v === "file") $("#txt", body).click();
      else if (v === "internet") addAll(["*.*"]);
      else if (v === "adult") addAll(["*.xxx"]);
      else if (v.startsWith("p:")) addAll(PREMADE[v.slice(2)]);
      else if (v === "search" || v === "url") {
        const phrase = await promptBox(v === "search" ? "Search phrase" : "Phrase in the URL", "Spaces become wildcards. Use * for any text.");
        if (phrase) { const w = phrase.trim().replace(/\s+/g, "*"); addAll([v === "search" ? `*.*/*q=*${w}*` : `*${w}*`]); }
      }
    };
  };

  const apps = () => {
    body.innerHTML = `<div class="tabs"><button data-s="websites">Websites</button><button data-s="exceptions">Website exceptions</button><button data-s="apps" class="on">Apps</button><button data-s="users">Users</button></div>
      <div class="row"><button class="btn" data-pick="app">Add app...</button><button class="btn" data-pick="folder">Add folder...</button><button class="btn" data-pick="binary">Add binary...</button></div>
      <div class="entries">${b.apps.length ? b.apps.map((a, i) => `<div><span>${esc(a.path)}</span><button data-rm="${i}" aria-label="Remove ${esc(a.path)}">Remove</button></div>`).join("") : `<div class="mute">No apps added.</div>`}</div>`;
    $$("[data-pick]", body).forEach((x) => (x.onclick = async () => {
      const picked = await api("pickApps", { mode: x.dataset.pick });
      for (const p of picked) if (!b.apps.some((a) => a.path === p.path)) b.apps.push({ isFolder: false, isBinary: false, ...p });
      draw();
    }));
    $$("[data-rm]", body).forEach((x) => (x.onclick = () => { b.apps.splice(Number(x.dataset.rm), 1); draw(); }));
  };

  const usersPane = async () => {
    const names = await api("localUsers");
    if (sub !== "users") return;
    const chosen = () => $$(".ub:checked", body).map((x) => x.value);
    body.innerHTML = `<div class="tabs"><button data-s="websites">Websites</button><button data-s="exceptions">Website exceptions</button><button data-s="apps">Apps</button><button data-s="users" class="on">Users</button></div>
      <label class="row" style="margin:6px 0">Affected users <select id="um" aria-label="Affected users"><option value="all">All users</option><option value="except">All users except</option><option value="only">Only the following users</option></select></label>
      <div id="ulist">${names.map((n) => `<label class="check"><input type="checkbox" class="ub" value="${esc(n)}" ${b.users.includes(n) ? "checked" : ""}> ${esc(n)}</label>`).join("")}</div>
      <p class="mute small">Other accounts follow this block only when Deadbolt is installed for all users.</p>`;
    const mode = $("#um", body);
    mode.value = b.usersMode;
    const sync = () => { $("#ulist", body).style.display = mode.value === "all" ? "none" : ""; };
    sync();
    mode.onchange = () => { b.usersMode = mode.value; sync(); };
    $$(".ub", body).forEach((x) => (x.onchange = () => { b.users = chosen(); }));
    $$("[data-s]", body).forEach((x) => (x.onclick = () => { sub = x.dataset.s; draw(); }));
  };

  const device = () => {
    body.innerHTML = `<h3>When this block applies</h3>
      ${[["lock", "Lock the screen for you."], ["signOut", "Sign you out."], ["shutDown", "Shut this Mac down."]].map(([v, t]) => `<label class="check"><input type="radio" name="act" value="${v}" ${b.action === v ? "checked" : ""}> ${t}</label>`).join("")}`;
    $$("[name=act]", body).forEach((r) => (r.onchange = () => { b.action = r.value; }));
  };

  function draw() {
    if (b.kind === "device") { device(); return; }
    if (sub === "users") { usersPane(); return; }
    if (sub === "apps") apps();
    else if (sub === "websites") list("websites", "Domain, URL or wildcard, like reddit.com");
    else list("exceptions", "Website to allow");
    $$("[data-s]", body).forEach((x) => (x.onclick = () => { sub = x.dataset.s; draw(); }));
  }
  draw();
  $("#cancel", m.el).onclick = m.close;
  $("#save", m.el).onclick = async () => {
    b.name = $("#name", m.el).value;
    try { await api("saveBlock", { block: b }); m.close(); await refresh(); }
    catch (e) { $("#e", m.el).textContent = errorText(e); }
  };
}

function promptBox(title, hint) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><p class="mute">${esc(hint)}</p><input type="text" id="v" style="width:100%"><div class="foot"><button class="btn" id="no">Cancel</button><button class="btn primary" id="ok">Add</button></div>`);
    $("#no", m.el).onclick = () => { m.close(); resolve(null); };
    $("#ok", m.el).onclick = () => { const v = $("#v", m.el).value; m.close(); resolve(v); };
  });
}

// ---------- Breaks

function breakDialog(current, kind, onSave) {
  const c = { ...defaultBreak(), ...current };
  const kinds = [["none", "None"], ["pomodoro", "Pomodoro"], ["allowance", "Allowance"], ["reward", "Reward"], ["randomText", "Random Text"], ["delay", "Delay"], ["sessions", "Sessions"]];
  const m = modal(`<h2>Breaks</h2><div class="pick" id="kinds">${kinds.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join("")}</div><div id="f"></div><p class="err" id="e"></p>
    <div class="foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`);
  const f = $("#f", m.el);
  const num = (key, label, attrs = "") => `<label class="row" style="margin:6px 0">${esc(label)} <input type="number" data-n="${key}" value="${c[key]}" ${attrs}></label>`;
  const periodSel = (rolling = true) => `<label class="row" style="margin:6px 0">Refill <select data-p="period">
     <option value="block">each block</option><option value="daily">each day</option><option value="weekly">each week</option><option value="monthly">each month</option>${rolling ? `<option value="rolling">rolling window</option>` : ""}</select></label>
     <label class="row" data-when="rolling" style="margin:6px 0">Window, minutes <input type="number" data-n="rollingMinutes" value="${c.rollingMinutes}"></label>
     <label class="row" data-when="weekly" style="margin:6px 0">Refill day <select data-w="refillWeekday">${DAYS.map((d, i) => `<option value="${i}" ${c.refillWeekday === i ? "selected" : ""}>${d}</option>`).join("")}</select></label>
     <label class="row" data-when="clock" style="margin:6px 0">Refill time <input type="time" data-t="refillMinute" value="${toTime(c.refillMinute)}"></label>`;
  const forms = {
    none: () => `<p class="mute">No breaks for the duration of this block.</p>`,
    pomodoro: () => num("workMinutes", kind === "device" ? "Block device, minutes" : "Block, minutes", "min=1 max=999") + num("breakMinutes", "Then allow, minutes", "min=1 max=999") + `<p class="mute small">Starts with blocked time, then repeats.</p>`,
    allowance: () => num("allowanceMinutes", "Allow a total of, minutes", "min=1") + periodSel(),
    reward: () => num("workMinutes", "After every, minutes", "min=1 max=999") + `<label class="row" style="margin:6px 0">spent <select data-p="rewardMode"><option value="working">working</option><option value="inactive">inactive</option></select></label>` + num("breakMinutes", "Reward, minutes", "min=1 max=999") + periodSel(false),
    randomText: () => num("breakMinutes", "Break length, minutes", "min=1 max=1440") + num("textLength", "Characters to type", "min=1 max=5000") + `<label class="row" style="margin:6px 0">Text <select data-p="textKind"><option value="words">random words</option><option value="gibberish">random gibberish</option><option value="custom">custom text</option></select></label><textarea data-s="customText" placeholder="Custom text" aria-label="Custom text">${esc(c.customText)}</textarea>
      <label class="check"><input type="checkbox" data-c="hideTypos" ${c.hideTypos ? "checked" : ""}> Hide where typos are</label><label class="check"><input type="checkbox" data-c="keepText" ${c.keepText ? "checked" : ""}> Keep typed text after a mismatch</label>`,
    delay: () => num("breakMinutes", "Break length, minutes", "min=1 max=1440") + num("delaySeconds", "Countdown, seconds", "min=1"),
    sessions: () => num("sessions", "Sessions allowed", "min=1") + periodSel() + num("maxSessionMinutes", "Maximum session, minutes (0 for none)", "min=0"),
  };
  const draw = () => {
    $$("#kinds button", m.el).forEach((b) => b.classList.toggle("on", b.dataset.v === c.kind));
    f.innerHTML = forms[c.kind]();
    $$("[data-n]", f).forEach((i) => (i.oninput = () => { c[i.dataset.n] = Number(i.value); }));
    $$("[data-t]", f).forEach((i) => (i.oninput = () => { c[i.dataset.t] = parseTime(i.value); }));
    $$("[data-w]", f).forEach((i) => (i.onchange = () => { c[i.dataset.w] = Number(i.value); }));
    $$("[data-c]", f).forEach((i) => (i.onchange = () => { c[i.dataset.c] = i.checked; }));
    $$("[data-s]", f).forEach((i) => (i.oninput = () => { c[i.dataset.s] = i.value; }));
    $$("[data-p]", f).forEach((i) => { i.value = c[i.dataset.p]; i.onchange = () => { c[i.dataset.p] = i.value; syncPeriod(); }; });
    syncPeriod();
  };
  const syncPeriod = () => {
    $$("[data-when=rolling]", f).forEach((e) => (e.style.display = c.period === "rolling" ? "" : "none"));
    $$("[data-when=clock]", f).forEach((e) => (e.style.display = ["daily", "weekly"].includes(c.period) ? "" : "none"));
    $$("[data-when=weekly]", f).forEach((e) => (e.style.display = c.period === "weekly" ? "" : "none"));
  };
  $$("#kinds button", m.el).forEach((b) => (b.onclick = () => { c.kind = b.dataset.v; draw(); }));
  draw();
  $("#cancel", m.el).onclick = m.close;
  $("#save", m.el).onclick = async () => { m.close(); await onSave(c); };
}

// ---------- Locks

function lockDialog(b) {
  const st = statusOf(b.id);
  if (st.locked || b.lock.kind !== "none") { unlockDialog(b, st); return; }
  const l = defaultLock();
  l.kind = "timer";
  const kinds = [["none", "None"], ["timer", "Timer"], ["randomText", "Random Text"], ["delay", "Delay"], ["timeRange", "Time Range"], ["password", "Password"]];
  // A schedule lock opens between slots. A full week has none, so it could never be undone.
  const coversWeek = b.scheduled && b.slots.reduce((n, s) => n + s.end - s.start, 0) >= 7 * 1440;
  if (b.scheduled && !coversWeek) kinds.push(["schedule", "Schedule"]);
  if (!b.scheduled) kinds.push(["restart", "Restart"]);
  const presets = [[5, "5 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [480, "8 hours"], [1440, "1 day"], [10080, "1 week"]];
  const m = modal(`<h2>Lock ${esc(b.name)}</h2><div class="pick" id="kinds">${kinds.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join("")}</div><div id="f"></div><p class="err" id="e"></p>
    <div class="foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Lock</button></div>`);
  const f = $("#f", m.el);
  let password = "", password2 = "", minutesFromNow = 60;
  const forms = {
    none: () => `<p class="mute">Don't lock this block. Changes stay allowed.</p>`,
    timer: () => `<label class="row" style="margin:6px 0">Lock for <select id="preset">${presets.map(([v, t]) => `<option value="${v}" ${v === minutesFromNow ? "selected" : ""}>${t}</option>`).join("")}<option value="custom">these date and time</option></select></label>
      <input type="datetime-local" id="until" style="display:none" aria-label="Lock until">
      <label class="check"><input type="checkbox" id="auto"> Automatically disable the block when unlocked</label>`,
    randomText: () => `<label class="row" style="margin:6px 0">Characters <input type="number" id="len" value="${l.textLength}" min="1" max="5000"></label>
      <label class="row" style="margin:6px 0">Text <select id="tk"><option value="words">random words</option><option value="gibberish">random gibberish</option><option value="custom">custom text</option></select></label>
      <textarea id="custom" placeholder="Custom text" aria-label="Custom text" style="display:none"></textarea>`,
    delay: () => `<label class="row" style="margin:6px 0">Wait, minutes <input type="number" id="dmin" value="5" min="1" max="57600"></label><p class="mute small">You start the countdown when you want out, and you can cancel it.</p>`,
    timeRange: () => `<div class="row"><label>From <input type="time" id="rs" value="${toTime(l.rangeStart)}"></label><label>to <input type="time" id="re" value="${toTime(l.rangeEnd)}"></label></div>
      <div class="days" style="margin:8px 0">${DAYS.map((d, i) => `<label><input type="checkbox" class="rd" value="${i}" ${l.rangeDays.includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div>
      <label class="check"><input type="checkbox" id="inv"> Unlock only during this range</label>`,
    password: () => `<input type="password" id="p1" placeholder="Password" aria-label="Password" style="width:100%;margin-bottom:6px"><input type="password" id="p2" placeholder="Re-enter password" aria-label="Re-enter password" style="width:100%"><p class="mute small">Have someone else set this for real protection.</p>`,
    schedule: () => `<p class="mute">Locked during scheduled blocks.</p><label class="row">Also lock this early, minutes <input type="number" id="early" value="0" min="0" max="1440"></label>`,
    restart: () => `<p class="mute">Locked until this Mac restarts.</p>`,
  };
  const draw = () => {
    $$("#kinds button", m.el).forEach((x) => x.classList.toggle("on", x.dataset.v === l.kind));
    f.innerHTML = forms[l.kind]();
    $("#preset", f)?.addEventListener("change", (e) => {
      const custom = e.target.value === "custom";
      $("#until", f).style.display = custom ? "" : "none";
      if (!custom) minutesFromNow = Number(e.target.value);
    });
    $("#tk", f)?.addEventListener("change", (e) => { $("#custom", f).style.display = e.target.value === "custom" ? "" : "none"; });
  };
  $$("#kinds button", m.el).forEach((x) => (x.onclick = () => { l.kind = x.dataset.v; draw(); }));
  draw();
  $("#cancel", m.el).onclick = m.close;
  $("#save", m.el).onclick = async () => {
    const args = { id: b.id, lock: l };
    if (l.kind === "timer") {
      const p = $("#preset", f).value;
      l.until = p === "custom" ? new Date($("#until", f).value).getTime() / 1000 : Date.now() / 1000 + Number(p) * 60;
      l.autoDisable = $("#auto", f).checked;
    } else if (l.kind === "randomText") {
      l.textLength = Number($("#len", f).value);
      l.textKind = $("#tk", f).value;
      l.text = $("#custom", f).value;
    } else if (l.kind === "delay") {
      l.delaySeconds = Number($("#dmin", f).value) * 60;
    } else if (l.kind === "timeRange") {
      l.rangeStart = parseTime($("#rs", f).value);
      l.rangeEnd = parseTime($("#re", f).value);
      l.rangeDays = $$(".rd:checked", f).map((x) => Number(x.value));
      l.rangeInverted = $("#inv", f).checked;
    } else if (l.kind === "password") {
      password = $("#p1", f).value; password2 = $("#p2", f).value;
      if (password !== password2) { $("#e", m.el).textContent = "Your passwords did not match."; return; }
      args.newPassword = password;
    } else if (l.kind === "schedule") {
      l.earlyMinutes = Number($("#early", f).value);
    }
    if (l.kind !== "none") {
      const ok = await confirmBox("Lock this block?", `<p>A locked block will:</p><ul><li>Prevent you from disabling the block</li><li>Close your browser if you remove the extension</li><li>Stop you from uninstalling Deadbolt</li><li>Lock certain settings</li></ul>`, "Lock");
      if (!ok) return;
    }
    try { await api("lock", args); m.close(); await refresh(); }
    catch (e) { $("#e", m.el).textContent = errorText(e); }
  };
}

function unlockDialog(b, st) {
  const l = b.lock;
  const parts = { timer: `<p>This block stays locked until ${esc(fmtDate(l.until))}.</p><label class="row">Extend until <input type="datetime-local" id="ext"></label>`,
    randomText: `<p>Type this text to unlock.</p><div class="panel small" id="txt" style="user-select:none;-webkit-user-select:none;overflow-wrap:anywhere">${esc(l.text)}</div><textarea id="typed" aria-label="Type the text"></textarea>`,
    delay: st.unlockAt ? `<p>This block unlocks at ${esc(fmtDate(st.unlockAt))}. You can cancel the countdown.</p>` : `<p>This block unlocks ${esc(fmtSpan(l.delaySeconds))} after you start the countdown.</p>`,
    password: `<input type="password" id="pw" placeholder="Password" aria-label="Password" style="width:100%">`,
    timeRange: `<p>${esc(lockText(b))}.</p>`, schedule: `<p>${esc(lockText(b))}.</p>`, restart: `<p>This block unlocks after this Mac restarts.</p>` };
  const canSubmit = l.kind === "randomText" || l.kind === "password" || !st.locked;
  const m = modal(`<h2>Unlock ${esc(b.name)}</h2>${parts[l.kind] ?? ""}
    ${cfg.settings.passwordUnlocksBlocks && cfg.hasPassword ? `<input type="password" id="sp" placeholder="Or the settings password" aria-label="Settings password" style="width:100%;margin-top:8px">` : ""}
    <p class="err" id="e"></p><div class="foot"><button class="btn" id="cancel">Close</button>
    ${l.kind === "timer" ? `<button class="btn" id="extend">Extend</button>` : ""}
    ${l.kind === "delay" ? (st.unlockAt ? `<button class="btn" id="cancel-unlock">Cancel unlock</button>` : `<button class="btn primary" id="start-unlock">Start unlocking</button>`) : ""}
    ${canSubmit || (cfg.settings.passwordUnlocksBlocks && cfg.hasPassword) ? `<button class="btn primary" id="unlock">Unlock</button>` : ""}</div>`);
  $("#typed", m.el)?.addEventListener("paste", (e) => e.preventDefault());
  $("#cancel", m.el).onclick = m.close;
  $("#extend", m.el)?.addEventListener("click", async () => {
    const until = new Date($("#ext", m.el).value).getTime() / 1000;
    try { await api("lock", { id: b.id, lock: { ...l, until } }); m.close(); await refresh(); } catch (e) { $("#e", m.el).textContent = errorText(e); }
  });
  $("#start-unlock", m.el)?.addEventListener("click", async () => { await api("startUnlock", { id: b.id }); m.close(); await refresh(); });
  $("#cancel-unlock", m.el)?.addEventListener("click", async () => { await api("cancelUnlock", { id: b.id }); m.close(); await refresh(); });
  $("#unlock", m.el)?.addEventListener("click", async () => {
    try {
      await api("unlock", { id: b.id, text: $("#typed", m.el)?.value, password: $("#pw", m.el)?.value ?? "", settingsPassword: $("#sp", m.el)?.value });
      m.close(); await refresh();
    } catch (e) { $("#e", m.el).textContent = errorText(e); }
  });
}

// ---------- Autostart

function autostartDialog(b) {
  const a = b.autostart;
  const m = modal(`<h2>Autostart ${esc(b.name)}</h2>
    <label class="row" style="margin:6px 0">When <select id="k"><option value="none">Don't autostart</option><option value="oneTime">One time</option><option value="timeOfDay">Time of day</option><option value="signIn">Sign in or wake</option>${b.scheduled ? `<option value="schedule">Next scheduled block</option>` : ""}</select></label>
    <div id="f"></div>
    <label class="row" style="margin:8px 0">Lock for, minutes after starting (0 for none) <input type="number" id="dur" value="${a.durationMinutes}" min="0"></label>
    <label class="check"><input type="checkbox" id="lockset" ${a.lockSettings ? "checked" : ""}> Lock the block and autostart settings until the block starts</label>
    <p class="err" id="e"></p><div class="foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`);
  const f = $("#f", m.el), k = $("#k", m.el);
  k.value = a.kind;
  const draw = () => {
    if (k.value === "oneTime") f.innerHTML = `<label class="row">At <input type="datetime-local" id="at"></label>`;
    else if (k.value === "timeOfDay") f.innerHTML = `<label class="row">At <input type="time" id="tm" value="${toTime(a.minute)}"></label><div class="days" style="margin:8px 0">${DAYS.map((d, i) => `<label><input type="checkbox" class="ad" value="${i}" ${a.days.includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div>`;
    else f.innerHTML = "";
  };
  k.onchange = draw;
  draw();
  $("#cancel", m.el).onclick = m.close;
  $("#save", m.el).onclick = async () => {
    a.kind = k.value;
    a.durationMinutes = Number($("#dur", m.el).value);
    a.lockSettings = $("#lockset", m.el).checked;
    if (a.kind === "oneTime") {
      a.at = new Date($("#at", f).value).getTime() / 1000;
      if (!(a.at > Date.now() / 1000 + 120)) { $("#e", m.el).textContent = "The autostart time needs to be at least 2 minutes from now."; return; }
    } else if (a.kind === "timeOfDay") {
      a.minute = parseTime($("#tm", f).value);
      a.days = $$(".ad:checked", f).map((x) => Number(x.value));
      if (!a.days.length) { $("#e", m.el).textContent = "Autostart requires at least one day to be selected."; return; }
    }
    if (await saveBlock(b)) m.close();
  };
}

// ---------- Schedule

function scheduleDialog(b) {
  let showOthers = false;
  const hourPx = 30, minutePx = hourPx / 60;
  const m = modal(`<h2>Schedule for ${esc(b.name)}</h2>
    <div class="row spread" style="margin-bottom:8px">
      <div class="pick" style="margin:0"><button id="all" class="${b.scheduled ? "" : "on"}">At all times</button><button id="sch" class="${b.scheduled ? "on" : ""}">According to this schedule</button></div>
      <label class="row small"><input type="checkbox" id="others"> Show other enabled blocks</label></div>
    <div id="sg"></div><p class="err" id="e"></p>
    <div class="foot"><button class="btn" id="clear">Remove all</button><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`, { wide: true });
  const sg = $("#sg", m.el);

  const draw = () => {
    $("#all", m.el).classList.toggle("on", !b.scheduled);
    $("#sch", m.el).classList.toggle("on", b.scheduled);
    if (!b.scheduled) { sg.innerHTML = `<p class="mute">This block runs continuously while enabled.</p>`; return; }
    const hours = Array.from({ length: 24 }, (_, h) => `<span style="top:${h * hourPx}px">${fmtTime(h * 60)}</span>`).join("");
    const others = showOthers ? cfg.blocks.filter((o) => o.id !== b.id && o.enabled && o.scheduled) : [];
    sg.innerHTML = `<div class="grid"><div></div>${DAYS.map((d) => `<div class="head">${d}</div>`).join("")}</div>
      <div class="scroll-grid"><div class="grid"><div class="hours">${hours}</div>${DAYS.map((_, wd) => `<div class="day" data-wd="${wd}">
        ${others.flatMap((o) => o.slots.filter((s) => s.weekday === wd).map((s) => `<div class="slot other" style="top:${s.start * minutePx}px;height:${(s.end - s.start) * minutePx}px">${esc(o.name)}</div>`)).join("")}
        ${b.slots.map((s, i) => (s.weekday === wd ? `<button class="slot" data-i="${i}" style="top:${s.start * minutePx}px;height:${(s.end - s.start) * minutePx}px">${fmtTime(s.start)} to ${fmtTime(s.end)}${s.brk.kind !== "none" ? ` · ${esc(s.brk.kind)}` : ""}</button>` : "")).join("")}
      </div>`).join("")}</div></div>`;
    $$(".slot[data-i]", sg).forEach((el) => (el.onclick = (e) => { e.stopPropagation(); slotDialog(b, Number(el.dataset.i), draw); }));
    $$(".day", sg).forEach((day) => {
      let startMin = null, draft = null;
      const minuteAt = (ev) => Math.max(0, Math.min(1440, Math.round((ev.clientY - day.getBoundingClientRect().top) / minutePx / 15) * 15));
      day.onpointerdown = (ev) => {
        if (ev.target !== day) return;
        startMin = minuteAt(ev);
        draft = document.createElement("div");
        draft.className = "slot draft";
        day.append(draft);
        day.setPointerCapture(ev.pointerId);
      };
      day.onpointermove = (ev) => {
        if (startMin === null) return;
        const cur = minuteAt(ev), a = Math.min(startMin, cur), z = Math.max(startMin, cur);
        draft.style.top = `${a * minutePx}px`;
        draft.style.height = `${(z - a) * minutePx}px`;
        draft.textContent = `${fmtTime(a)} to ${fmtTime(z)}`;
      };
      day.onpointerup = (ev) => {
        if (startMin === null) return;
        const cur = minuteAt(ev), a = Math.min(startMin, cur), z = Math.max(startMin, cur);
        startMin = null;
        draft?.remove();
        if (z - a < 15) return;
        const wd = Number(day.dataset.wd);
        if (b.slots.some((s) => s.weekday === wd && a < s.end && z > s.start)) {
          $("#e", m.el).textContent = "You can't have overlapping blocks since blocks have a unique break type.";
          return;
        }
        $("#e", m.el).textContent = "";
        b.slots.push({ weekday: wd, start: a, end: z, brk: defaultBreak() });
        draw();
      };
    });
  };
  $("#all", m.el).onclick = () => { b.scheduled = false; draw(); };
  $("#sch", m.el).onclick = () => { b.scheduled = true; draw(); };
  $("#others", m.el).onchange = (e) => { showOthers = e.target.checked; draw(); };
  $("#clear", m.el).onclick = () => { b.slots = []; draw(); };
  $("#cancel", m.el).onclick = m.close;
  $("#save", m.el).onclick = async () => { if (await saveBlock(b)) m.close(); };
  draw();
}

function slotDialog(b, i, redraw) {
  const s = b.slots[i];
  const m = modal(`<h2>${DAYS[s.weekday]} block</h2>
    <div class="row"><label>Start <input type="time" id="st" step="300" value="${toTime(s.start)}"></label><label>End <input type="time" id="en" step="300" value="${s.end === 1440 ? "23:59" : toTime(s.end)}"></label></div>
    <h3>Copy to</h3><div class="days">${DAYS.map((d, wd) => `<label><input type="checkbox" class="cd" value="${wd}" ${wd === s.weekday ? "checked disabled" : ""}> ${d}</label>`).join("")}</div>
    <p style="margin-top:12px"><span class="mute">Breaks:</span> <button class="link" id="brk">${esc(breakText(s.brk))}</button></p><p class="err" id="e"></p>
    <div class="foot"><button class="btn" id="rm">Remove</button><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="ok">Apply</button></div>`);
  $("#brk", m.el).onclick = () => breakDialog(s.brk, b.kind, (c) => { s.brk = c; $("#brk", m.el).textContent = breakText(c); });
  $("#cancel", m.el).onclick = m.close;
  $("#rm", m.el).onclick = () => { b.slots.splice(i, 1); m.close(); redraw(); };
  $("#ok", m.el).onclick = () => {
    const end = $("#en", m.el).value === "23:59" ? 1440 : parseTime($("#en", m.el).value);
    const start = parseTime($("#st", m.el).value);
    const days = [s.weekday, ...$$(".cd:checked:not(:disabled)", m.el).map((x) => Number(x.value))];
    for (const wd of days) {
      const clash = b.slots.some((o, j) => j !== i && o.weekday === wd && start < o.end && end > o.start);
      if (clash || start >= end) { $("#e", m.el).textContent = "You can't have overlapping blocks since blocks have a unique break type."; return; }
    }
    s.start = start; s.end = end;
    for (const wd of days.slice(1)) b.slots.push({ weekday: wd, start, end, brk: structuredClone(s.brk) });
    m.close();
    redraw();
  };
}

// ---------- Statistics

function dateRange() {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const d = new Date(), y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
  const startWeek = day - ((d.getDay() - cfg.settings.firstWeekday + 7) % 7);
  switch (statsRange) {
    case "today": return [iso(d), iso(d)];
    case "yesterday": return [iso(new Date(y, mo, day - 1)), iso(new Date(y, mo, day - 1))];
    case "week": return [iso(new Date(y, mo, startWeek)), iso(d)];
    case "lastweek": return [iso(new Date(y, mo, startWeek - 7)), iso(new Date(y, mo, startWeek - 1))];
    case "month": return [iso(new Date(y, mo, 1)), iso(d)];
    case "lastmonth": return [iso(new Date(y, mo - 1, 1)), iso(new Date(y, mo, 0))];
    case "last7": return [iso(new Date(y, mo, day - 6)), iso(d)];
    case "last30": return [iso(new Date(y, mo, day - 29)), iso(d)];
    case "custom": return [customFrom || iso(d), customTo || iso(d)];
  }
}

async function renderStats() {
  const [from, to] = dateRange();
  const data = await api("stats", { from, to });
  const sum = (rows, key, val) => {
    const out = new Map();
    for (const r of rows) out.set(r[key], (out.get(r[key]) || 0) + r[val]);
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  };
  let rows = [], format = fmtSpan, total = 0;
  if (statsSub === "blocked") { rows = sum(data.blocked, "item", "count"); format = (n) => `${n}`; }
  if (statsSub === "web") rows = sum(data.usage.filter((u) => u.kind === "web"), "item", "seconds");
  if (statsSub === "app") rows = sum(data.usage.filter((u) => u.kind === "app"), "item", "seconds");
  if (statsSub === "active") rows = sum(data.active, "day", "seconds").sort((a, b) => a[0].localeCompare(b[0]));
  if (statsSearch) rows = rows.filter(([k]) => k.toLowerCase().includes(statsSearch.toLowerCase()));
  total = rows.reduce((a, [, v]) => a + v, 0);
  const shown = statsSub === "active" ? rows : rows.slice(0, statsSearch ? 10 : statsTop);
  const max = Math.max(1, ...shown.map(([, v]) => v));
  const subs = [["blocked", "Block statistics"], ["web", "Website statistics"], ["app", "App statistics"], ["active", "Time with active blocks"]];
  const ranges = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["lastweek", "Last week"], ["month", "This month"], ["lastmonth", "Last month"], ["last7", "Last 7 days"], ["last30", "Last 30 days"], ["custom", "These dates"]];
  $("#view").innerHTML = `<div class="row spread"><h1 style="margin:0">Statistics</h1><div class="row"><button class="btn" id="csv">Export to CSV</button><button class="btn" id="wipe">Delete all</button></div></div>
    <div class="tabs" style="margin-top:14px">${subs.map(([k, t]) => `<button data-sub="${k}" class="${statsSub === k ? "on" : ""}">${t}</button>`).join("")}</div>
    <div class="row" style="margin-bottom:12px"><select id="range" aria-label="Date range">${ranges.map(([k, t]) => `<option value="${k}" ${statsRange === k ? "selected" : ""}>${t}</option>`).join("")}</select>
      ${statsRange === "custom" ? `<input type="date" id="cf" value="${from}" aria-label="From"><input type="date" id="ct" value="${to}" aria-label="To">` : ""}
      ${statsSub === "active" ? "" : `<select id="top" aria-label="Rows"><option value="5" ${statsTop === 5 ? "selected" : ""}>Top 5</option><option value="10" ${statsTop === 10 ? "selected" : ""}>Top 10</option></select>
      <input type="text" id="search" value="${esc(statsSearch)}" placeholder="Search" aria-label="Search">`}
      <span class="mute">Total ${format(total)}</span></div>
    <div class="panel">${shown.length ? shown.map(([k, v]) => `<div class="bar"><div title="${esc(k)}">${esc(k)}</div><div><i style="width:${(v / max) * 100}%"></i></div><div class="mute" style="text-align:right">${format(v)}</div></div>`).join("") : `<p class="mute" style="margin:0">No data for this range.</p>`}</div>`;
  $$("[data-sub]").forEach((b) => (b.onclick = () => { statsSub = b.dataset.sub; renderStats(); }));
  $("#range").onchange = (e) => { statsRange = e.target.value; renderStats(); };
  $("#top")?.addEventListener("change", (e) => { statsTop = Number(e.target.value); renderStats(); });
  $("#search")?.addEventListener("change", (e) => { statsSearch = e.target.value; renderStats(); });
  $("#cf")?.addEventListener("change", (e) => { customFrom = e.target.value; renderStats(); });
  $("#ct")?.addEventListener("change", (e) => { customTo = e.target.value; renderStats(); });
  $("#csv").onclick = async () => { try { alertBox("Exported", esc(await api("exportStats", { from, to }))); } catch (e) { reportError(e); } };
  $("#wipe").onclick = async () => {
    if (await confirmBox("Delete all statistics?", "All statistics live on this Mac. This permanently removes them.", "Delete")) {
      try { await api("deleteStats"); renderStats(); } catch (e) { reportError(e); }
    }
  };
}

// ---------- Settings

const SETTINGS = {
  Preferences: [
    { h: "Display and formatting" },
    { k: "theme", t: "App theme", o: [["system", "System"], ["light", "Light"], ["dark", "Dark"]] },
    { k: "firstWeekday", t: "First day of the week", o: [[6, "Saturday"], [0, "Sunday"], [1, "Monday"]], n: true },
    { k: "use24h", t: "Use 24-hour time" },
    { h: "Hints" },
    { k: "extensionErrorDialog", t: "Warn when a browser extension is missing" },
    { k: "noLockHint", t: "Show a hint when no enabled block is locked" },
    { k: "emptyScheduleHint", t: "Show a hint when a scheduled block has no times" },
    { h: "Statistics" },
    { k: "statsEnabled", t: "Enable statistics (required for allowance, reward and session breaks). Everything stays on this Mac." },
    { k: "statsIncognito", t: "Include incognito windows" },
  ],
  "Block strictness": [
    { note: "These can't be turned off during a locked block." },
    { k: "appAction", t: "Action when blocking apps", o: [["forceClose", "Force close"], ["minimize", "Hide"]] },
    { k: "blockInactiveTabs", t: "Block inactive browser tabs" },
    { k: "blockEmbedded", t: "Block embedded content from blocked websites" },
    { h: "Break strictness" },
    { k: "countInactive", t: "Count inactive tabs and background apps towards allowance and reward" },
    { k: "requireUnblockPress", t: "Show the block page first on usage based breaks. The Unblock button starts the break" },
    { h: "Bypass prevention" },
    { all: ["blockUnsupportedBrowsers", "blockFinderPreviews", "blockActivityMonitor", "blockDateTime", "blockUsersGroups", "blockLoginItems", "blockScreenTime"], t: "Turn on all bypass prevention, except Terminal" },
    { k: "blockUnsupportedBrowsers", t: "Close unsupported browsers, including Safari, while a block with websites is active" },
    { k: "blockFinderPreviews", t: "Block Quick Look previews while a block is active" },
    { k: "blockActivityMonitor", t: "Block Activity Monitor while a block is active" },
    { k: "blockTerminal", t: "Close Terminal and other terminal apps while a block is locked" },
    { k: "blockDateTime", t: "Block Date & Time settings (needs Accessibility)" },
    { k: "blockUsersGroups", t: "Block Users & Groups settings (needs Accessibility)" },
    { k: "blockLoginItems", t: "Block Login Items settings (needs Accessibility)" },
    { k: "blockScreenTime", t: "Block Screen Time settings (needs Accessibility)" },
    { h: "Extensions" },
    { k: "allowFileUrls", t: "Allow file URLs, such as PDFs opened in the browser" },
    { k: "extensionGraceSeconds", t: "Seconds to re-enable an extension before the browser closes", num: true },
  ],
  "Adult filter": [
    { k: "autoBlockAdult", t: "Automatically block porn and other adult sites" },
    { note: "Known adult sites are blocked on this Mac. For other unfamiliar sites, Deadbolt sends the host name, page title and page description to DeepSeek through OpenCode, in private windows too. Common sites and local addresses are never sent." },
  ],
  Notifications: [
    { h: "Blocks" },
    { k: "notifyAppBlocked", t: "When an app is blocked" },
    { k: "notifyTimerEnd", t: "When a timer lock ends" },
    { k: "notifyRange", t: "When a time range lock starts and ends" },
    { k: "notifyDelayEnd", t: "When a delay lock ends" },
    { h: "Schedule" },
    { k: "notifyScheduleStart", t: "When a scheduled block starts" },
    { k: "notifyScheduleEnd", t: "When a scheduled block ends" },
    { k: "scheduleWarnings", t: "Minutes of warning, comma separated", text: true },
    { h: "Breaks" },
    { k: "notifyBreak", t: "When a pomodoro break starts and ends" },
    { k: "notifyAllowanceOut", t: "When an allowance or reward runs out" },
    { k: "allowanceWarnings", t: "Minutes of warning, comma separated", text: true },
    { h: "Autostart" },
    { k: "notifyAutostart", t: "When a block autostarts" },
    { k: "autostartWarnings", t: "Minutes of warning, comma separated", text: true },
  ],
};
let settingsSub = "Preferences";

function renderSettings() {
  const s = cfg.settings;
  const tabs = [...Object.keys(SETTINGS), "Password"];
  const fields = settingsSub === "Password" ? passwordForm() : SETTINGS[settingsSub].map((f) => {
    if (f.h) return `<h3>${esc(f.h)}</h3>`;
    if (f.note) return `<p class="mute">${esc(f.note)}</p>`;
    if (f.all) return `<p><button class="btn" id="all-bypass">${esc(f.t)}</button></p>`;
    if (f.o) return `<label class="row" style="margin:8px 0">${esc(f.t)} <select data-k="${f.k}" ${f.n ? 'data-num="1"' : ""}>${f.o.map(([v, t]) => `<option value="${v}" ${String(s[f.k]) === String(v) ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
    if (f.num) return `<label class="row" style="margin:8px 0">${esc(f.t)} <input type="number" min="0" data-k="${f.k}" data-num="1" value="${s[f.k]}"></label>`;
    if (f.text) return `<label class="row" style="margin:8px 0">${esc(f.t)} <input type="text" data-k="${f.k}" value="${esc(s[f.k])}"></label>`;
    return `<label class="check"><input type="checkbox" data-k="${f.k}" ${s[f.k] ? "checked" : ""}> ${esc(f.t)}</label>`;
  }).join("");
  $("#view").innerHTML = `<h1>Settings</h1><div class="tabs">${tabs.map((t) => `<button data-t="${esc(t)}" class="${t === settingsSub ? "on" : ""}">${esc(t)}</button>`).join("")}</div><div class="panel">${fields}</div>`;
  $$("[data-t]").forEach((b) => (b.onclick = () => { settingsSub = b.dataset.t; renderSettings(); }));
  if (settingsSub === "Password") { wirePassword(); return; }
  if (settingsSub === "Adult filter") renderAdultSites();
  $("#all-bypass")?.addEventListener("click", async () => {
    const keys = SETTINGS[settingsSub].find((f) => f.all).all;
    try { await api("saveSettings", { settings: { ...cfg.settings, ...Object.fromEntries(keys.map((k) => [k, true])) } }); } catch (e) { reportError(e); }
    await refresh();
  });
  $$("[data-k]").forEach((el) => (el.onchange = async () => {
    const next = { ...cfg.settings };
    next[el.dataset.k] = el.type === "checkbox" ? el.checked : el.dataset.num ? Number(el.value) : el.value;
    try { await api("saveSettings", { settings: next }); } catch (e) { reportError(e); }
    await refresh();
  }));
}

async function renderAdultSites() {
  const d = await api("adultSites");
  const names = { adult: "Blocked", checking: "Checking", allowed: "Allowed by you" };
  const box = document.createElement("div");
  box.innerHTML = `<h3>Classified sites</h3>
    ${d.lastError ? `<p class="err">${esc(d.lastError)}</p>` : ""}
    <p class="mute">${d.cleanCount} sites checked and clean. ${d.modelCalls} of ${d.dailyLimit} model checks used today.</p>
    <div class="row" style="margin:8px 0"><input id="allow-host" placeholder="Wrongly blocked site, such as example.com" aria-label="Site to allow" class="grow"><button class="btn" id="allow-add">Allow</button></div>
    ${d.sites.map((s) => `<div class="row spread" style="margin:6px 0" data-host="${esc(s.host)}"><span>${esc(s.host)} <span class="small mute">${esc(names[s.label])}, ${esc(s.source)}</span></span>
      <span class="row">${s.label === "allowed" ? "" : `<button class="btn small allow">Allow</button>`}<button class="btn small forget">Recheck</button></span></div>`).join("")}`;
  $("#view .panel")?.append(box);
  const act = async (cmd, host) => { try { await api(cmd, { host }); } catch (e) { reportError(e); } await refresh(); };
  $("#allow-add", box).onclick = () => act("adultAllow", $("#allow-host", box).value.trim());
  $$("[data-host]", box).forEach((row) => {
    $(".allow", row)?.addEventListener("click", () => act("adultAllow", row.dataset.host));
    $(".forget", row).onclick = () => act("adultForget", row.dataset.host);
  });
}

function passwordForm() {
  const s = cfg.settings;
  const c = (k, t) => `<label class="check"><input type="checkbox" data-pw="${k}" ${s[k] ? "checked" : ""}> ${esc(t)}</label>`;
  return `<h3>Set settings password</h3><p class="mute">Case sensitive. A blank password disables it.</p>
    <div class="row"><input type="password" id="p1" placeholder="Enter password" aria-label="Enter password"><input type="password" id="p2" placeholder="Confirm password" aria-label="Confirm password"><button class="btn" id="setpw">Set</button></div><p class="err" id="pe"></p>
    <h3>Lock and unlock blocks</h3>${c("passwordUnlocksBlocks", "Allow the settings password to unlock all blocks")}${c("passwordLocksAll", "Lock all blocks with the settings password")}
    <h3>Require the settings password for</h3>${c("passwordRestrictDashboard", "Dashboard")}${c("passwordRestrictBlocks", "Blocks")}${c("passwordRestrictStats", "Statistics")}
    <h3>Also prevent, without the password</h3>${c("passwordRestrictStart", "Starting blocks")}${c("passwordRestrictEdit", "Editing blocks")}`;
}

function wirePassword() {
  $("#setpw").onclick = async () => {
    const a = $("#p1").value, b = $("#p2").value;
    if (a !== b) { $("#pe").textContent = "Your passwords did not match."; return; }
    try {
      await api("setPassword", { newPassword: a });
      settingsPassword = a;
      await refresh();
      alertBox("Done", a ? "Your password is set." : "Your password is cleared.");
    } catch (e) { $("#pe").textContent = errorText(e); }
  };
  $$("[data-pw]").forEach((el) => (el.onchange = async () => {
    const next = { ...cfg.settings, [el.dataset.pw]: el.checked };
    try { await api("saveSettings", { settings: next }); } catch (e) { reportError(e); }
    await refresh();
  }));
}

$$("nav button").forEach((b) => (b.onclick = () => go(b.dataset.tab)));
(async () => {
  try {
    await load();
    if (needsPassword(tab) && !(await askPassword())) { $("#view").innerHTML = `<p class="mute">Locked.</p>`; return; }
    render();
    setInterval(async () => {
      if ($("#modal-root").children.length || tab !== "dashboard") return;
      await load();
      render();
    }, 5000);
  } catch (e) {
    $("#view").innerHTML = `<div class="panel warn">${esc(errorText(e))}</div>`;
  }
})();
