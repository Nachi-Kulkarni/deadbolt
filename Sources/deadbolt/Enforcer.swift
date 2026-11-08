import AppKit
import ApplicationServices
import Darwin

struct BrowserSpec {
    let bundleId: String
    let name: String
    let nmhDir: String?  // under ~/Library/Application Support, nil means the extension can't run there
}

enum Browsers {
    static let supported: [BrowserSpec] = [
        .init(bundleId: "com.google.Chrome", name: "Chrome", nmhDir: "Google/Chrome/NativeMessagingHosts"),
        .init(bundleId: "com.google.Chrome.beta", name: "Chrome Beta", nmhDir: "Google/Chrome Beta/NativeMessagingHosts"),
        .init(bundleId: "com.google.Chrome.dev", name: "Chrome Dev", nmhDir: "Google/Chrome Dev/NativeMessagingHosts"),
        // Brave on macOS reads user host manifests from Chrome's folder, not its own (measured 2026-11-08: "host not found" until moved).
        .init(bundleId: "com.brave.Browser", name: "Brave", nmhDir: "Google/Chrome/NativeMessagingHosts"),
        .init(bundleId: "com.brave.Browser.beta", name: "Brave Beta", nmhDir: "BraveSoftware/Brave-Browser-Beta/NativeMessagingHosts"),
        .init(bundleId: "com.brave.Browser.nightly", name: "Brave Nightly", nmhDir: "BraveSoftware/Brave-Browser-Nightly/NativeMessagingHosts"),
        .init(bundleId: "com.microsoft.edgemac", name: "Edge", nmhDir: "Microsoft Edge/NativeMessagingHosts"),
        .init(bundleId: "com.microsoft.edgemac.Beta", name: "Edge Beta", nmhDir: "Microsoft Edge Beta/NativeMessagingHosts"),
        .init(bundleId: "com.microsoft.edgemac.Dev", name: "Edge Dev", nmhDir: "Microsoft Edge Dev/NativeMessagingHosts"),
        .init(bundleId: "com.vivaldi.Vivaldi", name: "Vivaldi", nmhDir: "Vivaldi/NativeMessagingHosts"),
        .init(bundleId: "com.operasoftware.Opera", name: "Opera", nmhDir: "com.operasoftware.Opera/NativeMessagingHosts"),
        .init(bundleId: "com.operasoftware.OperaGX", name: "Opera GX", nmhDir: "com.operasoftware.OperaGX/NativeMessagingHosts"),
        .init(bundleId: "company.thebrowser.Browser", name: "Arc", nmhDir: "Arc/User Data/NativeMessagingHosts"),
        .init(bundleId: "ai.perplexity.comet", name: "Comet", nmhDir: "Comet/NativeMessagingHosts"),
        .init(bundleId: "com.meetsidekick.sidekick", name: "Sidekick", nmhDir: "Sidekick/NativeMessagingHosts"),
        .init(bundleId: "org.chromium.Chromium", name: "Chromium", nmhDir: "Chromium/NativeMessagingHosts"),
        .init(bundleId: "org.mozilla.firefox", name: "Firefox", nmhDir: "Mozilla/NativeMessagingHosts"),
        .init(bundleId: "org.mozilla.firefoxdeveloperedition", name: "Firefox Dev", nmhDir: "Mozilla/NativeMessagingHosts"),
    ]

    /// Safari is here because a Safari extension needs full Xcode and a signing identity.
    static let unsupported: [String: String] = [
        "com.apple.Safari": "Safari", "com.duckduckgo.macos.browser": "DuckDuckGo", "org.torproject.torbrowser": "Tor Browser",
        "com.google.Chrome.canary": "Chrome Canary", "com.microsoft.edgemac.Canary": "Edge Canary", "ru.yandex.desktop.yandex-browser": "Yandex",
        "org.waterfoxproject.waterfox": "Waterfox", "com.naver.Whale": "Naver Whale", "com.epicbrowser.epic": "Epic",
        "com.maxthon.mac.Maxthon": "Maxthon", "com.kagi.kagimacOS": "Orion", "app.zen-browser.zen": "Zen", "org.mozilla.librewolf": "LibreWolf",
        "net.mullvad.mullvadbrowser": "Mullvad", "org.floorp.floorp": "Floorp", "company.thebrowser.dia": "Dia", "com.sigmaos.sigmaos.macos": "SigmaOS",
    ]

