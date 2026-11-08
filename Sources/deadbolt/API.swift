import ApplicationServices
import Foundation

/// Every mutation enters here, so lock rules can't be skipped by the UI, CLI or extension.
enum API {
    static func decode<T: Defaulted>(_ t: T.Type, _ v: Any?) throws -> T {
        guard let v else { throw DeadboltError.rejected("missing argument") }
        return try Store.decode(t, object: v)
    }

    static func encode<T: Encodable>(_ v: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(v))
    }

    /// Reply shape strips secrets: lock text and hashes never leave except while a text lock is shown.
    static func publicBlock(_ b: Block) throws -> Any {
        var c = b
        c.lock.passwordHash = ""
        c.lock.passwordSalt = ""
        return try encode(c)
    }

    static func publicConfig(_ a: Agent) throws -> [String: Any] {
        var s = a.cfg.settings
        let hasPassword = !s.passwordHash.isEmpty
        s.passwordHash = ""
        s.passwordSalt = ""
        return ["blocks": try a.cfg.blocks.map(publicBlock), "settings": try encode(s), "hasPassword": hasPassword]
    }

    static func checkSettingsPassword(_ a: Agent, _ args: [String: Any]) throws {
        let s = a.cfg.settings
        guard !s.passwordHash.isEmpty else { return }
        let given = args["password"] as? String ?? ""
        guard Engine.hashPassword(given, salt: s.passwordSalt) == s.passwordHash else {
            throw DeadboltError.rejected("password required")
        }
    }

    static func index(_ a: Agent, _ args: [String: Any]) throws -> Int {
        guard let id = args["id"] as? String, let i = a.cfg.blocks.firstIndex(where: { $0.id == id }) else {
            throw DeadboltError.rejected("Unknown block.")
        }
        return i
    }

    static func handle(_ a: Agent, _ cmd: String, _ args: [String: Any]) throws -> Any {
        defer { a.persist() }
        switch cmd {
        case "ping": return ["pid": Int(getpid()), "now": a.nowValue]
        case "status": return try statusPayload(a)
        case "config": return try publicConfig(a)
        case "blockStatus":
            var statuses = try a.cfg.blocks.filter(\.enabled).map { b -> Any in
                try encode(a.status(b))
            }
            if a.cfg.settings.autoBlockAdult {
                statuses.append(try encode(BlockStatus(id: AdultFilter.blockId, name: "Adult site filter", kind: .content, enabled: true, armed: true, blocking: true, locked: false, reason: "Deadbolt classified this site as adult content.", breakKind: .none, lockKind: .none)))
            }
            return statuses
        case "saveBlock": return try saveBlock(a, args)
        case "deleteBlock":
            if a.cfg.settings.passwordRestrictEdit { try checkSettingsPassword(a, args) }
            let i = try index(a, args)
            guard !a.status(a.cfg.blocks[i]).locked else { throw DeadboltError.rejected("This block can't be deleted because it's currently locked.") }
            guard !(a.cfg.blocks[i].autostart.lockSettings && !a.cfg.blocks[i].enabled) else { throw DeadboltError.rejected("The autostart settings are locked until the block starts.") }
            a.state.breaks[a.cfg.blocks[i].id] = nil
            a.state.locks[a.cfg.blocks[i].id] = nil
            a.cfg.blocks.remove(at: i)
            return true
        case "deleteDisabled":
            a.cfg.blocks.removeAll { !$0.enabled && $0.autostart.kind == .none && !a.status($0).locked && (args["kind"] as? String ?? $0.kind.rawValue) == $0.kind.rawValue }
            return true
        case "setEnabled":
            let i = try index(a, args)
            let on = args["enabled"] as? Bool ?? false
            if a.cfg.settings.passwordRestrictStart { try checkSettingsPassword(a, args) }
            if a.cfg.blocks[i].autostart.lockSettings, !a.cfg.blocks[i].enabled {
                throw DeadboltError.rejected("The autostart settings are locked until the block starts.")
            }
            if !on {
                guard !a.status(a.cfg.blocks[i]).locked else { throw DeadboltError.rejected("This block is locked. It can't be disabled.") }
                a.cfg.blocks[i].enabled = false
            } else if !a.cfg.blocks[i].enabled {
                a.enable(i)
            }
            return true
        case "lock": return try lock(a, args)
        case "startUnlock":
            let i = try index(a, args)
            guard a.cfg.blocks[i].lock.kind == .delay else { throw DeadboltError.rejected("This lock has no delay.") }
            a.state.locks[a.cfg.blocks[i].id] = LockRuntime(unlockAt: a.nowValue + Double(a.cfg.blocks[i].lock.delaySeconds))
            return true
        case "cancelUnlock":
            let i = try index(a, args)
            a.state.locks[a.cfg.blocks[i].id] = nil
            return true
        case "unlock": return try unlock(a, args)
        case "startBreak": return try startBreak(a, args)
        case "cancelBreak":
            let i = try index(a, args)
            var r = a.state.breaks[a.cfg.blocks[i].id] ?? BreakRuntime()
            r.delayUntil = nil
            r.breakUntil = nil
            a.state.breaks[a.cfg.blocks[i].id] = r
            return true
        case "resetPomodoro":
            let i = try index(a, args)
            guard !a.status(a.cfg.blocks[i]).locked else { throw DeadboltError.rejected("This block is locked.") }
            var r = a.state.breaks[a.cfg.blocks[i].id] ?? BreakRuntime()
            r.pomodoroAnchor = a.nowValue
            a.state.breaks[a.cfg.blocks[i].id] = r
            return true
        case "saveSettings": return try saveSettings(a, args)
        case "adultSites":
            let held = a.state.sites.filter { $0.value.label != .clean }.sorted { $0.key < $1.key }.map { ["host": $0.key, "label": $0.value.label.rawValue, "source": $0.value.source] }
            return ["sites": held, "cleanCount": a.state.sites.filter { $0.value.label == .clean }.count, "modelCalls": a.state.modelCalls, "dailyLimit": AdultFilter.dailyModelCalls, "lastError": a.lastModelError as Any? ?? NSNull()] as [String: Any]
        case "adultAllow":
            try checkSettingsPassword(a, args)
            guard !a.anyLocked else { throw DeadboltError.rejected("You can't allow a site during a locked block.") }
            let host = AdultFilter.normalized(args["host"] as? String ?? "")
            guard !host.isEmpty else { throw DeadboltError.rejected("Enter a site.") }
            a.setVerdict(host, .allowed, "user")
            return true
        case "adultForget":
            try checkSettingsPassword(a, args)
            let host = AdultFilter.normalized(args["host"] as? String ?? "")
            guard a.state.sites[host]?.label == .allowed || !a.anyLocked else { throw DeadboltError.rejected("You can't recheck a site during a locked block.") }
            a.state.sites[host] = nil
            a.retryAt[host] = nil
            a.pushRules()
            return true
        case "setPassword":
            try checkSettingsPassword(a, args)
            let new = args["newPassword"] as? String ?? ""
            guard !new.contains("\\") else { throw DeadboltError.rejected("Your password contains an invalid character. Please remove this character: \\") }
            if new.isEmpty {
                guard !a.anyLocked else { throw DeadboltError.rejected("You can't clear the password during a locked block.") }
                a.cfg.settings.passwordHash = ""
                a.cfg.settings.passwordSalt = ""
            } else {
                let salt = Engine.newSalt()
                a.cfg.settings.passwordSalt = salt
                a.cfg.settings.passwordHash = Engine.hashPassword(new, salt: salt)
            }
            return true
        case "verifyPassword":
            try checkSettingsPassword(a, args)
            return true
        case "stats":
            guard let from = args["from"] as? String, let to = args["to"] as? String else { throw DeadboltError.rejected("Missing range.") }
            return a.stats.query(from: from, to: to)
        case "exportStats":
            guard let from = args["from"] as? String, let to = args["to"] as? String else { throw DeadboltError.rejected("Missing range.") }
            return try exportStats(a, from: from, to: to)
        case "deleteStats":
            guard !a.anyLockedUsageBreak else { throw DeadboltError.rejected("You can't delete your statistics while a locked block has an allowance, reward or session break.") }
            a.stats.deleteAll()
            return true
        case "exportBlocks": return try exportBlocks(a, args)
        case "importBlocks": return try importBlocks(a, args)
        case "browsers": return browsers(a)
        case "localUsers": return Installer.localUsers()
        case "clearRules":
            guard !a.anyLocked else { throw DeadboltError.rejected("A block is locked.") }
            a.clearBrowsers()
            return true
        case "canUninstall": return !a.anyLocked
        case "requestAccessibility":
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            return AXIsProcessTrustedWithOptions(opts)
        default: throw DeadboltError.rejected("Unknown command \(cmd).")
        }
    }

    static func statusPayload(_ a: Agent) throws -> [String: Any] {
        [
            "now": a.nowValue,
            "tampered": a.clock.tampered,
            "zoneChanged": a.zoneChanged,
            "blocks": try a.cfg.blocks.map { try encode(a.status($0)) },
            "accessibility": Enforcer.hasAccessibility,
            "browsers": browsers(a),
        ]
    }

    static func browsers(_ a: Agent) -> [[String: Any]] {
        let conns = a.clients.values.compactMap(\.browser)
        return Browsers.supported.compactMap { spec -> [String: Any]? in
            guard let url = Installer.browserAppURL(spec.bundleId) else { return nil }
            let c = conns.first { $0.browserPath == url.path }
            return ["name": spec.name, "bundleId": spec.bundleId, "connected": c != nil, "incognitoAllowed": c?.incognitoAllowed ?? false, "supported": true]
        } + Browsers.unsupported.compactMap { id, name -> [String: Any]? in
            Installer.browserAppURL(id) == nil ? nil : ["name": name, "bundleId": id, "connected": false, "incognitoAllowed": false, "supported": false]
        }
    }

    static func saveBlock(_ a: Agent, _ args: [String: Any]) throws -> Any {
        var new: Block = try decode(Block.self, args["block"])
        new.name = new.name.trimmingCharacters(in: .whitespaces)
        guard !new.name.isEmpty, !new.name.contains("\\") else { throw DeadboltError.rejected("This block name is blank or contains an invalid character.") }
        if a.cfg.blocks.contains(where: { $0.name == new.name && $0.id != new.id }) { throw DeadboltError.rejected("This block name can't be used because it's already in use.") }
        try Engine.validateSchedule(new)
        try Engine.validateBreakBounds(new.brk)
        for s in new.slots { try Engine.validateBreakBounds(s.brk) }
        if a.cfg.settings.passwordRestrictEdit { try checkSettingsPassword(a, args) }
        if let i = a.cfg.blocks.firstIndex(where: { $0.id == new.id }) {
            let old = a.cfg.blocks[i]
            if old.autostart.lockSettings, old.autostart.kind != .none, !old.enabled, new != old {
                throw DeadboltError.rejected("The autostart settings are locked until the block starts.")
            }
            new.lock.passwordHash = old.lock.passwordHash
            new.lock.passwordSalt = old.lock.passwordSalt
            if a.status(old).locked { try Engine.validateLockedEdit(old: old, new: new) }
            new.enabledAt = old.enabledAt
            new.autostart.firedKey = old.autostart.firedKey
            if new.enabled && !old.enabled { new.enabledAt = a.nowValue }
            a.cfg.blocks[i] = new
        } else {
            if new.enabled { new.enabledAt = a.nowValue }
            a.cfg.blocks.append(new)
        }
        return true
    }

    static func lock(_ a: Agent, _ args: [String: Any]) throws -> Any {
        let i = try index(a, args)
        var cfg: LockCfg = try decode(LockCfg.self, args["lock"])
        let b = a.cfg.blocks[i]
        let isExtension = b.lock.kind == .timer && cfg.kind == .timer && (cfg.until ?? 0) >= (b.lock.until ?? 0)
        guard !a.status(b).locked || isExtension else { throw DeadboltError.rejected("This block is already locked.") }
        switch cfg.kind {
        case .none: break
        case .timer:
            guard (cfg.until ?? 0) >= a.nowValue + 120 else { throw DeadboltError.rejected("The end time needs to be at least 2 minutes from now.") }
        case .randomText:
            guard (1...5000).contains(cfg.textLength) else { throw DeadboltError.rejected("The random text needs to be between 1 and 5000 characters long.") }
            cfg.text = Engine.randomText(cfg.textKind, length: cfg.textLength, custom: cfg.text)
            guard !cfg.text.isEmpty else { throw DeadboltError.rejected("Your custom text can't be blank.") }
        case .delay:
            guard cfg.delaySeconds >= 60, cfg.delaySeconds <= 40 * 86400 else { throw DeadboltError.rejected("The delay needs to be between 1 minute and 40 days.") }
        case .password:
            let pw = args["newPassword"] as? String ?? ""
            guard !pw.isEmpty else { throw DeadboltError.rejected("Your password can't be blank.") }
            cfg.passwordSalt = Engine.newSalt()
            cfg.passwordHash = Engine.hashPassword(pw, salt: cfg.passwordSalt)
        case .timeRange:
            guard cfg.rangeStart != cfg.rangeEnd, !cfg.rangeDays.isEmpty else { throw DeadboltError.rejected("The time range has no period where the block is locked or unlocked.") }
        case .schedule:
            guard b.scheduled else { throw DeadboltError.rejected("Schedule locks need a scheduled block.") }
        case .restart:
            guard !b.scheduled else { throw DeadboltError.rejected("Restart locks need a continuous block.") }
            cfg.bootId = a.bootId
        }
        a.cfg.blocks[i].lock = cfg
        a.state.locks[b.id] = nil
        if cfg.kind != .none, !b.enabled { a.enable(i) }
        return true
    }

    static func unlock(_ a: Agent, _ args: [String: Any]) throws -> Any {
        let i = try index(a, args)
        let b = a.cfg.blocks[i]
        let s = a.cfg.settings
        if s.passwordUnlocksBlocks, !s.passwordHash.isEmpty, let given = args["settingsPassword"] as? String,
           Engine.hashPassword(given, salt: s.passwordSalt) == s.passwordHash {
            a.cfg.blocks[i].lock = LockCfg()
            logLine("unlocked with settings password \(b.name)")
            return true
        }
        switch b.lock.kind {
        case .randomText:
            guard (args["text"] as? String) == b.lock.text else { throw DeadboltError.rejected("The text doesn't match.") }
        case .password:
            guard Engine.hashPassword(args["password"] as? String ?? "", salt: b.lock.passwordSalt) == b.lock.passwordHash else {
                throw DeadboltError.rejected("Wrong password.")
            }
        case .none: return true
        default:
            guard !a.status(b).locked else { throw DeadboltError.rejected("This lock can't be opened early.") }
        }
        a.cfg.blocks[i].lock = LockCfg()
        logLine("unlocked \(b.name)")
        return true
    }

    static func startBreak(_ a: Agent, _ args: [String: Any]) throws -> Any {
        let i = try index(a, args)
        let b = a.cfg.blocks[i]
        guard Engine.armed(b, a.nowValue) else { throw DeadboltError.rejected("This block isn't active.") }
        let c = Engine.activeBreak(b, a.nowValue)
        var r = a.state.breaks[b.id] ?? BreakRuntime()
        switch c.kind {
        case .allowance, .reward, .sessions:
            guard a.cfg.settings.requireUnblockPress else { throw DeadboltError.rejected("This break starts on its own.") }
            r.pressed = true
            r.lastUse = a.nowValue
        case .randomText:
            let typed = args["text"] as? String
            if let typed {
                guard typed == r.challenge, !r.challenge.isEmpty else { throw DeadboltError.rejected("The text doesn't match.") }
                r.challenge = ""
                r.breakUntil = a.nowValue + Double(c.breakMinutes * 60)
            } else if r.challenge.isEmpty {
                r.challenge = Engine.randomText(c.textKind, length: c.textLength, custom: c.customText)
            }
        case .delay:
            if r.delayUntil == nil, r.breakUntil == nil { r.delayUntil = a.nowValue + Double(c.delaySeconds) }
        default: throw DeadboltError.rejected("This block has no break to start.")
        }
        a.state.breaks[b.id] = r
        return try encode(a.status(b))
    }

    /// Only forbids loosening: bypass flags stay on, grace can't grow, and app action can't change during a lock.
    static func saveSettings(_ a: Agent, _ args: [String: Any]) throws -> Any {
        try checkSettingsPassword(a, args)
        var new: Settings = try decode(Settings.self, args["settings"])
        let old = a.cfg.settings
        new.passwordHash = old.passwordHash
        new.passwordSalt = old.passwordSalt
        if new.passwordUnlocksBlocks && !old.passwordUnlocksBlocks && (a.anyLocked || old.passwordHash.isEmpty) {
            throw DeadboltError.rejected("You can't enable this setting during a locked block or without a password.")
        }
        if new.passwordLocksAll && !old.passwordLocksAll && old.passwordHash.isEmpty {
            throw DeadboltError.rejected("You can't enable this setting without a password.")
        }
        if !new.passwordLocksAll && old.passwordLocksAll && a.anyLocked && (args["password"] as? String) == nil {
            throw DeadboltError.rejected("Enter the password to remove this setting.")
        }
        if a.anyLocked {
            let flags: [(Bool, Bool, String)] = [
                (old.blockInactiveTabs, new.blockInactiveTabs, "inactive tab blocking"),
                (old.blockEmbedded, new.blockEmbedded, "embedded content blocking"),
                (old.autoBlockAdult, new.autoBlockAdult, "the adult site filter"),
                (old.blockUnsupportedBrowsers, new.blockUnsupportedBrowsers, "unsupported browser blocking"),
                (old.blockFinderPreviews, new.blockFinderPreviews, "Finder preview blocking"),
                (old.blockActivityMonitor, new.blockActivityMonitor, "Activity Monitor blocking"),
                (old.blockDateTime, new.blockDateTime, "Date & Time blocking"),
                (old.blockUsersGroups, new.blockUsersGroups, "Users & Groups blocking"),
                (old.blockLoginItems, new.blockLoginItems, "Login Items blocking"),
                (old.blockScreenTime, new.blockScreenTime, "Screen Time blocking"),
                (old.blockTerminal, new.blockTerminal, "Terminal blocking"),
                (old.requireUnblockPress, new.requireUnblockPress, "the block page before breaks"),
            ]
            for (was, now, name) in flags where was && !now { throw DeadboltError.rejected("You can't disable \(name) during a locked block.") }
            if new.extensionGraceSeconds > old.extensionGraceSeconds { throw DeadboltError.rejected("You can't increase the extension grace period during a locked block.") }
            if new.appAction != old.appAction { throw DeadboltError.rejected("You can't change the app block action during a locked block.") }
            if new.allowFileUrls && !old.allowFileUrls { throw DeadboltError.rejected("You can't allow file URLs during a locked block.") }
        }
        if a.anyLockedUsageBreak {
            if old.statsEnabled && !new.statsEnabled || old.statsIncognito && !new.statsIncognito {
                throw DeadboltError.rejected("Statistics are required while a locked block has a usage based break.")
            }
            if old.countInactive && !new.countInactive { throw DeadboltError.rejected("You can't stop counting inactive tabs during a locked block with a usage based break.") }
        }
        a.cfg.settings = new
        return true
    }

    static func downloadsURL(_ name: String) -> URL {
        let dir = Seams.get("DEADBOLT_EXPORT_DIR").map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        return dir.appendingPathComponent(name)
    }

    static func exportStats(_ a: Agent, from: String, to: String) throws -> Any {
        let q = a.stats.query(from: from, to: to)
        func field(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }
        var csv = "day,type,item,value\n"
        for u in q["usage"] as? [[String: Any]] ?? [] {
            csv += "\(u["day"]!),\(u["kind"]!),\(field(u["item"] as? String ?? "")),\(u["seconds"]!)\n"
        }
        for b in q["blocked"] as? [[String: Any]] ?? [] {
            csv += "\(b["day"]!),blocked,\(field(b["item"] as? String ?? "")),\(b["count"]!)\n"
        }
        for x in q["active"] as? [[String: Any]] ?? [] { csv += "\(x["day"]!),active,,\(x["seconds"]!)\n" }
        let url = downloadsURL("deadbolt-stats-\(from)-to-\(to).csv")
        try csv.write(to: url, atomically: true, encoding: .utf8)
        return url.path
    }

    static func exportBlocks(_ a: Agent, _ args: [String: Any]) throws -> Any {
        let kind = args["kind"] as? String
        let clean = a.cfg.blocks.filter { kind == nil || $0.kind.rawValue == kind }.map { b -> Block in
            var c = b
            c.enabled = false
            c.enabledAt = nil
            c.lock = LockCfg()
            c.autostart = Autostart()
            return c
        }
        let url = downloadsURL("deadbolt-blocks-\(Stats.day(a.nowValue)).json")
        try JSONEncoder().encode(clean).write(to: url, options: .atomic)
        return url.path
    }

    static func importBlocks(_ a: Agent, _ args: [String: Any]) throws -> Any {
        guard let raw = args["blocks"] as? [Any] else { throw DeadboltError.rejected("missing argument") }
        var blocks = try raw.map { try decode(Block.self, $0) }
        for i in blocks.indices {
            blocks[i].id = UUID().uuidString
            blocks[i].enabled = false
            blocks[i].enabledAt = nil
            blocks[i].lock = LockCfg()
            blocks[i].autostart = Autostart()
            var name = blocks[i].name, n = 2
            while a.cfg.blocks.contains(where: { $0.name == name }) || blocks[..<i].contains(where: { $0.name == name }) {
                name = "\(blocks[i].name) (\(n))"
                n += 1
            }
            blocks[i].name = name
        }
        a.cfg.blocks += blocks
        return blocks.count
    }
}
