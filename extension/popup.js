chrome.runtime.sendMessage({ api: "blockStatus", args: {} }, (r) => {
  const list = document.getElementById("list");
  list.replaceChildren();
  const add = (text, mute) => {
    const li = document.createElement("li");
    li.textContent = text;
    if (mute) li.className = "mute";
    list.append(li);
  };
  if (!r || !r.ok) { add("The Deadbolt app is not reachable.", true); return; }
  const rows = r.result.filter((s) => s.armed);
  if (!rows.length) add("No active blocks.", true);
  for (const s of rows) {
    let extra = "";
    if (s.leftSeconds != null) extra = `, ${Math.ceil(s.leftSeconds / 60)} min left`;
    else if (s.sessionsLeft != null) extra = `, ${s.sessionsLeft} sessions left`;
    add(`${s.name}: ${s.reason}${extra}`);
  }
});
