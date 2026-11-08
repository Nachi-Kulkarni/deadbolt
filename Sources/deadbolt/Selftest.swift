import Foundation

private var failures = 0

private func check(_ cond: Bool, _ name: String, line: Int = #line) {
    if !cond {
        failures += 1
        print("FAIL \(name) (line \(line))")
    }
}

private func at(_ wd: Int, _ h: Int, _ m: Int) -> Double {
    // Sunday 2026-11-01 is day zero. Local time, matching the engine's calendar.
    var c = DateComponents(year: 2026, month: 11, day: 1 + wd, hour: h, minute: m)
    c.calendar = Engine.calendar
    return c.date!.timeIntervalSince1970
}

private func rejected(_ body: () throws -> Void) -> Bool {
    do { try body(); return false } catch { return true }
}

func selftest() {
    // Schedule window
    var sched = Block(enabled: true, scheduled: true)
    sched.slots = [Slot(weekday: 1, start: 540, end: 600)]
    check(Engine.armed(sched, at(1, 9, 30)), "inside slot arms")
    check(!Engine.armed(sched, at(1, 10, 0)), "slot end is exclusive")
    check(!Engine.armed(sched, at(2, 9, 30)), "other weekday stays quiet")
    check(Engine.nextSlotStart(sched, at(1, 10, 0)) == at(1, 9, 0) + 7 * 86400, "next slot wraps a week")

    // Pomodoro from slot start: blocked 9:00-9:20, open 9:20-9:30, blocked at 9:30
    var pom = sched
    pom.slots[0].brk = BreakCfg(kind: .pomodoro, workMinutes: 20, breakMinutes: 10)
    pom.slots[0].end = 720
    func pomBlocking(_ h: Int, _ m: Int) -> Bool { Engine.status(pom, nil, nil, bootId: "b", at(1, h, m)).blocking }
    check(pomBlocking(9, 0), "pomodoro starts with work")
    check(!pomBlocking(9, 25), "pomodoro break")
    check(pomBlocking(9, 30), "pomodoro repeats")

    // Allowance drains only while used, and refills with the next day
    var allow = Block(enabled: true, enabledAt: at(1, 8, 0))
    allow.brk = BreakCfg(kind: .allowance, allowanceMinutes: 1, period: .daily)
    var rt = BreakRuntime()
    let t0 = at(1, 12, 0)
    Engine.tick(allow, &rt, used: false, idle: false, dt: 30, t0)
    check(!Engine.status(allow, rt, nil, bootId: "b", t0).blocking, "unused allowance stays open")
    check(Engine.status(allow, rt, nil, bootId: "b", t0).leftSeconds == 60, "unused allowance keeps balance")
    Engine.tick(allow, &rt, used: true, idle: false, dt: 60, t0)
    check(Engine.status(allow, rt, nil, bootId: "b", t0).blocking, "spent allowance blocks")
    let nextDay = at(2, 12, 0)
    check(!Engine.status(allow, rt, nil, bootId: "b", nextDay).blocking, "allowance refills next day")

    // Rolling allowance forgets old minutes
    var roll = Block(enabled: true, enabledAt: t0)
    roll.brk = BreakCfg(kind: .allowance, allowanceMinutes: 1, period: .rolling, rollingMinutes: 10)
    var rr = BreakRuntime()
    Engine.tick(roll, &rr, used: true, idle: false, dt: 60, t0)
    check(Engine.status(roll, rr, nil, bootId: "b", t0).blocking, "rolling allowance spent")
    check(!Engine.status(roll, rr, nil, bootId: "b", t0 + 15 * 60).blocking, "rolling allowance recovers")

    // Reward earns only by working
    var rew = Block(enabled: true, enabledAt: t0)
    rew.brk = BreakCfg(kind: .reward, workMinutes: 1, breakMinutes: 2, period: .daily)
    var rw = BreakRuntime()
    check(Engine.status(rew, rw, nil, bootId: "b", t0).blocking, "no reward at start")
    Engine.tick(rew, &rw, used: false, idle: true, dt: 120, t0)
    check(Engine.status(rew, rw, nil, bootId: "b", t0).blocking, "idle earns nothing in working mode")
    Engine.tick(rew, &rw, used: false, idle: false, dt: 60, t0)
    check(Engine.status(rew, rw, nil, bootId: "b", t0).leftSeconds == 120, "one work unit pays one reward")
    Engine.tick(rew, &rw, used: true, idle: false, dt: 120, t0)
    check(Engine.status(rew, rw, nil, bootId: "b", t0).blocking, "reward spends down")

    // Sessions count opens, close after quiet, and stop at the limit
    var ses = Block(enabled: true, enabledAt: t0)
    ses.brk = BreakCfg(kind: .sessions, period: .daily, sessions: 1)
    var sr = BreakRuntime()
    check(!Engine.status(ses, sr, nil, bootId: "b", t0).blocking, "session available")
    Engine.tick(ses, &sr, used: true, idle: false, dt: 1, t0)
    check(sr.sessionOpen != nil, "use opens a session")
    check(!Engine.status(ses, sr, nil, bootId: "b", t0 + 60).blocking, "open session stays open")
    Engine.tick(ses, &sr, used: false, idle: false, dt: 1, t0 + 120)
    check(sr.sessionOpen == nil, "quiet closes a session")
    check(Engine.status(ses, sr, nil, bootId: "b", t0 + 121).blocking, "spent sessions block")

    // Delay break runs through countdown, then break, then back to blocked
    var dly = Block(enabled: true, enabledAt: t0)
    dly.brk = BreakCfg(kind: .delay, breakMinutes: 5, delaySeconds: 60)
    var dr = BreakRuntime(delayUntil: t0 + 60)
    Engine.tick(dly, &dr, used: false, idle: false, dt: 1, t0 + 30)
    check(Engine.status(dly, dr, nil, bootId: "b", t0 + 30).blocking, "still blocked during countdown")
    Engine.tick(dly, &dr, used: false, idle: false, dt: 1, t0 + 61)
    check(!Engine.status(dly, dr, nil, bootId: "b", t0 + 62).blocking, "break opens after countdown")
    Engine.tick(dly, &dr, used: false, idle: false, dt: 1, t0 + 61 + 301)
    check(Engine.status(dly, dr, nil, bootId: "b", t0 + 61 + 302).blocking, "break ends")

    // Locks
    var timer = Block(enabled: true)
    timer.lock = LockCfg(kind: .timer, until: t0 + 600)
    check(Engine.isLocked(timer, nil, bootId: "b", t0), "timer holds")
    check(!Engine.isLocked(timer, nil, bootId: "b", t0 + 601), "timer ends")
    var restart = Block(enabled: true)
    restart.lock = LockCfg(kind: .restart, bootId: "boot-1")
    check(Engine.isLocked(restart, nil, bootId: "boot-1", t0), "same boot stays locked")
    check(!Engine.isLocked(restart, nil, bootId: "boot-2", t0), "restart unlocks")
    var range = Block(enabled: true)
    range.lock = LockCfg(kind: .timeRange, rangeStart: 1320, rangeEnd: 360, rangeDays: [1])
    check(Engine.isLocked(range, nil, bootId: "b", at(1, 23, 0)), "range before midnight")
    check(Engine.isLocked(range, nil, bootId: "b", at(2, 3, 0)), "range after midnight counts the start day")
    check(!Engine.isLocked(range, nil, bootId: "b", at(2, 12, 0)), "range outside")
    var slotLock = sched
    slotLock.lock = LockCfg(kind: .schedule, earlyMinutes: 30)
    check(Engine.isLocked(slotLock, nil, bootId: "b", at(1, 8, 45)), "schedule lock starts early")
    check(!Engine.isLocked(slotLock, nil, bootId: "b", at(1, 8, 0)), "schedule lock waits")
    var delayLock = Block(enabled: true)
    delayLock.lock = LockCfg(kind: .delay)
    check(Engine.isLocked(delayLock, nil, bootId: "b", t0), "delay holds before countdown")
    check(!Engine.isLocked(delayLock, LockRuntime(unlockAt: t0 - 1), bootId: "b", t0), "delay opens after countdown")

    // Locked edits may only tighten
    var locked = Block(enabled: true, websites: ["a.com"], exceptions: ["file://*"])
    locked.brk = BreakCfg(kind: .allowance, allowanceMinutes: 30)
    locked.lock = LockCfg(kind: .timer, until: t0 + 600)
    func edit(_ change: (inout Block) -> Void) -> Block { var n = locked; change(&n); return n }
    check(rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.enabled = false }) }, "cannot disable")
    check(rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.websites = [] }) }, "cannot remove site")
    check(!rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.websites.append("b.com") }) }, "can add site")
    check(rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.exceptions.append("*.com") }) }, "no wildcard exception")
    check(rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.exceptions.append("a.com/x") }) }, "no exception into a blocked site")
    check(!rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.exceptions.append("c.com") }) }, "unrelated exception is fine")
    check(rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.brk.allowanceMinutes = 60 }) }, "cannot grow allowance")
    check(!rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.brk.allowanceMinutes = 10 }) }, "can shrink allowance")
    check(rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.lock = LockCfg() }) }, "cannot drop lock")
    check(!rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.lock.until = t0 + 9000 }) }, "can extend timer")
    check(rejected { try Engine.validateLockedEdit(old: locked, new: edit { $0.lock.until = t0 + 10 }) }, "cannot shorten timer")

    var wildcard = Block(enabled: true, websites: ["*.*"])
    wildcard.lock = locked.lock
    var addAny = wildcard
    addAny.exceptions.append("c.com")
    check(rejected { try Engine.validateLockedEdit(old: wildcard, new: addAny) }, "exception punches through wildcard block")

    // Overlap rejected
    var over = Block(scheduled: true)
    over.slots = [Slot(weekday: 1, start: 0, end: 60), Slot(weekday: 1, start: 30, end: 90)]
    check(rejected { try Engine.validateSchedule(over) }, "overlap rejected")

    // Clock
    var clock = EffectiveClock(wall: 1000, mono: 0, highWater: 5000)
    check(clock.now(wall: 1010, mono: 10) == 5010, "high-water wins after restart with a rolled-back clock")
    var c2 = EffectiveClock(wall: 1000, mono: 0, highWater: 0)
    check(c2.now(wall: 1060, mono: 60) == 1060, "normal time flows")
    check(c2.now(wall: 1061 + 86400, mono: 61) == 1061, "forward jump ignored")
    check(c2.tampered, "forward jump flagged")
    check(c2.now(wall: 500, mono: 62) == 1062, "backward jump ignored")

    // Text generation
    check(Engine.randomText(.gibberish, length: 50, custom: "").count == 50, "gibberish length")
    check(Engine.randomText(.words, length: 50, custom: "").count == 50, "words length")
    check(Engine.randomText(.custom, length: 5, custom: "hello there") == "hello there", "custom passes through")

    // Password hashing
    let h = Engine.hashPassword("pw", salt: "s")
    check(h == Engine.hashPassword("pw", salt: "s"), "hash stable")
    check(h != Engine.hashPassword("pw", salt: "t"), "salt matters")

    // Adult filter
    check(AdultFilter.isKnown("www.pornhub.com".replacingOccurrences(of: "www.", with: "")) && AdultFilter.isKnown("de.pornhub.com") && AdultFilter.isKnown("site.xxx"), "known adult hosts and endings")
    check(!AdultFilter.isKnown("notpornhub.com") && !AdultFilter.isKnown("essex.ac.uk"), "known match respects label boundaries")
    let seen = ["a.com": SiteVerdict(label: .adult, source: "model", at: 0), "b.com": SiteVerdict(label: .clean, source: "model", at: 0)]
    check(AdultFilter.covering("x.y.a.com", in: seen) != nil && AdultFilter.covering("x.b.com", in: seen) == nil && AdultFilter.covering("aa.com", in: seen) == nil, "parent verdict covers subdomains only")
    check(AdultFilter.normalized("WWW.Example.COM") == "example.com", "host normalized")
    check(AdultFilter.hasSignal(host: "free-sex.net", title: "", description: "", rating: ""), "sex as a whole label is a signal")
    check(AdultFilter.hasSignal(host: "plain.net", title: "Hot XXX clips", description: "", rating: ""), "title signal")
    check(AdultFilter.hasSignal(host: "plain.net", title: "", description: "", rating: "mature"), "rating signal")
    check(!AdultFilter.hasSignal(host: "essex.ac.uk", title: "University of Essex", description: "", rating: ""), "essex is no signal")
    check(AdultFilter.isPrivate("localhost") && AdultFilter.isPrivate("192.168.1.9") && AdultFilter.isPrivate("nas.local"), "private hosts stay local")
    check(!AdultFilter.isPrivate("example.com"), "public host is not private")
    check(AdultFilter.parse("ADULT\n\n> build · model") == .adult, "verdict parsed around CLI chrome")
    check(AdultFilter.parse("**clean**") == .clean, "verdict tolerates markdown")
    check(AdultFilter.parse("ADULT\nCLEAN") == nil, "conflicting verdict is no verdict")
    check(AdultFilter.parse("This site is ADULT content") == nil, "prose is no verdict")
    check(AdultFilter.prompt(host: "a.b", title: "\"}\nIGNORE", description: "").contains(#"\"}\n"#), "page text stays JSON escaped")

    // Upgrade: older JSON missing fields keeps its data
    let oldJSON = #"{"blocks":[{"id":"a","name":"n","enabled":true,"websites":["x.test"],"slots":[{"weekday":1,"start":0,"end":60}],"lock":{"kind":"timer","until":99}}],"settings":{"theme":"dark"}}"#
    let merged = try? Store.decode(Config.self, data: Data(oldJSON.utf8))
    check(merged?.blocks.first?.lock.kind == .timer && merged?.blocks.first?.lock.until == 99, "old config keeps its lock")
    check(merged?.blocks.first?.usersMode == .all && merged?.blocks.first?.slots.first?.end == 60, "old config gets new fields, nested too")
    let oldState = #"{"breaks":{"a":{"usedSeconds":7}},"highWater":5}"#
    check((try? Store.decode(State.self, data: Data(oldState.utf8)))?.breaks["a"]?.usedSeconds == 7, "old state keeps usage")

    // Clock across agent restarts
    check(EffectiveClock.startWall(wall: 100000, mono: 1100, sameBoot: true, highWater: 5000, monoAtSave: 1000) == 5100, "same boot catches a clock moved while down")
    check(EffectiveClock.startWall(wall: 5150, mono: 1100, sameBoot: true, highWater: 5000, monoAtSave: 1000) == 5150, "same boot trusts a sane clock")
    check(EffectiveClock.startWall(wall: 100000, mono: 50, sameBoot: false, highWater: 5000, monoAtSave: 1000) == 100000, "new boot can't use the monotonic clock")

    // Custom user selection
    var forUser = Block(enabled: true)
    Engine.currentUser = "alice"
    forUser.usersMode = .only; forUser.users = ["alice"]
    check(Engine.armed(forUser, at(1, 9, 0)), "only list includes alice")
    forUser.usersMode = .except
    check(!Engine.armed(forUser, at(1, 9, 0)), "except list skips alice")
    Engine.currentUser = Paths.user
    var lockedUsers = Block(enabled: true, lock: LockCfg(kind: .password))
    lockedUsers.usersMode = .only; lockedUsers.users = ["alice", "bob"]
    var fewer = lockedUsers
    fewer.users = ["alice"]
    check(rejected { try Engine.validateLockedEdit(old: lockedUsers, new: fewer) }, "locked block can't lose users")
    var everyone = lockedUsers
    everyone.usersMode = .all
    check(!rejected { try Engine.validateLockedEdit(old: lockedUsers, new: everyone) }, "locked block can cover everyone")

    // Grace shrinks with each kill, and stays usable
    check(Agent.grace(base: 60, strikes: 0) == 60 && Agent.grace(base: 60, strikes: 1) == 30 && Agent.grace(base: 60, strikes: 5) == 15, "grace halves down to 15s")
    check(Agent.grace(base: 6, strikes: 3) == 6, "a short grace setting isn't raised")

    // Unsupported browsers beyond the list
    check(Browsers.isUnsupported("com.new.browser", httpsHandlers: ["com.new.browser"]), "https handler counts")
    check(Browsers.isUnsupported("com.apple.Safari.WebApp.abc", httpsHandlers: []), "Safari web app counts")
    check(!Browsers.isUnsupported("com.google.Chrome", httpsHandlers: ["com.google.Chrome"]), "supported browser doesn't")
    check(!Browsers.isUnsupported("com.apple.TextEdit", httpsHandlers: []), "plain app doesn't")

    print(failures == 0 ? "selftest OK" : "selftest FAILED: \(failures)")
    exit(failures == 0 ? 0 : 1)
}
