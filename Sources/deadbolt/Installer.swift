import AppKit

enum Installer {
    static let hostName = "com.deadbolt.blocker"
    static let extensionId = "omjmhpcjabdffmlhmolbbpgjnlpcocfo"
    static let stamp = Seams.get("DEADBOLT_LABEL") ?? "com.deadbolt"
    static let agentLabel = "\(stamp).agent"
    static let guardianLabel = "\(stamp).guardian"
    static let jobs = [(agentLabel, "agent"), (guardianLabel, "guard")]
    static let skipHosts = Seams.get("DEADBOLT_SKIP_HOSTS") != nil
    static var domain: String { "gui/\(getuid())" }

    static var appPath: String { NativeHost.appBundle(of: exec) }
    static var exec: String { Bundle.main.executablePath ?? CommandLine.arguments[0] }
    static let binary = "Contents/MacOS/Deadbolt"
    /// The job runs from here, so deleting the app from /Applications doesn't stop it, and the app can be put back from here.
    static var spare: String { Paths.home.appendingPathComponent("app/Deadbolt.app").path }
    static var agentsDir: URL {
        if let d = Seams.get("DEADBOLT_AGENTS_DIR") { return URL(fileURLWithPath: d) }
        if Paths.isShared { return URL(fileURLWithPath: Paths.systemRoot + "/Library/LaunchAgents") }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
    }
    static func plist(_ label: String) -> URL { agentsDir.appendingPathComponent("\(label).plist") }
    /// Holds the app's original path. Kept in two folders, like the vault.
    static var markers: [URL] { [Paths.home, Paths.backup].map { $0.appendingPathComponent("installed") } }
    static var origin: String? {
        markers.lazy.compactMap { try? String(contentsOf: $0, encoding: .utf8) }.first { !$0.isEmpty }
    }

    static var underJob: Bool { jobs.contains { $0.0 == Seams.env["XPC_SERVICE_NAME"] } }
    /// Agents started by hand and by tests never touch launchd.
    static var managed: Bool {
        if Seams.get("DEADBOLT_HOME") != nil && Seams.get("DEADBOLT_LABEL") == nil { return false }
        return underJob || markers.contains { FileManager.default.fileExists(atPath: $0.path) }
    }

