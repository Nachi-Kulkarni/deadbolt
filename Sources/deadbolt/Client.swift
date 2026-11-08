import Foundation

/// Line-oriented connection to the agent's Unix socket. Shared by CLI, UI and native host.
final class SocketClient {
    let fd: Int32
    private var buffer = Data()

    init?() {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = Paths.socket.withCString { strncpy(&addr.sun_path.0, $0, 103) }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) } }
        if ok != 0 { close(fd); return nil }
    }

    deinit { close(fd) }

    func send(_ data: Data) -> Bool {
        var out = data
        out.append(10)
        return out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) } == out.count
    }

    func readLine() -> Data? {
        while true {
            if let nl = buffer.firstIndex(of: 10) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                return line
            }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buffer.append(chunk, count: n)
        }
    }

    func call(_ cmd: String, _ args: [String: Any] = [:]) throws -> Any {
        let req = try JSONSerialization.data(withJSONObject: ["id": 1, "cmd": cmd, "args": args])
        guard send(req), let line = readLine(),
              let res = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            throw DeadboltError.rejected("Agent connection lost.")
        }
        if res["ok"] as? Bool == true { return res["result"] ?? NSNull() }
        throw DeadboltError.rejected(res["error"] as? String ?? "Agent error.")
    }
}

/// Browser side of native messaging: 4-byte length frames on stdio, lines to the agent.
enum NativeHost {
    static func run() {
        var parentPath = [CChar](repeating: 0, count: 4096)
        proc_pidpath(getppid(), &parentPath, 4096)
        let bundle = appBundle(of: String(cString: parentPath))
        let lock = NSLock()
        var agent: SocketClient?

        func writeFrame(_ data: Data) {
            lock.lock(); defer { lock.unlock() }
            var len = UInt32(data.count).littleEndian
            FileHandle.standardOutput.write(Data(bytes: &len, count: 4))
            FileHandle.standardOutput.write(data)
        }

        Thread.detachNewThread {
            var misses = 0
            while true {
                guard let c = SocketClient() else {
                    writeFrame(Data(#"{"type":"agent-offline"}"#.utf8))
                    // Third way back after the agent and guardian, so opening a browser undoes both being removed.
                    misses += 1
                    if misses % 3 == 0, Installer.managed, Installer.lockedOnFile() { Installer.heal() }
                    Thread.sleep(forTimeInterval: 2)
                    continue
                }
                let hello = try! JSONSerialization.data(withJSONObject: ["type": "hello", "browserPath": bundle, "pid": Int(getppid())])
                _ = c.send(hello)
                misses = 0
                lock.lock(); agent = c; lock.unlock()
                writeFrame(Data(#"{"type":"agent-online"}"#.utf8))
                while let line = c.readLine() { writeFrame(line) }
                lock.lock(); agent = nil; lock.unlock()
            }
        }

        let input = FileHandle.standardInput
        while true {
            let head = input.readData(ofLength: 4)
            guard head.count == 4 else { exit(0) }
            let len = head.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
            guard len < 8 * 1024 * 1024 else { exit(1) }
            let body = input.readData(ofLength: len)
            guard body.count == len else { exit(0) }
            lock.lock(); let c = agent; lock.unlock()
            _ = c?.send(body)
        }
    }

    static func appBundle(of exec: String) -> String {
        guard let r = exec.range(of: ".app/") else { return exec }
        return String(exec[..<r.lowerBound]) + ".app"
    }
}
