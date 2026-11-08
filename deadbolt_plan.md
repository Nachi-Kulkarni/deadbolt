# Deadbolt plan

## Boundary

Cold Turkey was studied through its visible behavior: UI text, on-disk layout, process model. No disassembly. No license work. All code here is new.

## Observed Cold Turkey architecture (Mac)

User LaunchAgent with KeepAlive. Native messaging hosts per browser. Safari appex. WKWebView UI. SQLite stats in a world-writable folder. No root daemon.

## Deadbolt architecture

- `Engine.swift`: pure rules. Takes `now`.
- `Agent.swift`: 1s tick, accounting, enforcement, socket server, rules push.
- `API.swift`: every mutation, every lock check.
- `Enforcer.swift`: app kills, settings panes via AX, device actions, `EffectiveClock`.
- `Client.swift`: socket client, native messaging bridge.
- `extension/`: MV3 blocker. Persists rules and fails closed.
- `ui/`: UI, shipped in a WKWebView shell.

## Data shapes

`Config` holds `blocks` and `settings` and is exportable. `State` holds break and lock runtime and is never exported. Browser messages are `rules`, `report`, `blocked`, `ext`, plus an allowlist of `blockStatus`, `startBreak`, `cancelBreak`.

## Parity

Built and exercised end to end: see `GOAL.md` checked items and `scripts/e2e.js`, `scripts/e2e_ui.js`, `scripts/e2e_escape.js`.

Built, weaker proof:
- Settings pane blocking needs Accessibility. Never run with the permission granted.
- Finder preview kill. Never exercised.
- Network time after a reboot. One real HTTPS check against apple.com, offline falls back to the system clock.
- All-users install. Fake root and simulated users only. Never run with real root or a second real account.
- Guest window detection. Real window count, but the extension under-reports by test patch, since a forwarded `--guest` opened no window in Chrome for Testing.
- Terminal blocking. Off by default and never run against real terminals.
- Device actions. Dry run only.
- Firefox host manifest. Firefox is not installed. Release Firefox needs signed add-ons.

Not built:
- Window title statistics and blocks.
- Pause for a Cause. Deliberately omitted.
- Popup style notifications. Uses system notifications.
- Safari. Needs full Xcode and a signing identity, so it counts as an unsupported browser.
- Backup restore of bundles.

Known bypasses, see `escape_plan.md` for all routes closed:
- An admin who kills both jobs and every browser host, then deletes the vault and key in both folders, gets out until next login. Safe Mode, Recovery, and an account outside the block's users do too. Cold Turkey Mac has the same class of limit.
- A modified extension copy with the same key can fake reports. Safari can only be closed.

## Adult site filter

On by default. Separate from user blocks. Delivered as one synthetic block, id `adult-filter`, so the matcher, block page, fail-closed storage, and stats all apply.

Order for a page's host:
1. Allowed by the user: open. Set in Settings, refused during a locked block.
2. Built-in host list and adult domain endings: blocked before load, no network.
3. RTA rating tag: blocked, no network.
4. Local, private, or mainstream host: never sent.
5. Cached verdict. Clean expires after 30 days. Adult does not expire.
6. Adult keywords or an adult or mature rating: held on the block page until the model answers. Stays blocked if the model fails.
7. Otherwise the page stays open while `opencode-go/deepseek-v4.1-flash` decides, then moves to the block page if adult.

Limits and safety:
- Sends host, title, and description only. Never the path or query. Private windows are included.
- Page text is untrusted. It is JSON escaped, and the model call has two barriers: `--standalone` with every tool denied, inside a `sandbox-exec` profile that allows no other process and no writes outside OpenCode's folders. A plain `opencode run` ignores both, because tools run in the shared OpenCode service. Measured: a marker file got created that way.
- 300 model calls a day, 2 at a time, retry after 10 minutes on failure.
- Not caught: adult sections of mainstream sites, browsers without the extension, and a page shown for about 3s to 5s before its first verdict.

## Decisions

- Browser enforcement keys on exact app path, because dev tools share Chrome's bundle id.
- `sweep()` also walks frames, because frames loaded before a rule change get no commit event.
- Frames leave for `about:blank`, because clearing a document races the parser.

## Idle cost

Measured with test-label jobs over 120s. Agent went from 1.36% CPU unlocked and 1.75% locked to 0.25% (0.30 CPU-s) and 0.39% (0.47 CPU-s). The guardian uses about 0.05 CPU-s.
- App rules run on launches and activations, not on every app every second. Launches come from a kernel pid diff (`proc_listallpids`) plus `didLaunchApplicationNotification`. Every `NSRunningApplication` property read is a synchronous LaunchServices call (seen in `sample`), so only new pids get looked up.
- Process path scans (binaries, Quick Look, Tor) run every 3s. Install checks only read files, and `launchctl` runs only when a check fails or once a minute. State that only the clock changed is saved once a minute. Stats go to disk every 60s.
- The extension reports when tabs or windows change, plus every 15s. The offline fail-closed switch uses one timer instead of polling.
