import CryptoKit
import Foundation
import SQLite3

/// Test settings. Under the production launchd job they do nothing: launchd sets XPC_SERVICE_NAME itself, while `launchctl setenv` could otherwise point the agent at an empty home.
enum Seams {
    static let env = ProcessInfo.processInfo.environment
    static let production = ["com.deadbolt.agent", "com.deadbolt.guardian"].contains(env["XPC_SERVICE_NAME"] ?? "")
    static func get(_ key: String) -> String? { production ? nil : env[key] }
}

enum Clock {
    static let offset = Seams.get("DEADBOLT_TEST_WALL_OFFSET").flatMap(Double.init) ?? 0
    static func wall() -> Double { Date().timeIntervalSince1970 + offset }
}

enum Paths {
    static let systemRoot = Seams.get("DEADBOLT_SYSTEM_ROOT") ?? ""
    static let sharedHome = URL(fileURLWithPath: systemRoot + "/Users/Shared/Deadbolt")
    static let user = Seams.get("DEADBOLT_TEST_USER") ?? NSUserName()
    /// The all-users switch is a root-owned plist, not a file in /Users/Shared, where anyone could create or delete it and move the agent to an empty folder.
    static var allUsersInstalled: Bool {
        var st = stat()
        return stat(systemRoot + "/Library/LaunchAgents/com.deadbolt.agent.plist", &st) == 0 && (st.st_uid == 0 || !systemRoot.isEmpty)
    }
    static let home: URL = {
        if let h = Seams.get("DEADBOLT_HOME") { return URL(fileURLWithPath: h) }
        if allUsersInstalled { return sharedHome }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Deadbolt")
    }()
    /// An all-users install shares config. Break state, stats, log and socket stay per person.
    static let isShared = home.path == sharedHome.path || FileManager.default.fileExists(atPath: home.appendingPathComponent(".allusers").path)
    static func perUser(_ stem: String, _ ext: String) -> String { isShared ? "\(stem)-\(user).\(ext)" : "\(stem).\(ext)" }
    /// Second copy of the signed vault, outside the folder a person would think to delete.
    static let backup: URL = {
        if let h = Seams.get("DEADBOLT_HOME") { return URL(fileURLWithPath: h + "-backup") }
        if isShared { return URL(fileURLWithPath: systemRoot + "/Users/Shared/.deadbolt-backup") }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Preferences/.com.deadbolt")
    }()
    static var config: URL { home.appendingPathComponent("config.json") }
    static var state: URL { home.appendingPathComponent(perUser("state", "json")) }
    static var stats: URL { home.appendingPathComponent(perUser("stats", "sqlite")) }
    static var log: URL { home.appendingPathComponent(perUser("agent", "log")) }
    /// sun_path holds 104 bytes, so long homes fall back to a hashed name in the temp dir.
    static var socket: String {
        let direct = home.appendingPathComponent(perUser("agent", "sock")).path
        if direct.utf8.count < 100 { return direct }
        let digest = SHA256.hash(data: Data(direct.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return NSTemporaryDirectory() + "deadbolt-\(digest).sock"
    }
    static func ensure() {
        for d in [home, backup] { try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
    }
}

func logLine(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    if let h = try? FileHandle(forWritingTo: Paths.log) {
        h.seekToEndOfFile()
        h.write(Data(line.utf8))
        try? h.close()
    } else {
        try? Data(line.utf8).write(to: Paths.log)
    }
}

protocol Defaulted: Codable { init() }
extension Config: Defaulted {}
extension State: Defaulted {}
extension Block: Defaulted {}
extension LockCfg: Defaulted {}
extension Settings: Defaulted {}

enum Store {
    private static func json<T: Encodable>(_ v: T) -> Any { (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(v))) ?? [:] }
    private static let arrayItems: [String: Any] = ["blocks": json(Block()), "slots": json(Slot(weekday: 0, start: 0, end: 0)), "apps": json(AppEntry(path: ""))]
    private static let mapValues: [String: Any] = ["breaks": json(BreakRuntime()), "locks": json(LockRuntime()), "missing": json(MissingBrowser())]

    /// Fills fields a stored document lacks, so adding a field can never drop blocks and locks on upgrade.
    static func merge(defaults: Any, stored: Any, key: String? = nil) -> Any {
        if let key, let item = arrayItems[key], let list = stored as? [Any] { return list.map { merge(defaults: item, stored: $0) } }
        if let key, let item = mapValues[key], let map = stored as? [String: Any] { return map.mapValues { merge(defaults: item, stored: $0) } }
        guard let d = defaults as? [String: Any], let s = stored as? [String: Any] else { return stored }
        var out = d
        for (k, v) in s { out[k] = d[k].map { merge(defaults: $0, stored: v, key: k) } ?? merge(defaults: v, stored: v, key: k) }
        return out
    }

    static func decode<T: Defaulted>(_ type: T.Type, object: Any) throws -> T {
        let full = merge(defaults: json(T()), stored: object)
        return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: full))
    }

