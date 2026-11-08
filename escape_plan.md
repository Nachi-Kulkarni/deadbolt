# Escape routes, limits and remaining Pro parity

Cold Turkey's real model, read from its install (plist, folder modes, UI text, no disassembly) and its guide:
root-owned plist in `/Library/LaunchAgents` (per-user session, `KeepAlive`), world-writable data folder, native hosts per browser, browser closed after a grace period when the extension goes missing, uninstaller refused while locked, Tor and guest blocked while locked. Pro list: apps, schedules, app password, all locks, custom user selection, breaks and allowances. Only custom user selection is missing here.

## Limits (user request)

"5 min per hour, nothing after 10pm" is one scheduled block: allowance slots with a rolling 60 min window, and no-break slots for the curfew. The engine does this already, the UI makes it a 40-click job. Add a Quick limit dialog that generates the slots. Curfews across midnight split into two slots. Rolling usage survives across slots because its window key is constant.

Background audio on a limited site must spend the limit. Report `matchedAudible` from the extension.

## Escape routes

| # | Route | Today | Fix | Proof |
|---|-------|-------|-----|-------|
| 1 | Reopen browser after extension-missing kill | fresh 60s each launch, forever | strikes persist: 60, 30, 15, 15 until reconnected | e2e |
| 2 | Second browser instance with other `--user-data-dir` | passes, match is by path | match connection by pid | e2e |
| 3 | Profile without extension, guest window | passes | window count on all Spaces above reported count, sustained for grace, warned first, then close the browser | e2e, with the extension patched to under-report |
| 4 | Brave Tor | passes | kill `tor-*` under BraveSoftware while locked | e2e with stub process |
| 5 | Kill agent, browse on stale `blocking:false`, curfew never starts | passes | rules carry every enabled block. Offline over 15s: extension blocks them all | e2e |
| 6 | `launchctl bootout`, `kill -STOP` | stays off until login | guardian job, agent and native host each restore while locked, guardian kills a frozen agent | launchd test job |
| 7 | Delete plist or app | plist restored only on agent start, app not at all | repair loop, spare bundle copy | launchd test job |
| 8 | Edit or delete `config.json`, `state.json` | read at next start, decode failure drops all locks | HMAC vault in two places, highest rev wins, running agent rewrites changed files | e2e |
| 9 | Kill agent every 4s so usage never saves | passes | save on each tick with usage | e2e |
| 10 | Clock forward while agent is down | timer locks end | same boot: monotonic check. New boot: HTTPS `Date` check | selftest, e2e |
| 11 | Change time zone to dodge curfew | passes on agent restart | zone pinned while anything is locked | selftest, e2e |
| 12 | `launchctl setenv DEADBOLT_HOME`, `DEADBOLT_TEST_*`, `DEADBOLT_HOME=x deadbolt uninstall` | full bypass via test seams | seams ignored under the production launchd label, install and uninstall refuse a decoy home | launchd test job |
| 13 | `uninstall` or `install` after killing agent | uninstall proceeds | refuse from vault | e2e |
| 14 | `view-source:`, `reddit.com.` trailing dot, `reddit-com.translate.goog` | passes | normalized in `parseTarget` | matcher check |
| 15 | New or renamed browser, Safari web apps | list only | any https handler, web app bundle ids | selftest |
| 16 | Terminal | open | opt-in block, off by default and left out of the "all" button | not run on real terminals |
| 17 | Upgrade adds a field, old JSON fails to decode | drops all locks | merge stored JSON over defaults | selftest |

## Custom user selection

`Block.usersMode` is `all`, `only`, or `except`, with `Block.users`. `install --all-users` (needs sudo) writes the root-owned plist as Cold Turkey does and uses `/Users/Shared/Deadbolt`. That plist is the switch, since anyone can write in `/Users/Shared`. Config vault is shared, newest rev wins. State, stats and socket are per user. Locked: coverage may only grow.

Tested with two agents and a simulated user. Never run on a second real account or with real root.

## Remaining limits, stated plainly

- Killing the agent job, guardian and browser hosts together, then deleting the vault and key, gets out until next login. The same applies to Safe Mode, Recovery and an unblocked second account. An admin can always win. Cold Turkey Mac has this class of limit too.
- A modified extension copy with the same key can fake reports.
- Safari extension needs Xcode, so Safari can only be closed.
- The window count treats big browser dialogs, such as Task Manager, as hidden windows. A notification warns at the start of the grace period.
- The vault key sits beside the data, so it stops edits and deletion, not a forged MAC.
- Accessibility must be granted to the copy in `<home>/app/Deadbolt.app`, since the job runs from there.
- Window title blocks are Windows only in Cold Turkey's guide. Not built.
