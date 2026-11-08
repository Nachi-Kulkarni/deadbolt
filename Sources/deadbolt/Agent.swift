import AppKit

final class BrowserConn {
    var browserPath = ""
    var pid: Int32 = 0
    var incognitoAllowed = false
    var lastReport: [String: Any] = [:]
    var lastSeen = 0.0
    var extensionHello = false
}

final class Client {
    let fd: Int32
    var buffer = Data()
    var source: DispatchSourceRead?
    var browser: BrowserConn?
    init(fd: Int32) { self.fd = fd }
}

/// All state changes on the main queue. Socket callbacks and the tick share it, so no locks.
/// AppKit needs an NSObject for the menu delegate and the menu item target.
final class MenuBox: NSObject, NSMenuDelegate {
    var fill: (NSMenu) -> Void = { _ in }
    func menuNeedsUpdate(_ menu: NSMenu) { fill(menu) }
    @objc func openUI() { Installer.openUI() }
}

final class Agent {
    var cfg: Config
    var state: State
    let stats: Stats
    var clock: EffectiveClock
    var nowValue: Double
    let bootId = Enforcer.bootId()
    var clients: [Int32: Client] = [:]
    var lastRulesJSON = ""
    var classifying: Set<String> = []
    var retryAt: [String: Double] = [:]
    var lastModelError: String?
    let modelQueue: OperationQueue = { let q = OperationQueue(); q.maxConcurrentOperationCount = 2; return q }()
    var lastDeviceAct: [String: Double] = [:]
    var statusItem: NSStatusItem?
    var lastTick = Clock.wall()
    var dirtyAt = 0.0
    var previousRange: [String: Bool] = [:]
    var previousArmed: [String: Bool] = [:]
    var previousPomodoro: [String: Bool] = [:]
    var uncoveredSince: [pid_t: Double] = [:]
    var zoneChanged = false
    var tickCount = 0
    var healing = false
    var appsDirty = true
    var browsers: [NSRunningApplication] = []
    var knownPids = Set<pid_t>()
    var launchedPids = Set<pid_t>()
    let menuBox = MenuBox()
    var writtenEssential = Data()
    var clockSavedAt = 0.0
    var lastAppPaths: [String] = []
    var leaving = false
    var configRev = 0
    var stateRev = 0
    var writtenConfig = Data()
    var writtenState = Data()
    let stateVault = Paths.perUser("state", "x").replacingOccurrences(of: ".x", with: "")

    init() {
        Paths.ensure()
        let c = Vault.load("config"), s = Vault.load(stateVault)
        if c == nil, FileManager.default.fileExists(atPath: Paths.config.path) { logLine("no vault yet, taking plain config") }
        cfg = c.flatMap { try? Store.decode(Config.self, data: $0.data) } ?? Store.load(Config.self, Paths.config) ?? Config()
        state = s.flatMap { try? Store.decode(State.self, data: $0.data) } ?? Store.load(State.self, Paths.state) ?? State()
        configRev = c?.rev ?? 0
        stateRev = s?.rev ?? 0
        stats = Stats(path: Paths.stats)
        let wall = Clock.wall(), mono = EffectiveClock.monotonic()
        let sameBoot = state.bootId == bootId
        var start = EffectiveClock.startWall(wall: wall, mono: mono, sameBoot: sameBoot, highWater: state.highWater, monoAtSave: state.monoAtSave)
        var highWater = state.highWater
        if !sameBoot, cfg.blocks.contains(where: { $0.lock.kind != .none }), let net = EffectiveClock.networkTime() {
            if abs(net - wall) > EffectiveClock.tolerance { logLine("system clock is off network time by \(Int(wall - net))s, using network time") }
            start = abs(net - wall) > EffectiveClock.tolerance ? net : wall
            highWater = min(highWater, net + EffectiveClock.tolerance)
            state.highWater = highWater
        }
        clock = EffectiveClock(wall: start, mono: mono, highWater: highWater)
        nowValue = max(start, highWater)
        state.bootId = bootId
        pinZone()
    }

    /// While anything is locked, schedules keep the zone they were locked in, or changing the zone would move a curfew.
    func pinZone() {
        NSTimeZone.resetSystemTimeZone()
        let current = TimeZone.current
        if anyLocked, let pinned = TimeZone(identifier: state.zone) {
            Engine.calendar.timeZone = pinned
            let changed = pinned.identifier != current.identifier
            if changed && !zoneChanged { logLine("time zone is \(current.identifier), keeping \(pinned.identifier) during a lock") }
            zoneChanged = changed
        } else {
            Engine.calendar.timeZone = current
            state.zone = current.identifier
            zoneChanged = false
        }
    }

