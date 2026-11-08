if (typeof importScripts === "function" && typeof blockMatches === "undefined") importScripts("matcher.js");

const BLOCK_PAGE = chrome.runtime.getURL("block.html");
let rules = { blocks: [], settings: {} };
let port = null;
let online = false;
let nextReq = 1;
const pending = new Map();
const adultTabs = new Set();
const OFFLINE_GRACE_MS = 15000;
let offlineSince = Date.now();

// Rules survive service worker restarts, so a missing agent stays blocked instead of failing open.
const ready = chrome.storage.local.get(["rules", "offlineSince"]).then((v) => {
  if (v.rules) rules = v.rules;
  if (v.offlineSince) offlineSince = v.offlineSince;
});

// With the agent gone nothing can say a curfew started or a limit ran out, so every locked block closes until it returns.
function failingClosed() { return offlineSince !== null && Date.now() - offlineSince > OFFLINE_GRACE_MS; }
function setOnline(up) {
  online = up;
  if (up) { offlineSince = null; chrome.storage.local.remove("offlineSince"); return; }
  if (offlineSince === null) { offlineSince = Date.now(); chrome.storage.local.set({ offlineSince }); }
  // One timer for the moment rules start failing closed, instead of polling.
  setTimeout(() => { if (failingClosed()) sweep(); }, Math.max(0, offlineSince + OFFLINE_GRACE_MS - Date.now()) + 500);
}
function isBlocking(b) { return b.blocking || (b.failClosed && failingClosed()); }

function connect() {
  // Retries from onDisconnect and the keepalive alarm can overlap; a second port would never get the "ext" hello.
  if (port) return;
  try { port = chrome.runtime.connectNative("com.deadbolt.blocker"); }
  catch (e) { console.warn("native connect failed", e); setTimeout(connect, 2000); return; }
  port.onMessage.addListener(onNative);
  port.onDisconnect.addListener(() => {
    console.warn("native host disconnected", chrome.runtime.lastError && chrome.runtime.lastError.message);
    port = null;
    setOnline(false);
    setTimeout(connect, 2000);
  });
}

function post(msg) {
  try { if (port) port.postMessage(msg); } catch (e) { console.warn("post failed", e); }
}

async function sayHello() {
  const incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();
  post({ type: "ext", incognitoAllowed, version: chrome.runtime.getManifest().version });
  report();
}

function onNative(msg) {
  if (msg.type === "agent-online") { setOnline(true); sayHello(); }
  else if (msg.type === "agent-offline") { setOnline(false); }
  else if (msg.type === "rules") {
    rules = { blocks: msg.blocks, settings: msg.settings };
    chrome.storage.local.set({ rules });
    sweep();
    report();
  } else if (msg.type === "res") {
    const done = pending.get(msg.id);
    pending.delete(msg.id);
    if (done) done(msg);
  }
}

function firstBlocking(url, tabId) {
  for (const b of rules.blocks) {
    if (!isBlocking(b)) continue;
    if (blockMatches(b, url)) return b;
    if (blocksAdult(b) && adultTabs.has(tabId)) return b;
  }
  return null;
}

function hostOf(url) {
  const t = parseTarget(url);
  return t ? t.host : "";
}

function redirect(tabId, url, block) {
  post({ type: "blocked", host: hostOf(url) });
  const page = `${BLOCK_PAGE}?b=${encodeURIComponent(block.id)}&u=${encodeURIComponent(url)}`;
  chrome.tabs.update(tabId, { url: page }).catch((e) => console.warn("redirect failed", e));
}

function originalOf(tabUrl) {
  if (!tabUrl.startsWith(BLOCK_PAGE)) return null;
  return new URL(tabUrl).searchParams.get("u");
}

async function checkTab(tab) {
  await ready;
  if (!tab.url) return;
  const original = originalOf(tab.url);
  if (original) {
    if (!firstBlocking(original, tab.id)) chrome.tabs.update(tab.id, { url: original }).catch(() => {});
    return;
  }
  if (!tab.active && !rules.settings.blockInactiveTabs) return;
  const b = firstBlocking(tab.url, tab.id);
  if (b) redirect(tab.id, tab.url, b);
}