    static func decode<T: Defaulted>(_ type: T.Type, data: Data) throws -> T {
        try decode(type, object: JSONSerialization.jsonObject(with: data))
    }

    static func load<T: Defaulted>(_ type: T.Type, _ url: URL) -> T? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        do { return try decode(type, data: d) }
        catch { logLine("load failed \(url.lastPathComponent): \(error)"); return nil }
    }

    /// Sorted keys, so unchanged values give unchanged bytes and tampering can be seen by comparing them.
    static func encode<T: Encodable>(_ value: T) -> Data {
        let e = JSONEncoder()
        e.outputFormatting = .sortedKeys
        return (try? e.encode(value)) ?? Data()
    }

    static func write(_ data: Data, _ url: URL) {
        do { try data.write(to: url, options: .atomic) }
        catch { logLine("save failed \(url.lastPathComponent): \(error)") }
    }
}

/// Signed copies of config and state in two folders. The plain JSON files are only a readable mirror once a vault exists.
/// ponytail: the key sits beside the data, so this stops edits and deletions, not someone who reads this code and forges a MAC. Root-owned storage is the upgrade path.
enum Vault {
    struct File: Codable { var rev: Int; var data: Data; var mac: String }

    private static func keyData() -> SymmetricKey {
        let names = [Paths.home, Paths.backup].map { $0.appendingPathComponent(".key") }
        let found = names.compactMap { try? Data(contentsOf: $0) }.first { $0.count == 32 }
        let key = found ?? Data(SymmetricKey(size: .bits256).withUnsafeBytes { Array($0) })
        for n in names where (try? Data(contentsOf: n)) != key { Store.write(key, n) }
        return SymmetricKey(data: key)
    }

    private static func mac(_ rev: Int, _ data: Data) -> String {
        HMAC<SHA256>.authenticationCode(for: Data("\(rev):".utf8) + data, using: keyData()).map { String(format: "%02x", $0) }.joined()
    }

    static func urls(_ name: String) -> [URL] { [Paths.home, Paths.backup].map { $0.appendingPathComponent("vault-\(name).json") } }

    static func save(_ name: String, _ data: Data, rev: Int) {
        guard let file = try? JSONEncoder().encode(File(rev: rev, data: data, mac: mac(rev, data))) else { return }
        for u in urls(name) { Store.write(file, u) }
    }

    /// The highest valid revision wins, so restoring an old copy can't undo a newer lock.
    static func load(_ name: String) -> File? {
        let files = urls(name).compactMap { u -> File? in
            guard let d = try? Data(contentsOf: u) else { return nil }
            guard let f = try? JSONDecoder().decode(File.self, from: d), f.mac == mac(f.rev, f.data) else {
                logLine("vault rejected \(u.path)")
                return nil
            }
            return f
        }
        return files.max { $0.rev < $1.rev }
    }
}

