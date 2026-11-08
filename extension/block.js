const params = new URLSearchParams(location.search);
const blockId = params.get("b");
const quotes = [
  "Finish the sentence you were writing.",
  "The urge passes faster than you think.",
  "You put this here for a reason.",
  "Nothing on that page will matter tomorrow.",
  "One hour of real work beats four of half attention.",
];
document.getElementById("url").textContent = params.get("u") || "";
document.getElementById("quote").textContent = quotes[Math.floor(Math.random() * quotes.length)];

const call = (api, args) => new Promise((resolve) => chrome.runtime.sendMessage({ api, args }, resolve));
const actions = document.getElementById("actions");
let shownKey = "";

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function button(label, primary, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", onClick);
  return b;
}

function render(status) {
  document.getElementById("title").textContent = status.name;
  document.getElementById("reason").textContent = status.reason;
  const now = Date.now() / 1000;
  const key = `${status.breakKind}:${status.needsPress}:${status.delayUntil ? "delay" : ""}:${status.challenge || ""}`;
  if (key === shownKey && !status.delayUntil) return;
  shownKey = key;
  actions.replaceChildren();
  if (status.needsPress) {
    actions.append(button("Unblock", true, async () => { await call("startBreak", { id: blockId }); refresh(); }));
  } else if (status.delayUntil) {
    const p = document.createElement("p");
    p.textContent = `Break starts in ${clock(status.delayUntil - now)}.`;
    actions.append(p, button("Cancel", false, async () => { await call("cancelBreak", { id: blockId }); refresh(); }));
  } else if (status.breakKind === "delay") {
    actions.append(button("Unblock", true, async () => { await call("startBreak", { id: blockId }); refresh(); }));
  } else if (status.breakKind === "randomText") {
    if (!status.challenge) {
      actions.append(button("Unblock", true, async () => { await call("startBreak", { id: blockId }); refresh(); }));
    } else {
      const c = document.createElement("div");
      c.id = "challenge";
      c.textContent = status.challenge;
      const area = document.createElement("textarea");
      area.addEventListener("paste", (e) => e.preventDefault());
      area.setAttribute("aria-label", "Type the text above");
      const err = document.createElement("p");
      err.className = "err";
      const submit = button("Start break", true, async () => {
        const r = await call("startBreak", { id: blockId, text: area.value });
        if (r.ok) { refresh(); return; }
        const firstTypo = [...status.challenge].findIndex((ch, i) => ch !== area.value[i]);
        err.textContent = status.hideTypos ? r.error : `The text differs at character ${firstTypo + 1}.`;
        if (!status.keepText) area.value = "";
      });
      actions.append(c, area, submit, err);
    }
  } else if (status.leftSeconds != null) {
    const p = document.createElement("p");
    p.textContent = "No break time left for now.";
    actions.append(p);
  } else if (status.breakKind === "pomodoro" && status.until) {
    const p = document.createElement("p");
    p.textContent = `Next break in ${clock(status.until - now)}.`;
    actions.append(p);
  }
}

async function refresh() {
  const r = await call("blockStatus", {});
  if (!r || !r.ok) {
    document.getElementById("reason").textContent = (r && r.error) || "The Deadbolt app is not reachable. Blocks still apply.";
    return;
  }
  const status = r.result.find((s) => s.id === blockId);
  if (status) render(status);
}

refresh();
setInterval(refresh, 2000);