    /// Test seam: limits every browser kill to one exact app path, so e2e runs can't touch real browsers or another copy with the same bundle id.
    static let testOnlyApp = Seams.get("DEADBOLT_TEST_BROWSER_APP")

    /// Running apps that must carry the extension.
    static let supportedIds = Set(supported.map(\.bundleId))
    static func isSupported(_ app: NSRunningApplication) -> Bool {
        if let only = testOnlyApp { return app.bundleURL?.path == only }
        return app.bundleIdentifier.map(supportedIds.contains) ?? false
    }
    static func runningSupported() -> [NSRunningApplication] { NSWorkspace.shared.runningApplications.filter(isSupported) }

    /// The list can't name every browser, so anything registered to open https links counts too, and Safari's Dock web apps.
    static func isUnsupported(_ id: String, httpsHandlers: Set<String>) -> Bool {
        if supported.contains(where: { $0.bundleId == id }) || Enforcer.neverKill.contains(id) { return false }
        return unsupported[id] != nil || id.hasPrefix("com.apple.Safari.WebApp") || httpsHandlers.contains(id)
    }

    static func runningUnsupported() -> [NSRunningApplication] {
        guard testOnlyApp == nil, let probe = URL(string: "https://example.com") else { return [] }
        let handlers = Set(NSWorkspace.shared.urlsForApplications(toOpen: probe).compactMap { Bundle(url: $0)?.bundleIdentifier })
        return NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier.map { isUnsupported($0, httpsHandlers: handlers) } ?? false }
    }
}