// Leaving for about:blank abandons the HTML parser, while clearing the document races it and leaves content behind.
function blockFrame(tabId, frameId, url) {
  if (!rules.settings.blockEmbedded || !firstBlocking(url, tabId)) return;
  post({ type: "blocked", host: hostOf(url) });
  chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    injectImmediately: true,
    func: () => location.replace("about:blank"),
  }).catch((e) => console.warn("frame block failed", e));
}

async function sweep() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(checkTab));
  if (!rules.settings.blockEmbedded) return;
  // Frames loaded before this rule change get no commit event of their own.
  await Promise.all(tabs.map(async (t) => {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id }).catch(() => null);
    for (const f of frames || []) if (f.frameId !== 0) blockFrame(t.id, f.frameId, f.url);
  }));
}

async function report() {
  if (!port) return;
  await ready;
  const tabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup", "panel", "app", "devtools"] });
  const focusedWindow = windows.find((w) => w.focused);
  const active = focusedWindow && tabs.find((t) => t.active && t.windowId === focusedWindow.id);
  const url = active && active.url && !active.url.startsWith(BLOCK_PAGE) ? active.url : "";
  const matching = (u) => rules.blocks.filter((b) => blockMatches(b, u)).map((b) => b.id);
  const anyIds = new Set();
  for (const t of tabs) if (t.url && !t.url.startsWith(BLOCK_PAGE)) matching(t.url).forEach((id) => anyIds.add(id));
  post({
    type: "report",
    focused: !!focusedWindow,
    host: url ? hostOf(url) : "",
    incognito: !!(active && active.incognito),
    audible: tabs.some((t) => t.audible),
    matched: url ? matching(url) : [],
    matchedAny: [...anyIds],
    matchedAudible: [...new Set(tabs.filter((t) => t.audible && t.url).flatMap((t) => matching(t.url)))],
    windows: windows.length,
  });
}

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  await ready;
  if (d.frameId !== 0) return;
  adultTabs.delete(d.tabId);
  if (d.url.startsWith(BLOCK_PAGE)) return;
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  if (!tab || (!tab.active && !rules.settings.blockInactiveTabs)) return;
  const b = firstBlocking(d.url, d.tabId);
  if (b) redirect(d.tabId, d.url, b);
});

// Single-page sites change URL without a navigation event.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  await ready;
  if (d.frameId !== 0) return;
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  if (!tab || (!tab.active && !rules.settings.blockInactiveTabs)) return;
  const b = firstBlocking(d.url, d.tabId);
  if (b) redirect(d.tabId, d.url, b);
});

// Embedded frames can't redirect the tab.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  await ready;
  if (d.frameId !== 0) blockFrame(d.tabId, d.frameId, d.url);
});

chrome.tabs.onUpdated.addListener((id, info, tab) => { if (info.url || info.status === "complete") checkTab(tab); report(); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) checkTab(tab);
  report();
});
chrome.windows.onFocusChanged.addListener(() => report());

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.page && sender.tab && sender.frameId === 0) {
    post({ type: "classify", host: hostOf(sender.url), title: msg.page.title, description: msg.page.description, rating: msg.page.rating });
    return;
  }
  if (msg.adult && sender.tab) {
    adultTabs.add(sender.tab.id);
    checkTab(sender.tab);
    return;
  }
  if (msg.status) {
    reply({ online, connected: !!port });
    return;
  }
  if (msg.api) {
    if (!port) { reply({ ok: false, error: "Deadbolt app is not reachable." }); return; }
    const id = nextReq++;
    pending.set(id, reply);
    post({ type: "req", id, cmd: msg.api, args: msg.args || {} });
    return true;
  }
});

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (!port) connect(); else report(); });
// Reports follow tab and window events. The interval only refreshes them for the agent's usage count.
setInterval(report, 15000);
chrome.windows.onCreated.addListener(() => report());
chrome.windows.onRemoved.addListener(() => report());
connect();
ready.then(sweep);
