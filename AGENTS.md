# Deadbolt

macOS site and app blocker. Independent code that matches Cold Turkey Blocker's visible behavior. Never copy Cold Turkey code, assets, or license logic.

Read `GOAL.md` for the finish line and `deadbolt_plan.md` for the design and parity matrix.

## Build and check

- Toolchain: Swift 6.0.2 Command Line Tools. No Xcode. Ad-hoc signing only.
- Build: `./scripts/build.sh` writes `dist/Deadbolt.app`. Use `CONF=debug ./scripts/build.sh` while iterating (about 2s vs 14s). Use release for CPU numbers.
- Checks: `scripts/check.sh` (quick, about 6s), `scripts/check.sh full` (about 6.5 min), or named suites `quick e2e ui esc browser`. It sets CHROME and PW, gives each suite an empty dir, and writes `logs/check-<time>/`. Run `full` with `run_in_background` and wait on it with `t3_background_wait`.
- Suites can't overlap. `e2e.js` and the escape browser phase refuse to start while Chrome for Testing runs.
- Idle cost: `scripts/measure_idle.sh <empty dir> 120` on a release build. Last measured 0.30 CPU-s unlocked, 0.47 locked.
- Selftest is the fastest check of engine logic. Add cases there before a browser test when the engine can show the bug.

## Harness gotchas (measured in past sessions)

- macOS has no `timeout`. Foreground `sleep` over a few seconds is blocked. Wait in an until-loop or run in the background.
- `rm -rf $X/...` is refused. Write `"${X:?}"/...`.
- Tool calls stop at 600s. Long work goes in the background.
- Kill stray test agents with `pkill -f dist/Deadbolt.app/Contents/MacOS/Deadbolt` and stray test jobs with `launchctl bootout`. `launchctl list | grep -c deadbolt` should print 0 afterwards.
- `NSRunningApplication` property reads (pid, bundle URL, isTerminated) are synchronous LaunchServices calls. Never loop over `runningApplications` every tick.
- KVO on `NSWorkspace.runningApplications` stops firing until the list is read again. Launch notifications miss apps that never check in with LaunchServices.
- `open -g -j` launches a test app without stealing focus. The base suite's frontmost test needs the terminal or Finder in front, not the test browser.

## Rules

- Tests set `DEADBOLT_HOME`, `DEADBOLT_TEST_BROWSER_APP`, and `DEADBOLT_DRY_DEVICE=1`. Without them an agent acts on the real browsers and device.
- Read test settings through `Seams.get`, never `environment` directly. It ignores them under the production launchd label.
- Plain `config.json` and `state.json` are mirrors once a vault exists. Tests may read them, but edits are undone.
- `DEADBOLT_TEST_BROWSER_APP` is an exact app path. Bundle ids are not safe here, since dev tools run Chrome for Testing too.
- Never run a real device action unattended.
- All mutations go through `API.handle`. A locked block may only get stricter.
- Engine functions take `now`. Never read the wall clock inside them.
- The extension private key lives outside the repo. The public key in the manifest fixes the extension id.
