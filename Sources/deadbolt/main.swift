import AppKit

setvbuf(stdout, nil, _IOLBF, 0)
let arguments = Array(CommandLine.arguments.dropFirst())

func printJSON(_ v: Any) {
    if JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v, options: [.prettyPrinted, .sortedKeys]) {
        print(String(data: d, encoding: .utf8)!)
    } else {
        print(v)
    }
}

func cli(_ cmd: String, _ args: [String: Any]) {
    guard let c = SocketClient() else {
        print("The Deadbolt agent isn't running.")
        exit(2)
    }
    do { printJSON(try c.call(cmd, args)) }
    catch { print("Error: \(error)"); exit(1) }
}

/// CLI block lookup is by name, because that's what a person or script knows.
func blockId(named name: String) -> String {
    guard let c = SocketClient(), let cfg = try? c.call("config") as? [String: Any],
          let blocks = cfg["blocks"] as? [[String: Any]],
          let hit = blocks.first(where: { $0["name"] as? String == name }), let id = hit["id"] as? String else {
        print("No block named \(name).")
        exit(1)
    }
    return id
}

func editBlock(named name: String, _ change: (inout Block) -> Void) {
    guard let c = SocketClient(), let cfg = try? c.call("config") as? [String: Any],
          let blocks = cfg["blocks"] as? [[String: Any]],
          let hit = blocks.first(where: { $0["name"] as? String == name }),
          var block = try? API.decode(Block.self, hit) else {
        print("No block named \(name).")
        exit(1)
    }
    change(&block)
    let encoded = (try? API.encode(block)) ?? [:]
    cli("saveBlock", ["block": encoded])
}

let usage = """
deadbolt status
deadbolt start <block> [--timer minutes | --random length | --password value]
deadbolt stop <block> [--password value]
deadbolt toggle <block>
deadbolt add <block> <website> [--exception]
deadbolt install [--all-users] | uninstall
deadbolt selftest
"""

func option(_ name: String) -> String? {
    guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
    return arguments[i + 1]
}

switch arguments.first ?? "ui" {
case "agent":
    Agent().start()
case "guard":
    Installer.guardLoop()
case "home":
    print(Paths.home.path)
case "nmh":
    NativeHost.run()
case "ui":
    UIMain.run(smoke: arguments.contains("--smoke"))
case "selftest":
    selftest()
case "probe-model":
    // Runs the exact production model call. scripts/live_adult.js uses it to prove tools stay unavailable.
    Paths.ensure()
    let probe = AdultFilter.ask(prompt: CommandLine.arguments.dropFirst(2).joined(separator: " "))
    print("label=\(probe.label?.rawValue ?? "none") error=\(probe.error ?? "none")")
case "install":
    exit((arguments.contains("--all-users") ? Installer.installAllUsers() : Installer.install()) ? 0 : 1)
case "uninstall":
    exit(Installer.uninstall() ? 0 : 1)
case "status":
    cli("status", [:])
case "rpc" where arguments.count >= 2:
    let raw = arguments.count > 2 ? Data(arguments[2].utf8) : Data("{}".utf8)
    cli(arguments[1], (try? JSONSerialization.jsonObject(with: raw) as? [String: Any]) ?? [:])
case "start" where arguments.count >= 2:
    let id = blockId(named: arguments[1])
    if let t = option("--timer").flatMap(Double.init) {
        let until = Date().timeIntervalSince1970 + t * 60
        cli("lock", ["id": id, "lock": (try? API.encode(LockCfg(kind: .timer, until: until, autoDisable: true))) ?? [:]])
    } else if let r = option("--random").flatMap(Int.init) {
        var l = LockCfg(kind: .randomText)
        l.textLength = r
        cli("lock", ["id": id, "lock": (try? API.encode(l)) ?? [:]])
    } else if let p = option("--password") {
        cli("lock", ["id": id, "lock": (try? API.encode(LockCfg(kind: .password))) ?? [:], "newPassword": p])
    } else {
        cli("setEnabled", ["id": id, "enabled": true])
    }
case "stop" where arguments.count >= 2:
    let id = blockId(named: arguments[1])
    if let p = option("--password") {
        guard let c = SocketClient() else { exit(2) }
        _ = try? c.call("unlock", ["id": id, "password": p])
    }
    cli("setEnabled", ["id": id, "enabled": false])
case "toggle" where arguments.count >= 2:
    editBlock(named: arguments[1]) { $0.enabled.toggle() }
case "add" where arguments.count >= 3:
    let exception = arguments.contains("--exception")
    editBlock(named: arguments[1]) { b in
        if exception { b.exceptions.append(arguments[2]) } else { b.websites.append(arguments[2]) }
    }
default:
    print(usage)
    exit(arguments.isEmpty ? 0 : 1)
}
