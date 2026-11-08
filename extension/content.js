// Self-declared adult pages use a rating meta tag, whatever their domain is.
const rating = document.querySelector('meta[name="rating" i], meta[name="RATING" i]');
const value = rating && (rating.getAttribute("content") || "").toLowerCase();
if (value && (value.includes("adult") || value.includes("rta-5042") || value.includes("mature"))) {
  chrome.runtime.sendMessage({ adult: true });
}

const description = document.querySelector('meta[name="description" i]');
chrome.runtime.sendMessage({ page: { title: document.title, description: description ? description.getAttribute("content") || "" : "", rating: value || "" } });
