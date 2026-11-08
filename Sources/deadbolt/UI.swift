import AppKit
import UniformTypeIdentifiers
import WebKit

/// Thin shell: the page calls the agent through this bridge, and only native pickers live here.
final class UIShell: NSObject, NSApplicationDelegate, WKScriptMessageHandlerWithReply, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let client = SocketClient()
    let smoke: Bool

    init(smoke: Bool) { self.smoke = smoke }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "api")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Deadbolt"
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let index = uiDir().appendingPathComponent("index.html")
        web.loadFileURL(index, allowingReadAccessTo: uiDir())
        if smoke {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.runSmoke() }
        }
    }

    func uiDir() -> URL {
        if let r = Bundle.main.resourceURL?.appendingPathComponent("ui"), FileManager.default.fileExists(atPath: r.path) { return r }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("ui")
    }

    /// Proves the real WebKit bridge reaches the agent: prints what the live page got back.
    func runSmoke() {
        web.callAsyncJavaScript("const s = await api('ping'); return JSON.stringify({ok: !!s.pid, title: document.title, tabs: document.querySelectorAll('[data-tab]').length});",
                                arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let v): print("ui-smoke", v as? String ?? "nil")
            case .failure(let e): print("ui-smoke-failed", e)
            }
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { replyHandler(nil, "bad request"); return }
        let args = body["args"] as? [String: Any] ?? [:]
        if cmd == "pickApps" { pickApps(args, replyHandler); return }
        do {
            guard let client else { throw DeadboltError.rejected("The Deadbolt agent isn't running.") }
            replyHandler(try client.call(cmd, args), nil)
        } catch {
            replyHandler(nil, "\(error)")
        }
    }

    func pickApps(_ args: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let mode = args["mode"] as? String ?? "app"
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = mode != "folder"
        panel.canChooseDirectories = mode == "folder"
        panel.canChooseFiles = mode != "folder"
        if mode == "app" {
            panel.allowedContentTypes = [.application]
            panel.directoryURL = URL(fileURLWithPath: "/Applications")
        }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK else { reply([], nil); return }
            reply(panel.urls.map { url -> [String: Any] in
                var e: [String: Any] = ["path": url.path, "isFolder": mode == "folder", "isBinary": mode == "binary"]
                if mode == "app", let id = Bundle(url: url)?.bundleIdentifier { e["bundleId"] = id }
                return e
            }, nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}

enum UIMain {
    static func run(smoke: Bool) {
        let app = NSApplication.shared
        let shell = UIShell(smoke: smoke)
        app.delegate = shell
        app.run()
    }
}