    static func browserAppURL(_ id: String) -> URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) }

    static func writeIfChanged(_ data: Data, _ url: URL) {
        if (try? Data(contentsOf: url)) == data { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        do { try data.write(to: url, options: .atomic) }
        catch { logLine("could not write \(url.path): \(error)") }
    }

    static func writeHostManifests() {
        guard !skipHosts else { return }
        let target = Paths.isShared ? exec : spare + "/" + binary
        let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        for spec in Browsers.supported {
            guard let dir = spec.nmhDir, browserAppURL(spec.bundleId) != nil else { continue }
            var manifest: [String: Any] = ["name": hostName, "description": "Deadbolt native host", "path": hostWrapper(target), "type": "stdio"]
            if spec.name.hasPrefix("Firefox") { manifest["allowed_extensions"] = ["blocker@deadbolt.local"] }
            else { manifest["allowed_origins"] = ["chrome-extension://\(extensionId)/"] }
            guard let data = try? JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys]) else { continue }
            writeIfChanged(data, support.appendingPathComponent(dir).appendingPathComponent("\(hostName).json"))
        }
    }

    /// Browsers pass an origin argument, not a subcommand, so a small script supplies `nmh`.
    static func hostWrapper(_ exec: String) -> String {
        let wrapper = Paths.home.appendingPathComponent("nmh.sh")
        writeIfChanged(Data("#!/bin/sh\nexec \"\(exec)\" nmh\n".utf8), wrapper)
        chmod(wrapper.path, 0o755)
        return wrapper.path
    }

    static func plistData(label: String, arg: String, exec: String, errorLog: String) -> Data {
        var body: [String: Any] = [
            "Label": label,
            "ProgramArguments": [exec, arg],
            "KeepAlive": true,
            "RunAtLoad": true,
            "ThrottleInterval": 1,
            "AssociatedBundleIdentifiers": "com.deadbolt.app",
            "StandardErrorPath": errorLog,
        ]
        // launchd starts jobs with a clean environment, so a test job must be told where it lives.
        if stamp != "com.deadbolt" {
            let keys = ["DEADBOLT_HOME", "DEADBOLT_LABEL", "DEADBOLT_AGENTS_DIR", "DEADBOLT_SKIP_HOSTS", "DEADBOLT_TEST_BROWSER_APP", "DEADBOLT_DRY_DEVICE", "DEADBOLT_TEST_NOT_IDLE"]
            body["EnvironmentVariables"] = Seams.env.filter { keys.contains($0.key) }
        }
        return (try? PropertyListSerialization.data(fromPropertyList: body, format: .xml, options: 0)) ?? Data()
    }

    static func expectedPlists() -> [(URL, Data)] {
        jobs.map { label, arg in
            (plist(label), plistData(label: label, arg: arg, exec: spare + "/" + binary, errorLog: Paths.home.appendingPathComponent("\(arg).err").path))
        }
    }

    static func writePlists() {
        guard !Paths.isShared else { return }
        for (url, data) in expectedPlists() { writeIfChanged(data, url) }
    }

    static var guardianPid: URL { Paths.home.appendingPathComponent(Paths.perUser("guardian", "pid")) }

    /// Everything heal() would fix, checked with file reads and no new processes.
    static func intact() -> Bool {
        let fm = FileManager.default
        if !Paths.isShared {
            if expectedPlists().contains(where: { (try? Data(contentsOf: $0.0)) != $0.1 }) { return false }
            if !fm.fileExists(atPath: spare + "/" + binary) { return false }
            if let origin, !fm.fileExists(atPath: origin + "/" + binary) { return false }
            if !markers.allSatisfy({ fm.fileExists(atPath: $0.path) }) { return false }
        }
        guard let text = try? String(contentsOf: guardianPid, encoding: .utf8), let pid = pid_t(text), pid > 0 else { return false }
        return kill(pid, 0) == 0
    }

    static func run(_ path: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardError = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        do { try p.run() } catch { logLine("could not run \(path): \(error)"); return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
    static func launchctl(_ args: [String]) -> Int32 { run("/bin/launchctl", args) }
    static func copyApp(from: String, to: String) -> Bool {
        let code = run("/usr/bin/ditto", [from, to])
        logLine("copied app \(from) to \(to), code \(code)")
        return code == 0
    }

    /// Same answer with the agent dead, so killing it first doesn't open the way out.
    static func lockedOnFile() -> Bool {
        let cfg = Vault.load("config").flatMap { try? Store.decode(Config.self, data: $0.data) } ?? Store.load(Config.self, Paths.config) ?? Config()
        let name = Paths.perUser("state", "x").replacingOccurrences(of: ".x", with: "")
        let state = Vault.load(name).flatMap { try? Store.decode(State.self, data: $0.data) } ?? Store.load(State.self, Paths.state) ?? State()
        let now = max(Clock.wall(), state.highWater), boot = Enforcer.bootId()
        return cfg.blocks.contains { b in
            b.enabled && (cfg.settings.passwordLocksAll || Engine.status(b, state.breaks[b.id], state.locks[b.id], bootId: boot, now).locked)
        }
    }

    /// Puts back whatever was removed. Called while locked by the agent, the guardian and the native host, so all three must go at once to stop it.
    static func heal() {
        Paths.ensure()
        let fm = FileManager.default
        if !Paths.isShared, let origin {
            let spareOK = fm.fileExists(atPath: spare + "/" + binary), originOK = fm.fileExists(atPath: origin + "/" + binary)
            if !originOK && spareOK { _ = copyApp(from: spare, to: origin) }
            if !spareOK && originOK { _ = copyApp(from: origin, to: spare) }
            for m in markers { writeIfChanged(Data(origin.utf8), m) }
        }
        writePlists()
        writeHostManifests()
        for (label, _) in jobs {
            _ = launchctl(["enable", "\(domain)/\(label)"])
            if launchctl(["print", "\(domain)/\(label)"]) != 0 {
                let code = launchctl(["bootstrap", domain, plist(label).path])
                logLine("restored job \(label), code \(code)")
            }
        }
    }

    /// Runs as its own launchd job. Only acts during a lock, so stopping an unlocked agent stays stopped.
    static func guardLoop() -> Never {
        logLine("guardian started pid=\(getpid())")
        var hung = 0
        while true {
            Thread.sleep(forTimeInterval: 2)
            writeIfChanged(Data("\(getpid())".utf8), guardianPid)
            if let c = SocketClient() {
                var limit = timeval(tv_sec: 3, tv_usec: 0)
                setsockopt(c.fd, SOL_SOCKET, SO_RCVTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
                if (try? c.call("ping")) != nil { hung = 0; continue }
                // A stopped agent still accepts connections, and launchd sees nothing wrong with it.
                hung += 1
                if hung >= 2, lockedOnFile() {
                    logLine("agent is not answering, restarting it")
                    _ = launchctl(["kill", "SIGKILL", "\(domain)/\(agentLabel)"])
                    hung = 0
                }
                continue
            }
            if lockedOnFile() { heal() }
        }
    }

    static func refusedWithTestHome() -> Bool {
        // Otherwise pointing DEADBOLT_HOME at an empty folder would pass the lock check, then remove the real jobs.
        guard Seams.get("DEADBOLT_HOME") != nil, Seams.get("DEADBOLT_LABEL") == nil else { return false }
        print("Refused: DEADBOLT_HOME without DEADBOLT_LABEL would touch the real agent.")
        return true
    }

    static func install() -> Bool {
        Paths.ensure()
        if lockedOnFile() { print("Install refused: a block is locked."); return false }
        if refusedWithTestHome() { return false }
        for (label, _) in jobs.reversed() { _ = launchctl(["bootout", "\(domain)/\(label)"]) }
        if appPath != spare {
            try? FileManager.default.removeItem(atPath: spare)
            guard copyApp(from: appPath, to: spare) else { print("Could not copy the app to \(spare)."); return false }
            for m in markers { writeIfChanged(Data(appPath.utf8), m) }
        }
        writeHostManifests()
        writePlists()
        var failed: Int32 = 0
        for (label, _) in jobs {
            let code = launchctl(["bootstrap", domain, plist(label).path])
            if code != 0 { failed = code }
        }
        print(failed == 0 ? "Agent and guardian installed and running." : "launchctl bootstrap failed with code \(failed).")
        print("Load the extension from \(spare)/Contents/Resources/extension in each browser (developer mode, Load unpacked), then allow it in incognito.")
        return failed == 0
    }

    /// Same layout Cold Turkey uses: a root-owned plist that launchd loads for everyone at login, with data in a folder all accounts can write.
    static func installAllUsers() -> Bool {
        let root = Paths.systemRoot
        guard !root.isEmpty || getuid() == 0 else { print("Run it with sudo: sudo \(exec) install --all-users"); return false }
        if Paths.isShared, lockedOnFile() { print("Install refused: a block is locked."); return false }
        let fm = FileManager.default
        let app = root + "/Applications/Deadbolt.app"
        if appPath != app {
            try? fm.removeItem(atPath: app)
            guard copyApp(from: appPath, to: app) else { print("Could not copy the app to \(app)."); return false }
        }
        let shared = Paths.sharedHome, backup = root + "/Users/Shared/.deadbolt-backup"
        for d in [shared.path, backup] {
            try? fm.createDirectory(atPath: d, withIntermediateDirectories: true)
            chmod(d, 0o777)
        }
        fm.createFile(atPath: shared.appendingPathComponent(".allusers").path, contents: Data())
        for (label, arg) in jobs {
            let url = URL(fileURLWithPath: root + "/Library/LaunchAgents/\(label).plist")
            writeIfChanged(plistData(label: label, arg: arg, exec: app + "/" + binary, errorLog: "/dev/null"), url)
            chmod(url.path, 0o644)
            if getuid() == 0 { chown(url.path, 0, 0) }
        }
        print("Installed for all users. Each person's agent starts at their next login.")
        return true
    }

    static func uninstall() -> Bool {
        let client = SocketClient()
        let locked: Bool
        if let can = (try? client?.call("canUninstall")) as? Bool { locked = !can } else { locked = lockedOnFile() }
        if locked { print("Uninstall refused: a block is locked."); return false }
        if refusedWithTestHome() { return false }
        if Paths.isShared, Paths.systemRoot.isEmpty, getuid() != 0 { print("Run it with sudo: this Mac has an all-users install."); return false }
        _ = try? client?.call("clearRules")
        for (label, _) in jobs.reversed() {
            _ = launchctl(["bootout", "\(domain)/\(label)"])
            try? FileManager.default.removeItem(at: plist(label))
        }
        let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        for spec in Browsers.supported where !skipHosts {
            if let dir = spec.nmhDir { try? FileManager.default.removeItem(at: support.appendingPathComponent(dir).appendingPathComponent("\(hostName).json")) }
        }
        for m in markers { try? FileManager.default.removeItem(at: m) }
        try? FileManager.default.removeItem(atPath: spare)
        print("Agent and guardian removed. Config kept at \(Paths.home.path).")
        return true
    }

    static func localUsers() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: "/Users")) ?? []
        return names.filter { !$0.hasPrefix(".") && $0 != "Shared" && $0 != "Guest" }.sorted()
    }

    static func openUI() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: Bundle.main.executablePath ?? CommandLine.arguments[0])
        p.arguments = ["ui"]
        try? p.run()
    }
}
