// Run: node scripts/matcher_check.js
const assert = require("assert");
const { blockMatches } = require("../extension/matcher.js");

const b = (websites, exceptions = ["file://*"]) => ({ websites, exceptions });
const yes = (block, url) => assert.ok(blockMatches(block, url), `expected match: ${JSON.stringify(block.websites)} ${url}`);
const no = (block, url) => assert.ok(!blockMatches(block, url), `expected no match: ${JSON.stringify(block.websites)} ${url}`);

yes(b(["facebook.com"]), "https://facebook.com/");
yes(b(["facebook.com"]), "https://www.facebook.com/x?y=1");
yes(b(["facebook.com"]), "https://m.facebook.com/");
no(b(["facebook.com"]), "https://notfacebook.com/");
no(b(["facebook.com"]), "https://facebook.com.evil.org/");

yes(b(["reddit.com/r/games"]), "https://www.reddit.com/r/games/top");
yes(b(["reddit.com/r/games"]), "https://reddit.com/r/games?sort=new");
no(b(["reddit.com/r/games"]), "https://reddit.com/r/gamesdev");
no(b(["reddit.com/r/games"]), "https://reddit.com/r/python");

yes(b(["*unicorn*"]), "https://example.com/a-unicorn-page");
yes(b(["google.com/*q=*unicorn*"]), "https://www.google.com/search?q=pink+unicorn");
no(b(["google.com/*q=*unicorn*"]), "https://www.google.com/search?q=horse");
no(b(["google.com/*q=*unicorn*"]), "https://bing.com/search?q=unicorn");
yes(b(["*.*/*q=*keyword*"]), "https://duck.com/?q=a+keyword+here");

yes(b(["*.*"]), "https://anything.example/");
yes(b(["*.*"]), "http://127.0.0.1:8000/");
no(b(["*.*"]), "chrome://settings");
no(b(["*.*"]), "chrome-extension://abc/page.html");
no(b(["*.*"]), "file:///Users/me/doc.pdf");
yes(b(["*.*"], []), "file:///Users/me/doc.pdf");

yes(b(["*.xxx"]), "https://site.xxx/page");
no(b(["*.xxx"]), "https://site.com/a.xxxy");

const ex = b(["*.*"], ["wikipedia.org", "youtube.com/*list=WL*"]);
no(ex, "https://en.wikipedia.org/wiki/Cat");
no(ex, "https://www.youtube.com/watch?v=1&list=WL");
yes(ex, "https://www.youtube.com/watch?v=1");
yes(ex, "https://example.com/");

yes(b(["HTTPS://WWW.Example.com/"]), "https://example.com/");
yes(b(["reddit.com"]), "view-source:https://reddit.com/r/all");
yes(b(["reddit.com"]), "https://reddit.com./r/all");
yes(b(["reddit.com"]), "https://www.reddit.com../");
yes(b(["reddit.com"]), "https://www-reddit-com.translate.goog/r/all");
yes(b(["my-site.org"]), "https://my--site-org.translate.goog/");
no(b(["reddit.com"]), "https://example-com.translate.goog/");
console.log("matcher OK");