    func start() {
        // A second agent would steal the socket, so only one runs per person.
        let lockFd = open(Paths.home.appendingPathComponent(Paths.perUser(".agent", "lock")).path, O_CREAT | O_RDWR, 0o644)
        if flock(lockFd, LOCK_EX | LOCK_NB) != 0 { logLine("another agent is running, exiting"); exit(0) }
        NSApplication.shared.setActivationPolicy(.accessory)
        if Installer.managed { Installer.writePlists() }
        if Paths.isShared, Installer.managed { Installer.writeHostManifests() }
        persist()
        fireSignIn()
        listen()
        setupMenu()
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.fireSignIn() }
        // App checks run on new apps and activations instead of every app every second, which is most of what an idle agent used to cost.
        // tick() diffs kernel pids for launches, since launch notifications skip apps that never check in with LaunchServices (measured).
        browsers = Browsers.runningSupported()
        knownPids = Enforcer.allPids()
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.launched([app])
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.enforceApp(app, launched: false)
        }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        timer.tolerance = 0.3
        RunLoop.main.add(timer, forMode: .common)
        logLine("agent started pid=\(getpid()) home=\(Paths.home.path)")
        NSApplication.shared.run()
    }

    // MARK: Status

    func status(_ b: Block) -> BlockStatus {
        var s = Engine.status(b, state.breaks[b.id], state.locks[b.id], bootId: bootId, nowValue)
        if cfg.settings.passwordLocksAll, b.enabled { s.locked = true }
        let usageBased: Set<BreakKind> = [.allowance, .reward, .sessions]
        if cfg.settings.requireUnblockPress, s.armed, !s.blocking, usageBased.contains(s.breakKind), state.breaks[b.id]?.pressed != true {
            s.blocking = true
            s.needsPress = true
            s.reason = "press unblock to start a break"
        }
        return s
    }

    var anyLocked: Bool { cfg.blocks.contains { $0.enabled && status($0).locked } }
    var anyLockedUsageBreak: Bool {
        cfg.blocks.contains { b in
            guard b.enabled, status(b).locked else { return false }
            return ([b.brk] + b.slots.map(\.brk)).contains { [.allowance, .reward, .sessions].contains($0.kind) }
        }
    }

    func persist() {
        state.monoAtSave = EffectiveClock.monotonic()
        let c = Store.encode(cfg)
        if c != writtenConfig {
            configRev = max(configRev, Vault.load("config")?.rev ?? 0) + 1
            Vault.save("config", c, rev: configRev)
            Store.write(c, Paths.config)
            writtenConfig = c
        }
        // The clock fields change every save. Alone they are written once a minute, which is enough to carry the clock across a restart.
        var withoutClock = state
        withoutClock.highWater = 0
        withoutClock.monoAtSave = 0
        let essential = Store.encode(withoutClock)
        let s = Store.encode(state)
        if essential != writtenEssential || nowValue - clockSavedAt >= 60 {
            writtenEssential = essential
            clockSavedAt = nowValue
            stateRev += 1
            Vault.save(stateVault, s, rev: stateRev)
            Store.write(s, Paths.state)
            writtenState = s
        }
    }

    /// Takes a newer shared config from another person's agent, and puts back any file changed behind this agent's back.
    func guardFiles() {
        Paths.ensure()
        // The folder went away with the socket in it. Nothing can reach this agent now, so restart from the vault.
        if !FileManager.default.fileExists(atPath: Paths.socket) {
            logLine("socket is gone, restarting")
            exit(1)
        }
        if Paths.isShared, let v = Vault.load("config"), v.rev > configRev, let newer = try? Store.decode(Config.self, data: v.data) {
            cfg = newer
            configRev = v.rev
            writtenConfig = Store.encode(cfg)
            lastRulesJSON = ""
        }
        func restore(_ name: String, _ data: Data, rev: Int, _ url: URL) {
            if (try? Data(contentsOf: url)) != data {
                logLine("restored \(url.lastPathComponent) after an outside change")
                Store.write(data, url)
            }
            let fm = FileManager.default
            if !Vault.urls(name).allSatisfy({ fm.fileExists(atPath: $0.path) }) {
                logLine("restored vault \(name)")
                Paths.ensure()
                Vault.save(name, data, rev: rev)
            }
        }
        restore("config", writtenConfig, rev: configRev, Paths.config)
        restore(stateVault, writtenState, rev: stateRev, Paths.state)
    }

    /// Puts launch jobs, plists and the app back while locked. launchctl blocks, so it stays off the main queue.
    /// File checks every few seconds are free. launchctl is a new process each call, so it runs only when something is missing, and once a minute for a disabled job.
    func healInstall() {
        guard Installer.managed, anyLocked, !healing else { return }
        guard tickCount % 60 == 0 || !Installer.intact() else { return }
        healing = true
        DispatchQueue.global().async { [weak self] in
            Installer.heal()
            DispatchQueue.main.async { self?.healing = false }
        }
    }

    // MARK: Tick

    func tick() {
        let wall = Clock.wall()
        let dt = min(max(wall - lastTick, 0), 5)
        lastTick = wall
        nowValue = clock.now(wall: wall, mono: EffectiveClock.monotonic())
        if clock.tampered { logLine("clock tamper ignored wall=\(wall) effective=\(nowValue)") }
        state.highWater = max(state.highWater, nowValue)
        tickCount += 1
        if tickCount % 5 == 0 { pinZone() }
        fireAutostarts()
        expireLocks()
        runningChanged()
        let idle = Enforcer.idleSeconds() >= 180
        let spent = account(dt: dt, idle: idle)
        enforce()
        pushRules()
        sendNotifications()
        updateMenu()
        // Usage saves at once, or killing the agent every few seconds would keep a limit from ever running down.
        if spent || nowValue - dirtyAt >= 5 {
            persist()
            dirtyAt = nowValue
        }
        if tickCount % 2 == 0 { guardFiles() }
        if tickCount % 5 == 0 { healInstall() }
    }

    /// Debits breaks and writes stats from what has the user's attention this second. Returns whether any block's time was used.
    func account(dt: Double, idle: Bool) -> Bool {
        var spent = false
        let front = NSWorkspace.shared.frontmostApplication
        let frontBundle = front?.bundleURL?.path ?? ""
        let reports = clients.values.compactMap { c -> (BrowserConn, [String: Any])? in c.browser.map { ($0, $0.lastReport) } }
        let focused = reports.first { $0.0.browserPath == frontBundle && ($0.1["focused"] as? Bool ?? false) }
        let audible = reports.contains { $0.1["audible"] as? Bool ?? false }
        let s = cfg.settings
        for b in cfg.blocks where b.enabled {
            var r = state.breaks[b.id] ?? BreakRuntime()
            var used = false
            if b.kind == .device { used = !idle }
            else {
                let matchedFocused = (focused?.1["matched"] as? [String] ?? []).contains(b.id)
                let matchedAny = reports.contains { ($0.1["matchedAny"] as? [String] ?? []).contains(b.id) }
                let appFront = front.map { app in b.apps.contains { Enforcer.appMatches($0, app: app) } } ?? false
                let appRunning = s.countInactive && NSWorkspace.shared.runningApplications.contains { app in b.apps.contains { Enforcer.appMatches($0, app: app) } }
                let heard = reports.contains { ($0.1["matchedAudible"] as? [String] ?? []).contains(b.id) }
                // Sound counts only from the limited site's own tabs (`heard`); a silent tab, focused while idle or in the background, spends nothing.
                used = ((matchedFocused || appFront) && !idle) || heard || (s.countInactive && (matchedAny || appRunning))
            }
            spent = spent || used
            Engine.tick(b, &r, used: used, idle: idle, dt: dt, nowValue)
            state.breaks[b.id] = r
        }
        guard s.statsEnabled else { return spent }
        if cfg.blocks.contains(where: { status($0).blocking }) { stats.addActive(seconds: dt, now: nowValue) }
        guard !idle || audible else { return spent }
        if let f = focused?.1, let host = f["host"] as? String, !host.isEmpty, s.statsIncognito || !(f["incognito"] as? Bool ?? false) {
            stats.addUsage(kind: "web", item: host, seconds: dt, now: nowValue)
        } else if focused == nil, let name = front?.localizedName {
            stats.addUsage(kind: "app", item: name, seconds: dt, now: nowValue)
        }
        return spent
    }

    func enforce() {
        let statuses = cfg.blocks.map { ($0, status($0)) }
        let active = statuses.filter(\.1.blocking)
        let s = cfg.settings

        let entries = active.filter { $0.0.kind == .content }.flatMap(\.0.apps)
        // Process lists cost the most, so binaries, Quick Look and Tor share one scan every 3 seconds.
        let scan = tickCount % 3 == 0
        var procCache: [(pid_t, String)]?
        let procs = { () -> [(pid_t, String)] in
            if procCache == nil { procCache = Enforcer.allProcessPaths() }
            return procCache!
        }
        let paths = entries.map(\.path)
        let appsChanged = appsDirty || paths != lastAppPaths
        lastAppPaths = paths
        appsDirty = false
        if !entries.isEmpty, appsChanged || scan {
            let acted = Enforcer.enforceApps(entries: entries, minimize: s.appAction == "minimize", running: appsChanged ? nil : [], procs: scan ? procs : { [] })
            // Something refused to close, so look again next second.
            if !acted.isEmpty { appsDirty = true }
            noteBlocked(acted)
        }

        for (b, _) in active where b.kind == .device {
            if nowValue - (lastDeviceAct[b.id] ?? 0) >= 10 {
                lastDeviceAct[b.id] = nowValue
                Enforcer.deviceAction(b.action)
            }
        }

        if appsChanged, s.blockTerminal, Browsers.testOnlyApp == nil, anyLocked {
            for id in Enforcer.terminals where Enforcer.killBundle(id) { logLine("closed terminal \(id)"); appsDirty = true }
        }
        guard !active.isEmpty else { state.missing = [:]; return }
        if appsChanged, s.blockActivityMonitor, Enforcer.killBundle("com.apple.ActivityMonitor") { logLine("closed Activity Monitor"); appsDirty = true }
        if scan, s.blockFinderPreviews { Enforcer.killProcessesNamed(["QuickLookUIService", "qlmanage"], procs()) }
        var titles: [String] = []
        if s.blockDateTime { titles.append("Date & Time") }
        if s.blockUsersGroups { titles.append("Users & Groups") }
        if s.blockLoginItems { titles.append("Login Items") }
        if s.blockScreenTime { titles.append("Screen Time") }
        Enforcer.closeSettingsPanes(titles: titles)
        if appsChanged || tickCount % 2 == 0 { enforceBrowsers(statuses, unsupported: appsChanged, procs: scan ? procs() : nil) }
    }

    /// Each kill shortens the next grace period, so reopening a browser with the extension off gets less useful. It stays long enough to turn the extension back on.
    static func grace(base: Int, strikes: Int) -> Double {
        let g = Double(max(0, base))
        return max(min(g, 15), g / pow(2, Double(min(strikes, 6))))
    }

    /// New pids come from the kernel list, one syscall. Each NSRunningApplication property read is a LaunchServices
    /// round trip (sampled), so only new pids are looked up. Launch notifications cover apps that check in after their pid appears.
    func runningChanged() {
        let pids = Enforcer.allPids()
        guard pids != knownPids else { return }
        let fresh = pids.subtracting(knownPids).compactMap { NSRunningApplication(processIdentifier: $0) }
        knownPids = pids
        launchedPids.formIntersection(pids)
        launched(fresh)
    }

    func launched(_ all: [NSRunningApplication]) {
        let apps = all.filter { launchedPids.insert($0.processIdentifier).inserted }
        browsers += apps.filter(Browsers.isSupported)
        for app in apps { enforceApp(app, launched: true) }
    }

    func noteBlocked(_ names: [String]) {
        for name in names {
            stats.addBlocked(item: name, now: nowValue)
            if cfg.settings.notifyAppBlocked { Enforcer.notify("Deadbolt", "\(name) is blocked.") }
        }
    }

    /// Launch and activation of one app. Same rules as the full pass in enforce(), for that app only.
    func enforceApp(_ app: NSRunningApplication, launched: Bool) {
        let statuses = cfg.blocks.map { ($0, status($0)) }
        let active = statuses.filter(\.1.blocking)
        guard !active.isEmpty else { return }
        let s = cfg.settings
        let entries = active.filter { $0.0.kind == .content }.flatMap(\.0.apps).filter { !$0.isBinary }
        noteBlocked(Enforcer.enforceApps(entries: entries, minimize: s.appAction == "minimize", running: [app], procs: { [] }))
        let id = app.bundleIdentifier ?? ""
        if s.blockTerminal && Browsers.testOnlyApp == nil && anyLocked && Enforcer.terminals.contains(id) {
            logLine("closed terminal \(id)")
            Enforcer.close(app)
        }
        if s.blockActivityMonitor && id == "com.apple.ActivityMonitor" {
            logLine("closed Activity Monitor")
            Enforcer.close(app)
        }
        if launched, s.blockUnsupportedBrowsers, statuses.contains(where: { $0.1.armed && $0.0.kind == .content && !$0.0.websites.isEmpty }),
           Browsers.runningUnsupported().contains(where: { $0.processIdentifier == app.processIdentifier }) {
            logLine("closed unsupported browser \(id)")
            app.forceTerminate()
        }
    }

    func enforceBrowsers(_ statuses: [(Block, BlockStatus)], unsupported: Bool, procs: [(pid_t, String)]?) {
        let webBlocks = statuses.filter { $0.1.armed && $0.0.kind == .content && !$0.0.websites.isEmpty }
        guard !webBlocks.isEmpty else { state.missing = [:]; return }
        let lockedWeb = webBlocks.contains { $0.1.locked }
        if unsupported, cfg.settings.blockUnsupportedBrowsers {
            for app in Browsers.runningUnsupported() {
                logLine("closed unsupported browser \(app.bundleIdentifier ?? "")")
                app.forceTerminate()
            }
        }
        guard lockedWeb else { state.missing = [:]; uncoveredSince = [:]; return }
        if let procs, Browsers.testOnlyApp != nil || browsers.contains(where: { $0.bundleIdentifier?.hasPrefix("com.brave.Browser") ?? false }) { Enforcer.killBraveTor(procs) }
        let conns = clients.values.compactMap(\.browser).filter(\.incognitoAllowed)
        browsers.removeAll(where: \.isTerminated)
        let running = browsers
        let grace = cfg.settings.extensionGraceSeconds
        var seen = Set<String>()
        for path in Set(running.compactMap { $0.bundleURL?.path }) {
            seen.insert(path)
            let copies = running.filter { $0.bundleURL?.path == path }
            let bare = copies.filter { app in !conns.contains { $0.pid == app.processIdentifier } }
            guard !bare.isEmpty else { state.missing[path] = nil; continue }
            var rec = state.missing[path] ?? MissingBrowser()
            let since = rec.since ?? nowValue
            rec.since = since
            if nowValue - since >= Agent.grace(base: grace, strikes: rec.strikes) {
                for app in bare {
                    logLine("closed browser without extension \(path) pid=\(app.processIdentifier) strikes=\(rec.strikes)")
                    Enforcer.notify("Deadbolt", "\(app.localizedName ?? path) closed. Its extension is missing or lacks incognito access.")
                    Enforcer.close(app)
                }
                rec.since = nil
                rec.strikes += 1
            }
            state.missing[path] = rec
        }
        // Quitting mid-grace costs the same as being closed.
        for (path, rec) in state.missing where !seen.contains(path) && rec.since != nil {
            state.missing[path] = MissingBrowser(since: nil, strikes: rec.strikes + 1)
        }
        if tickCount % 4 == 0 { checkUnseenWindows(running, conns) }
    }

    /// Guest windows, Tor windows and profiles without the extension share a browser process that is connected through another profile.
    /// Only the window count gives them away: more on screen than every extension in that process reports.
    func checkUnseenWindows(_ running: [NSRunningApplication], _ conns: [BrowserConn]) {
        let pids = Set(running.map(\.processIdentifier))
        uncoveredSince = uncoveredSince.filter { pids.contains($0.key) }
        for app in running {
            let pid = app.processIdentifier
            let mine = conns.filter { $0.pid == pid && $0.lastReport["windows"] != nil }
            guard !mine.isEmpty else { uncoveredSince[pid] = nil; continue }
            let known = mine.reduce(0) { $0 + (($1.lastReport["windows"] as? Int) ?? 0) }
            guard Enforcer.browserWindows(pid: pid) > known else { uncoveredSince[pid] = nil; continue }
            let since = uncoveredSince[pid] ?? nowValue
            // Some browser dialogs look like windows too, such as Task Manager, so say what's coming before acting.
            if uncoveredSince[pid] == nil { Enforcer.notify("Deadbolt", "Close the guest window, or any window from a profile without the extension. \(app.localizedName ?? "The browser") closes in \(cfg.settings.extensionGraceSeconds) seconds otherwise.") }
            uncoveredSince[pid] = since
            if nowValue - since >= Double(cfg.settings.extensionGraceSeconds) {
                logLine("closed browser with a window the extension can't see pid=\(pid)")
                Enforcer.notify("Deadbolt", "\(app.localizedName ?? "Browser") closed. A guest window or a profile without the extension was open.")
                Enforcer.close(app)
                uncoveredSince[pid] = nil
            }
        }
    }

    func expireLocks() {
        var changed = false
        for i in cfg.blocks.indices {
            let b = cfg.blocks[i]
            let lockRt = state.locks[b.id]
            switch b.lock.kind {
            case .timer where nowValue >= (b.lock.until ?? 0):
                if cfg.settings.notifyTimerEnd, b.enabled { Enforcer.notify("Deadbolt", "The timer lock on \(b.name) ended.") }
                if b.lock.autoDisable { cfg.blocks[i].enabled = false }
                cfg.blocks[i].lock = LockCfg()
                changed = true
            case .delay where (lockRt?.unlockAt ?? .infinity) <= nowValue:
                if cfg.settings.notifyDelayEnd { Enforcer.notify("Deadbolt", "The delay lock on \(b.name) ended.") }
                cfg.blocks[i].lock = LockCfg()
                state.locks[b.id] = nil
                changed = true
            case .restart where b.lock.bootId != bootId:
                if b.lock.autoDisable { cfg.blocks[i].enabled = false }
                cfg.blocks[i].lock = LockCfg()
                changed = true
            default: break
            }
        }
        if changed { persist() }
    }

    func enable(_ i: Int) {
        cfg.blocks[i].enabled = true
        cfg.blocks[i].enabledAt = nowValue
    }

    func fireAutostart(_ i: Int, key: String) {
        guard cfg.blocks[i].autostart.firedKey != key else { return }
        cfg.blocks[i].autostart.firedKey = key
        if !cfg.blocks[i].enabled { enable(i) }
        let minutes = cfg.blocks[i].autostart.durationMinutes
        if minutes > 0 {
            cfg.blocks[i].lock = LockCfg(kind: .timer, until: nowValue + Double(minutes * 60), autoDisable: true)
        }
        if cfg.settings.notifyAutostart { Enforcer.notify("Deadbolt", "\(cfg.blocks[i].name) started.") }
        logLine("autostart \(cfg.blocks[i].name) key=\(key)")
        persist()
    }

    func fireAutostarts() {
        for i in cfg.blocks.indices {
            let b = cfg.blocks[i], a = b.autostart
            switch a.kind {
            case .oneTime:
                if let at = a.at, nowValue >= at { fireAutostart(i, key: "once:\(Int(at))") }
            case .timeOfDay:
                let m = Engine.minuteOfDay(nowValue)
                if a.days.contains(Engine.weekday(nowValue)), m >= a.minute, m < a.minute + 2 {
                    fireAutostart(i, key: "day:\(Int(Engine.startOfDay(nowValue)))")
                }
            case .schedule:
                if !b.enabled, let slot = Engine.currentSlot(b, nowValue) {
                    fireAutostart(i, key: "slot:\(Int(Engine.startOfDay(nowValue))):\(slot.start)")
                }
            default: break
            }
        }
    }

    func fireSignIn() {
        for i in cfg.blocks.indices where cfg.blocks[i].autostart.kind == .signIn {
            fireAutostart(i, key: "signin:\(Int(nowValue))")
        }
    }

    // MARK: Notifications

    func warnOnce(_ key: String, _ title: String, _ body: String) {
        guard state.notified[key] == nil else { return }
        state.notified[key] = nowValue
        Enforcer.notify(title, body)
    }

    func minutes(_ csv: String) -> [Int] { csv.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) } }

    func sendNotifications() {
        let s = cfg.settings
        state.notified = state.notified.filter { nowValue - $0.value < 2 * 86400 }
        for b in cfg.blocks where b.enabled {
            let st = status(b)
            if let was = previousArmed[b.id], was != st.armed, b.scheduled {
                if st.armed && s.notifyScheduleStart { Enforcer.notify("Deadbolt", "\(b.name) started.") }
                if !st.armed && s.notifyScheduleEnd { Enforcer.notify("Deadbolt", "\(b.name) ended.") }
            }
            previousArmed[b.id] = st.armed
            if st.breakKind == .pomodoro, s.notifyBreak {
                if let was = previousPomodoro[b.id], was != st.blocking {
                    Enforcer.notify("Deadbolt", st.blocking ? "Pomodoro break over for \(b.name)." : "Pomodoro break started for \(b.name).")
                }
                previousPomodoro[b.id] = st.blocking
            }
            if b.lock.kind == .timeRange, s.notifyRange {
                if let was = previousRange[b.id], was != st.locked {
                    Enforcer.notify("Deadbolt", st.locked ? "\(b.name) is now locked." : "\(b.name) is now unlocked.")
                }
                previousRange[b.id] = st.locked
            }
            if b.scheduled, let next = Engine.nextSlotStart(b, nowValue) {
                for m in minutes(s.scheduleWarnings) where next - nowValue <= Double(m * 60) {
                    warnOnce("sched:\(b.id):\(Int(next)):\(m)", "Deadbolt", "\(b.name) starts in \(m) minute(s).")
                }
            }
            if let left = st.leftSeconds {
                for m in minutes(s.allowanceWarnings) where left > 0 && left <= Double(m * 60) {
                    warnOnce("left:\(b.id):\(state.breaks[b.id]?.windowKey ?? ""):\(m)", "Deadbolt", "\(b.name) has \(m) minute(s) of break left.")
                }
                if left <= 0, s.notifyAllowanceOut { warnOnce("out:\(b.id):\(state.breaks[b.id]?.windowKey ?? "")", "Deadbolt", "The break for \(b.name) ran out.") }
            }
        }
        for b in cfg.blocks where b.autostart.kind == .oneTime {
            if let at = b.autostart.at, at > nowValue {
                for m in minutes(s.autostartWarnings) where at - nowValue <= Double(m * 60) {
                    warnOnce("auto:\(b.id):\(Int(at)):\(m)", "Deadbolt", "\(b.name) autostarts in \(m) minute(s).")
                }
            }
        }
    }

    // MARK: Browser rules

    func rulesMessage() -> [String: Any] {
        let s = cfg.settings
        let blocks: [[String: Any]] = cfg.blocks.compactMap { b in
            guard b.kind == .content, b.enabled, !b.websites.isEmpty, Engine.applies(b) else { return nil }
            let st = status(b)
            var e = b.exceptions
            if s.allowFileUrls, !e.contains("file://*") { e.append("file://*") }
            return ["id": b.id, "name": b.name, "websites": b.websites, "exceptions": e, "blocking": st.blocking, "failClosed": st.locked]
        }
        var withFilter = blocks
        if s.autoBlockAdult {
            let held = state.sites.filter { $0.value.label == .adult || $0.value.label == .checking }.keys.sorted()
            let allowed = state.sites.filter { $0.value.label == .allowed }.keys.sorted()
            withFilter.append(["id": AdultFilter.blockId, "name": "Adult site filter", "websites": AdultFilter.tldEntries + AdultFilter.knownHosts + held, "exceptions": allowed, "blocking": true])
        }
        return ["type": "rules", "blocks": withFilter, "settings": [
            "blockInactiveTabs": s.blockInactiveTabs, "blockEmbedded": s.blockEmbedded,
            "statsEnabled": s.statsEnabled, "statsIncognito": s.statsIncognito,
        ]]
    }

    /// Before uninstalling: an extension left behind would otherwise keep blocking on its stored rules.
    func clearBrowsers() {
        let empty = #"{"type":"rules","blocks":[],"settings":{}}"#
        leaving = true
        for c in clients.values where c.browser != nil { sendRaw(c, empty) }
    }

    func pushRules(force: Client? = nil) {
        guard !leaving else { return }
        let msg = rulesMessage()
        guard let data = try? JSONSerialization.data(withJSONObject: msg, options: .sortedKeys),
              let json = String(data: data, encoding: .utf8) else { return }
        if let c = force { sendRaw(c, json); return }
        guard json != lastRulesJSON else { return }
        lastRulesJSON = json
        for c in clients.values where c.browser != nil { sendRaw(c, json) }
    }

    // MARK: Adult site filter

    func classify(host raw: String, title: String, description: String, rating: String) {
        guard cfg.settings.autoBlockAdult else { return }
        let host = AdultFilter.normalized(raw)
        guard !host.isEmpty, !AdultFilter.isKnown(host), !AdultFilter.isPrivate(host), !AdultFilter.within(host, AdultFilter.mainstream) else { return }
        if AdultFilter.covering(host, in: state.sites) != nil { return }
        if let v = state.sites[host], v.label != .checking, !(v.label == .clean && nowValue - v.at > AdultFilter.cleanTTL) { return }
        if rating.contains("rta-5042") {
            setVerdict(host, .adult, "page signal")
            return
        }
        if AdultFilter.hasSignal(host: host, title: title, description: description, rating: rating), state.sites[host]?.label != .checking {
            setVerdict(host, .checking, "page signal")
        }
        guard !classifying.contains(host), (retryAt[host] ?? 0) <= nowValue else { return }
        let day = Stats.day(nowValue)
        if state.modelCallDay != day { state.modelCallDay = day; state.modelCalls = 0 }
        guard state.modelCalls < AdultFilter.dailyModelCalls else {
            lastModelError = "Daily limit of \(AdultFilter.dailyModelCalls) site checks reached."
            logLine("classify skipped, daily limit reached host=\(host)")
            return
        }
        state.modelCalls += 1
        classifying.insert(host)
        let prompt = AdultFilter.prompt(host: host, title: title, description: description)
        modelQueue.addOperation { [weak self] in
            let start = Date()
            let answer = AdultFilter.ask(prompt: prompt)
            let seconds = Date().timeIntervalSince(start)
            DispatchQueue.main.async { self?.finishClassify(host, answer.label, answer.error, seconds) }
        }
    }

    func setVerdict(_ host: String, _ label: SiteLabel, _ source: String) {
        state.sites[host] = SiteVerdict(label: label, source: source, at: nowValue)
        persist()
        pushRules()
    }

    func finishClassify(_ host: String, _ label: SiteLabel?, _ error: String?, _ seconds: Double) {
        classifying.remove(host)
        logLine(String(format: "classify host=%@ verdict=%@ seconds=%.1f%@", host, label?.rawValue ?? "none", seconds, error.map { " error=\($0)" } ?? ""))
        lastModelError = error
        // A user decision made while the model ran wins.
        guard state.sites[host]?.label != .allowed else { return }
        if let label { setVerdict(host, label, "model") } else { retryAt[host] = nowValue + AdultFilter.retryAfterFailure }
    }

    // MARK: Socket

    func listen() {
        let path = Paths.socket
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = path.withCString { strncpy(&addr.sun_path.0, $0, 103) }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) } }
        guard bound == 0, Darwin.listen(fd, 16) == 0 else { logLine("socket bind failed: \(String(cString: strerror(errno)))"); exit(1) }
        chmod(path, 0o600)
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        src.setEventHandler { [weak self] in
            let c = accept(fd, nil, nil)
            if c >= 0 { self?.addClient(c) }
        }
        src.resume()
        listenSource = src
    }
    var listenSource: DispatchSourceRead?

    func addClient(_ fd: Int32) {
        var tv = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let client = Client(fd: fd)
        clients[fd] = client
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        client.source = src
        src.setEventHandler { [weak self, weak client] in
            guard let self, let client else { return }
            var buf = [UInt8](repeating: 0, count: 65536)
            let n = read(fd, &buf, buf.count)
            if n <= 0 { self.removeClient(client); return }
            client.buffer.append(buf, count: n)
            while let nl = client.buffer.firstIndex(of: 10) {
                let line = client.buffer.subdata(in: client.buffer.startIndex..<nl)
                client.buffer.removeSubrange(client.buffer.startIndex...nl)
                self.handleLine(line, client)
            }
        }
        src.resume()
    }

    func removeClient(_ c: Client) {
        if let b = c.browser { logLine("browser disconnected \(b.browserPath)") }
        c.source?.cancel()
        close(c.fd)
        clients[c.fd] = nil
    }

    func sendRaw(_ c: Client, _ json: String) {
        let data = Data((json + "\n").utf8)
        _ = data.withUnsafeBytes { write(c.fd, $0.baseAddress, data.count) }
    }

    func send(_ c: Client, _ obj: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) { sendRaw(c, s) }
    }

    func handleLine(_ line: Data, _ c: Client) {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
        if let type = obj["type"] as? String { handleBrowser(type, obj, c); return }
        let id = obj["id"] ?? 0
        let cmd = obj["cmd"] as? String ?? ""
        do {
            let result = try API.handle(self, cmd, obj["args"] as? [String: Any] ?? [:])
            send(c, ["id": id, "ok": true, "result": result])
        } catch {
            send(c, ["id": id, "ok": false, "error": "\(error)"])
        }
    }

    /// Browser pipes reach only this allowlist, so a compromised extension can't rewrite blocks.
    func handleBrowser(_ type: String, _ obj: [String: Any], _ c: Client) {
        switch type {
        case "hello":
            let b = c.browser ?? BrowserConn()
            b.browserPath = obj["browserPath"] as? String ?? ""
            b.pid = (obj["pid"] as? NSNumber)?.int32Value ?? 0
            b.lastSeen = nowValue
            c.browser = b
            logLine("browser connected \(b.browserPath)")
            pushRules(force: c)
        case "ext":
            c.browser?.incognitoAllowed = obj["incognitoAllowed"] as? Bool ?? false
            c.browser?.extensionHello = true
            c.browser?.lastSeen = nowValue
        case "report":
            c.browser?.lastReport = obj
            c.browser?.lastSeen = nowValue
        case "classify":
            func clipped(_ key: String, _ limit: Int) -> String { String((obj[key] as? String ?? "").prefix(limit)) }
            classify(host: clipped("host", 253), title: clipped("title", 200), description: clipped("description", 300), rating: clipped("rating", 100).lowercased())
        case "blocked":
            if cfg.settings.statsEnabled, let host = obj["host"] as? String { stats.addBlocked(item: host, now: nowValue) }
        case "req":
            let id = obj["id"] ?? 0
            let cmd = obj["cmd"] as? String ?? ""
            guard ["blockStatus", "startBreak", "cancelBreak"].contains(cmd) else {
                send(c, ["type": "res", "id": id, "ok": false, "error": "not allowed"])
                return
            }
            do {
                let r = try API.handle(self, cmd, obj["args"] as? [String: Any] ?? [:])
                send(c, ["type": "res", "id": id, "ok": true, "result": r])
                pushRules()
            } catch {
                send(c, ["type": "res", "id": id, "ok": false, "error": "\(error)"])
            }
        default: break
        }
    }

    // MARK: Menu

    func setupMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "DB"
        item.menu = NSMenu()
        menuBox.fill = { [weak self] menu in self?.fillMenu(menu) }
        item.menu?.delegate = menuBox
        statusItem = item
    }


    /// Only the title follows the tick, and only when it changes. The menu is built when it opens.
    func updateMenu() {
        let title = cfg.blocks.contains { status($0).blocking } ? "DB on" : "DB"
        if statusItem?.button?.title != title { statusItem?.button?.title = title }
    }

    func fillMenu(_ menu: NSMenu) {
        let lines = cfg.blocks.filter(\.enabled).map { b -> String in
            let st = status(b)
            return "\(st.locked ? "Locked" : "Open"): \(b.name) (\(st.reason))"
        }
        menu.removeAllItems()
        for l in lines { menu.addItem(withTitle: l, action: nil, keyEquivalent: "") }
        if !lines.isEmpty { menu.addItem(.separator()) }
        let open = NSMenuItem(title: "Open Deadbolt", action: #selector(MenuBox.openUI), keyEquivalent: "")
        open.target = menuBox
        menu.addItem(open)
    }
}
