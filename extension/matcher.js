// URL rules. Shared by the service worker and scripts/matcher_check.js.
const WEB_SCHEMES = new Set(["http:", "https:", "ftp:", "file:"]);

function parseTarget(url) {
  let u;
  const real = url.replace(/^view-source:/i, "");
  try { u = new URL(real); } catch { return null; }
  if (!WEB_SCHEMES.has(u.protocol)) return null;
  let host = u.hostname.toLowerCase().replace(/\.+$/, "");
  // Google Translate's proxy serves reddit.com as reddit-com.translate.goog, with real hyphens doubled.
  if (host.endsWith(".translate.goog")) host = host.slice(0, -".translate.goog".length).replace(/--|-/g, (m) => (m === "--" ? "-" : "."));
  host = host.replace(/^www\./, "");
  return { full: real.toLowerCase(), host, target: (host + u.pathname + u.search + u.hash).toLowerCase() };
}

const regexCache = new Map();
function wildcardRegex(pattern) {
  let r = regexCache.get(pattern);
  if (!r) {
    const escaped = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*");
    r = new RegExp("^" + escaped + "$");
    regexCache.set(pattern, r);
  }
  return r;
}

function entryMatches(rawEntry, t) {
  let entry = rawEntry.trim().toLowerCase();
  if (!entry) return false;
  if (/^(file|ftp):\/\//.test(entry)) return wildcardRegex(entry).test(t.full);
  entry = entry.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (entry.includes("*")) {
    // A pattern with no path, such as *.xxx, is about the host. The full target would never end in .xxx.
    return wildcardRegex(entry).test(t.target) || (!entry.includes("/") && wildcardRegex(entry).test(t.host));
  }
  const slash = entry.indexOf("/");
  const host = slash < 0 ? entry : entry.slice(0, slash);
  if (t.host !== host && !t.host.endsWith("." + host)) return false;
  if (slash < 0) return true;
  const path = entry.slice(slash);
  const rest = t.target.slice(t.host.length);
  return rest === path || rest.startsWith(path.endsWith("/") ? path : path + "/") || rest.startsWith(path + "?") || rest.startsWith(path + "#");
}

function blockMatches(block, url) {
  const t = parseTarget(url);
  if (!t) return false;
  if (!block.websites.some((e) => entryMatches(e, t))) return false;
  return !block.exceptions.some((e) => entryMatches(e, t));
}

/// Adult-rated pages count as the entry *.xxx even when their domain doesn't end that way.
function blocksAdult(block) {
  return block.websites.some((e) => e.trim().toLowerCase() === "*.xxx");
}

if (typeof module !== "undefined") module.exports = { blockMatches, blocksAdult, parseTarget, entryMatches };