enum Enforcer {
    static let neverKill: Set<String> = [
        "com.apple.finder", "com.apple.loginwindow", "com.apple.dock", "com.apple.WindowManager", "com.apple.systemuiserver", "com.deadbolt.app",
    ]
    static let dryDevice = Seams.get("DEADBOLT_DRY_DEVICE") != nil
    static let terminals = ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "io.alacritty", "com.github.wez.wezterm", "net.kovidgoyal.kitty", "com.mitchellh.ghostty"]

    static func allPids() -> Set<pid_t> {
        var pids = [pid_t](repeating: 0, count: 8192)
        let n = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        return Set(pids.prefix(Int(max(n, 0))).filter { $0 > 0 })
    }

    static func allProcessPaths() -> [(pid_t, String)] {
        var pids = [pid_t](repeating: 0, count: 8192)
        let bytes = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        guard bytes > 0 else { return [] }
        var out: [(pid_t, String)] = []
        var buf = [CChar](repeating: 0, count: 4096)
        for pid in pids.prefix(Int(bytes)) where pid > 0 && pid != getpid() {
            if proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 { out.append((pid, String(cString: buf))) }
        }
        return out
    }

    /// Bundle id catches a moved or renamed copy that a path check alone would miss.
    static func appMatches(_ e: AppEntry, app: NSRunningApplication) -> Bool {
        if let id = e.bundleId, id == app.bundleIdentifier { return true }
        guard let path = app.bundleURL?.path else { return false }
        return e.isFolder ? path.hasPrefix(e.path.hasSuffix("/") ? e.path : e.path + "/") : path == e.path
    }

    /// Returns names of anything it acted on.
    @discardableResult
    static func enforceApps(entries: [AppEntry], minimize: Bool, running: [NSRunningApplication]? = nil, procs: () -> [(pid_t, String)] = allProcessPaths) -> [String] {
        var acted: [String] = []
        let apps = entries.filter { !$0.isBinary }
        for app in apps.isEmpty ? [] : running ?? NSWorkspace.shared.runningApplications {
            guard let id = app.bundleIdentifier, !neverKill.contains(id), app.processIdentifier != getpid() else { continue }
            guard apps.contains(where: { appMatches($0, app: app) }) else { continue }
            if minimize { if !app.isHidden { app.hide(); acted.append(app.localizedName ?? id) } }
            else {
                close(app)
                acted.append(app.localizedName ?? id)
                logLine("killed app \(id) pid=\(app.processIdentifier)")
            }
        }
        let binaries = entries.filter(\.isBinary).map(\.path)
        if !binaries.isEmpty {
            for (pid, path) in procs() where binaries.contains(path) {
                kill(pid, SIGKILL)
                acted.append((path as NSString).lastPathComponent)
                logLine("killed binary \(path) pid=\(pid)")
            }
        }
        return acted
    }

    /// forceTerminate sometimes leaves a browser running (measured with Chrome for Testing), and a missed close costs a whole grace period.
    static func close(_ app: NSRunningApplication) {
        app.forceTerminate()
        kill(app.processIdentifier, SIGKILL)
    }

    static func killBundle(_ id: String) -> Bool {
        var hit = false
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: id) {
            app.forceTerminate()
            hit = true
        }
        return hit
    }

    static func killProcessesNamed(_ names: Set<String>, _ procs: [(pid_t, String)]) {
        for (pid, path) in procs where names.contains((path as NSString).lastPathComponent) { kill(pid, SIGKILL) }
    }

    /// Brave's Tor windows run through their own binary, and no extension can act inside them.
    static func killBraveTor(_ procs: [(pid_t, String)]) {
        let scope = Browsers.testOnlyApp == nil ? "" : Paths.home.deletingLastPathComponent().path
        for (pid, path) in procs where path.hasPrefix(scope) && path.contains("/BraveSoftware/") && (path as NSString).lastPathComponent.hasPrefix("tor-") {
            kill(pid, SIGKILL)
            logLine("stopped Brave Tor pid=\(pid)")
        }
    }

    /// Browser windows on every Space, since a window parked on another Space is still usable. No permission needed, since it reads no titles.
    /// Chrome's own bars and helpers measured under 200 tall, so the size filter drops them.
    static func browserWindows(pid: pid_t) -> Int {
        guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return 0 }
        return list.filter { w in
            guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0, (w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let b = w[kCGWindowBounds as String] as? [String: Double] else { return false }
            return (b["Width"] ?? 0) >= 300 && (b["Height"] ?? 0) >= 200
        }.count
    }

    static var hasAccessibility: Bool { AXIsProcessTrusted() }

    /// macOS has no API for the open Settings pane, so this reads the window title and needs Accessibility.
    static func closeSettingsPanes(titles: [String]) {
        guard !titles.isEmpty, hasAccessibility else { return }
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences") {
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &value) == .success, let windows = value as? [AXUIElement] else { continue }
            for w in windows {
                var t: CFTypeRef?
                AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
                if let title = t as? String, titles.contains(where: { title.localizedCaseInsensitiveContains($0) }) {
                    logLine("closed settings pane \(title)")
                    app.forceTerminate()
                }
            }
        }
    }

    static func deviceAction(_ action: DeviceAction) {
        if dryDevice { logLine("device action (dry): \(action.rawValue)"); return }
        logLine("device action: \(action.rawValue)")
        switch action {
        case .lock:
            typealias LockFn = @convention(c) () -> Int32
            let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_NOW)
            if let sym = dlsym(handle, "SACLockScreenImmediate") { _ = unsafeBitCast(sym, to: LockFn.self)() }
            else { run("/usr/bin/pmset", ["displaysleepnow"]) }
        case .signOut: run("/usr/bin/osascript", ["-e", "tell application \"loginwindow\" to «event aevtrlgo»"])
        case .shutDown: run("/usr/bin/osascript", ["-e", "tell application \"loginwindow\" to «event aevtrsdn»"])
        }
    }

    static func notify(_ title: String, _ body: String) {
        logLine("notify: \(title): \(body)")
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        run("/usr/bin/osascript", ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\""])
    }

    static func run(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        try? p.run()
    }

    static func idleSeconds() -> Double {
        // Test seam: an unattended e2e run has no real input to measure.
        if Seams.get("DEADBOLT_TEST_NOT_IDLE") != nil { return 0 }
        let types: [CGEventType] = [.mouseMoved, .keyDown, .leftMouseDown, .scrollWheel]
        return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    }

    static func bootId() -> String {
        if let id = Seams.get("DEADBOLT_TEST_BOOT_ID") { return id }
        var size = 0
        sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0)
        var buf = [CChar](repeating: 0, count: size)
        sysctlbyname("kern.bootsessionuuid", &buf, &size, nil, 0)
        return String(cString: buf)
    }
}