/// Daily totals, one row per day and item.
final class Stats {
    private var db: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(path: URL) {
        guard sqlite3_open(path.path, &db) == SQLITE_OK else { logLine("stats open failed"); return }
        exec("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS usage(day TEXT, kind TEXT, item TEXT, seconds REAL, PRIMARY KEY(day, kind, item));
        CREATE TABLE IF NOT EXISTS blocked(day TEXT, item TEXT, count INTEGER, PRIMARY KEY(day, item));
        CREATE TABLE IF NOT EXISTS active(day TEXT PRIMARY KEY, seconds REAL);
        """)
    }

    private func exec(_ sql: String) { sqlite3_exec(db, sql, nil, nil, nil) }

    private func run(_ sql: String, _ binds: [Any], row: ((OpaquePointer) -> Void)? = nil) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { logLine("stats sql failed: \(sql)"); return }
        defer { sqlite3_finalize(stmt) }
        for (i, b) in binds.enumerated() {
            if let s = b as? String { sqlite3_bind_text(stmt, Int32(i + 1), s, -1, transient) }
            else if let d = b as? Double { sqlite3_bind_double(stmt, Int32(i + 1), d) }
        }
        while sqlite3_step(stmt) == SQLITE_ROW { row?(stmt!) }
    }

    static func day(_ now: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date(timeIntervalSince1970: now))
    }

    /// Seconds pile up in memory and reach the disk once a minute, or when someone reads them. A killed agent loses at most a minute of statistics, never a limit.
    private var pendingUsage: [[String]: Double] = [:]
    private var pendingActive: [String: Double] = [:]
    private var flushedAt = 0.0

    func addUsage(kind: String, item: String, seconds: Double, now: Double) {
        pendingUsage[[Stats.day(now), kind, item], default: 0] += seconds
        flushIfDue(now)
    }

    func flushIfDue(_ now: Double) {
        if now - flushedAt >= 60 { flush(); flushedAt = now }
    }

    func flush() {
        guard !pendingUsage.isEmpty || !pendingActive.isEmpty else { return }
        exec("BEGIN")
        for (k, v) in pendingUsage { writeUsage(day: k[0], kind: k[1], item: k[2], seconds: v) }
        for (day, v) in pendingActive {
            run("INSERT INTO active VALUES(?,?) ON CONFLICT(day) DO UPDATE SET seconds=seconds+excluded.seconds", [day, v])
        }
        exec("COMMIT")
        pendingUsage = [:]
        pendingActive = [:]
    }

    private func writeUsage(day: String, kind: String, item: String, seconds: Double) {
        run("INSERT INTO usage VALUES(?,?,?,?) ON CONFLICT(day,kind,item) DO UPDATE SET seconds=seconds+excluded.seconds",
            [day, kind, item, seconds])
    }

    func addBlocked(item: String, now: Double) {
        run("INSERT INTO blocked VALUES(?,?,1) ON CONFLICT(day,item) DO UPDATE SET count=count+1", [Stats.day(now), item])
    }

    func addActive(seconds: Double, now: Double) {
        pendingActive[Stats.day(now), default: 0] += seconds
        flushIfDue(now)
    }

    func query(from: String, to: String) -> [String: Any] {
        flush()
        var usage: [[String: Any]] = [], blocked: [[String: Any]] = [], active: [[String: Any]] = []
        func text(_ s: OpaquePointer, _ i: Int32) -> String { String(cString: sqlite3_column_text(s, i)) }
        run("SELECT kind,item,SUM(seconds),day FROM usage WHERE day>=? AND day<=? GROUP BY kind,item,day", [from, to]) {
            usage.append(["kind": text($0, 0), "item": text($0, 1), "seconds": sqlite3_column_double($0, 2), "day": text($0, 3)])
        }
        run("SELECT item,SUM(count),day FROM blocked WHERE day>=? AND day<=? GROUP BY item,day", [from, to]) {
            blocked.append(["item": text($0, 0), "count": sqlite3_column_int($0, 1), "day": text($0, 2)])
        }
        run("SELECT day,seconds FROM active WHERE day>=? AND day<=?", [from, to]) {
            active.append(["day": text($0, 0), "seconds": sqlite3_column_double($0, 1)])
        }
        return ["usage": usage, "blocked": blocked, "active": active]
    }

    func deleteAll() {
        pendingUsage = [:]
        pendingActive = [:]
        exec("DELETE FROM usage; DELETE FROM blocked; DELETE FROM active;")
    }
}