/// Wall time that resists clock edits: a jump away from monotonic time is ignored, and it never goes behind the saved high-water mark.
struct EffectiveClock {
    private var anchorWall: Double
    private var anchorMono: Double
    private(set) var tampered = false
    static let tolerance = 300.0

    init(wall: Double, mono: Double, highWater: Double) {
        anchorWall = max(wall, highWater)
        anchorMono = mono
    }

    /// Start time for a new agent. Within one boot the monotonic clock shows what really passed, so a clock changed while the agent was down is caught.
    static func startWall(wall: Double, mono: Double, sameBoot: Bool, highWater: Double, monoAtSave: Double) -> Double {
        guard sameBoot, monoAtSave > 0, mono >= monoAtSave else { return wall }
        let expected = highWater + (mono - monoAtSave)
        return abs(wall - expected) > tolerance ? expected : wall
    }

    /// Time from a web server's Date header. Certificates are not checked, because a clock moved far enough makes every certificate look invalid.
    /// ponytail: a hostile network could lie about the time, and offline falls back to the system clock. Both only matter across a reboot.
    static func networkTime() -> Double? {
        final class Trust: NSObject, URLSessionDelegate {
            func urlSession(_ s: URLSession, didReceive c: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
                guard let t = c.protectionSpace.serverTrust else { return completionHandler(.performDefaultHandling, nil) }
                completionHandler(.useCredential, URLCredential(trust: t))
            }
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 3
        let session = URLSession(configuration: cfg, delegate: Trust(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: URL(string: "https://www.apple.com/")!)
        request.httpMethod = "HEAD"
        let done = DispatchSemaphore(value: 0)
        var out: Double?
        let began = Date()
        session.dataTask(with: request) { _, r, e in
            if let d = (r as? HTTPURLResponse)?.value(forHTTPHeaderField: "Date") {
                let f = DateFormatter()
                f.locale = Locale(identifier: "en_US_POSIX")
                f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
                out = f.date(from: d)?.timeIntervalSince1970
            }
            if let e { logLine("network time failed: \(e.localizedDescription)") }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 4)
        logLine(String(format: "network time %@ in %.2fs", out.map { String($0) } ?? "unavailable", Date().timeIntervalSince(began)))
        return out
    }

    mutating func now(wall: Double, mono: Double) -> Double {
        let expected = anchorWall + (mono - anchorMono)
        if abs(wall - expected) > Self.tolerance {
            tampered = true
            return expected
        }
        tampered = false
        anchorWall = max(wall, expected - Self.tolerance)
        anchorMono = mono
        return anchorWall
    }

    static func monotonic() -> Double {
        var t = timespec()
        clock_gettime(CLOCK_MONOTONIC, &t)
        return Double(t.tv_sec) + Double(t.tv_nsec) / 1e9
    }
}
