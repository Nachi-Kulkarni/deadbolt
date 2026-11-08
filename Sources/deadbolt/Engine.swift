import CommonCrypto
import Foundation

/// Pure rules: everything takes `now` so selftest can drive time. No I/O lives here.
enum Engine {
    static var calendar = Calendar.current
    static var currentUser = Paths.user

    static func applies(_ b: Block) -> Bool {
        switch b.usersMode {
        case .all: return true
        case .only: return b.users.contains(currentUser)
        case .except: return !b.users.contains(currentUser)
        }
    }

    static func weekday(_ now: Double) -> Int {
        calendar.component(.weekday, from: Date(timeIntervalSince1970: now)) - 1
    }

    static func startOfDay(_ now: Double) -> Double {
        calendar.startOfDay(for: Date(timeIntervalSince1970: now)).timeIntervalSince1970
    }

    static func minuteOfDay(_ now: Double) -> Int { Int((now - startOfDay(now)) / 60) }

    static func currentSlot(_ b: Block, _ now: Double) -> Slot? {
        let wd = weekday(now), m = minuteOfDay(now)
        return b.slots.first { $0.weekday == wd && $0.start <= m && m < $0.end }
    }

    /// Next slot start within seven days, used by schedule locks, warnings and autostart.
    static func nextSlotStart(_ b: Block, _ now: Double) -> Double? {
        var best: Double?
        let today = startOfDay(now), wd = weekday(now)
        for s in b.slots {
            for offset in 0...7 where (wd + offset) % 7 == s.weekday {
                // ponytail: day arithmetic ignores DST shifts, a slot can be an hour off on change days.
                let t = today + Double(offset * 86400 + s.start * 60)
                if t > now, best == nil || t < best! { best = t }
            }
        }
        return best
    }

    static func armed(_ b: Block, _ now: Double) -> Bool {
        guard b.enabled, applies(b) else { return false }
        return b.scheduled ? currentSlot(b, now) != nil : true
    }

    static func activeBreak(_ b: Block, _ now: Double) -> BreakCfg {
        b.scheduled ? (currentSlot(b, now)?.brk ?? BreakCfg()) : b.brk
    }

    static func windowKey(_ b: Block, _ c: BreakCfg, _ now: Double) -> String {
        let shifted = Date(timeIntervalSince1970: now - Double(c.refillMinute * 60))
        let p = calendar.dateComponents([.year, .month, .day, .weekOfYear, .weekday], from: shifted)
        switch c.period {
        case .block:
            if b.scheduled, let s = currentSlot(b, now) { return "slot:\(Int(startOfDay(now))):\(s.start)" }
            return "run:\(Int(b.enabledAt ?? 0))"
        case .daily: return "d:\(p.year!)-\(p.month!)-\(p.day!)"
        case .weekly:
            let daysBack = (p.weekday! - 1 - c.refillWeekday + 7) % 7
            return "w:\(Int(startOfDay(shifted.timeIntervalSince1970)) - daysBack * 86400)"
        case .monthly: return "m:\(p.year!)-\(p.month!)"
        case .rolling: return "rolling"
        }
    }

    static func allowanceLeft(_ c: BreakCfg, _ r: BreakRuntime, _ now: Double) -> Double {
        let total = Double(c.allowanceMinutes * 60)
        guard c.period == .rolling else { return max(0, total - r.usedSeconds) }
        let floorMinute = Int(now / 60) - c.rollingMinutes
        let used = r.usage.reduce(0.0) { $0 + ((Int($1.key) ?? 0) > floorMinute ? $1.value : 0) }
        return max(0, total - used)
    }

    static func rewardLeft(_ c: BreakCfg, _ r: BreakRuntime) -> Double {
        let earned = (r.workedSeconds / Double(max(1, c.workMinutes) * 60)).rounded(.down) * Double(c.breakMinutes * 60)
        return max(0, earned - r.usedSeconds)
    }

    static func sessionsLeft(_ c: BreakCfg, _ r: BreakRuntime, _ now: Double) -> Int {
        let used = c.period == .rolling
            ? r.sessionStarts.filter { $0 > now - Double(c.rollingMinutes * 60) }.count
            : r.sessionStarts.count
        return max(0, c.sessions - used)
    }

    /// Rolls the refill window forward before anything reads the balance.
    static func refreshWindow(_ b: Block, _ r: inout BreakRuntime, _ now: Double) {
        let c = activeBreak(b, now)
        guard armed(b, now), [.allowance, .reward, .sessions].contains(c.kind) else { return }
        let key = windowKey(b, c, now)
        if r.windowKey != key {
            r.windowKey = key
            r.usedSeconds = 0
            r.workedSeconds = 0
            if c.period != .rolling { r.sessionStarts = [] }
            r.sessionOpen = nil
        }
    }

    static func status(_ b: Block, _ rIn: BreakRuntime?, _ lock: LockRuntime?, bootId: String, _ now: Double) -> BlockStatus {
        var r = rIn ?? BreakRuntime()
        refreshWindow(b, &r, now)
        let isArmed = armed(b, now)
        let c = activeBreak(b, now)
        var blocking = isArmed
        var reason = isArmed ? "blocked" : (b.enabled ? "waiting for schedule" : "disabled")
        var until: Double?
        var left: Double?
        var sessions: Int?
        if isArmed {
            switch c.kind {
            case .none: break
            case .pomodoro:
                let slotStart = currentSlot(b, now).map { startOfDay(now) + Double($0.start * 60) }
                let dayStart = startOfDay(now)
                let enabled = b.enabledAt ?? dayStart
                let anchor = r.pomodoroAnchor ?? slotStart ?? max(dayStart, enabled)
                let cycle = Double((c.workMinutes + c.breakMinutes) * 60)
                let pos = (now - anchor).truncatingRemainder(dividingBy: cycle)
                let work = Double(c.workMinutes * 60)
                blocking = pos < work
                reason = blocking ? "pomodoro work" : "pomodoro break"
                until = now + (blocking ? work - pos : cycle - pos)
            case .allowance:
                left = allowanceLeft(c, r, now)
                blocking = left! <= 0
                reason = blocking ? "allowance used" : "on allowance"
            case .reward:
                left = rewardLeft(c, r)
                blocking = left! <= 0
                reason = blocking ? "reward used" : "on reward"
            case .randomText, .delay:
                if let u = r.breakUntil, u > now {
                    blocking = false
                    reason = "on break"
                    until = u
                }
            case .sessions:
                sessions = sessionsLeft(c, r, now)
                blocking = r.sessionOpen == nil && sessions! == 0
                reason = r.sessionOpen != nil ? "session open" : (blocking ? "sessions used" : "sessions left")
            }
        }
        return BlockStatus(
            id: b.id, name: b.name, kind: b.kind, enabled: b.enabled, armed: isArmed, blocking: blocking,
            locked: isLocked(b, lock, bootId: bootId, now), reason: reason, until: until,
            breakKind: isArmed ? c.kind : .none, leftSeconds: left, sessionsLeft: sessions,
            delayUntil: r.delayUntil, challenge: r.challenge.isEmpty ? nil : r.challenge,
            hideTypos: c.hideTypos, keepText: c.keepText, needsPress: false,
            lockKind: b.lock.kind, unlockAt: lock?.unlockAt)
    }

    /// One tick of usage accounting. `used` means a blocked item had the user's attention.
    static func tick(_ b: Block, _ r: inout BreakRuntime, used: Bool, idle: Bool, dt: Double, _ now: Double) {
        if let d = r.delayUntil, d <= now {
            r.delayUntil = nil
            r.breakUntil = now + Double(activeBreak(b, now).breakMinutes * 60)
        }
        if let u = r.breakUntil, u <= now { r.breakUntil = nil }
        refreshWindow(b, &r, now)
        guard armed(b, now) else { return }
        let c = activeBreak(b, now)
        if used { r.lastUse = now }
        if r.pressed, (r.lastUse.map { now - $0 >= 120 } ?? false) { r.pressed = false }
        switch c.kind {
        case .allowance:
            guard used else { return }
            if c.period == .rolling {
                let m = String(Int(now / 60))
                r.usage[m, default: 0] += dt
                let floorMinute = Int(now / 60) - c.rollingMinutes
                r.usage = r.usage.filter { (Int($0.key) ?? 0) > floorMinute }
            } else {
                r.usedSeconds += dt
            }
        case .reward:
            let earning = c.rewardMode == .working ? (!idle && !used) : idle
            if earning { r.workedSeconds += dt }
            if used { r.usedSeconds += dt }
        case .sessions:
            let maxed = c.maxSessionMinutes > 0 && (r.sessionOpen.map { now - $0 >= Double(c.maxSessionMinutes * 60) } ?? false)
            let quiet = r.sessionLastUse.map { now - $0 >= 90 } ?? false
            if r.sessionOpen != nil, maxed || (!used && quiet) { r.sessionOpen = nil }
            if used {
                if r.sessionOpen == nil, sessionsLeft(c, r, now) > 0 {
                    r.sessionOpen = now
                    r.sessionStarts.append(now)
                }
                r.sessionLastUse = now
            }
        default: break
        }
    }

    static func isLocked(_ b: Block, _ l: LockRuntime?, bootId: String, _ now: Double) -> Bool {
        let lock = b.lock
        switch lock.kind {
        case .none: return false
        case .timer: return now < (lock.until ?? 0)
        case .randomText, .password: return true
        case .delay:
            if let u = l?.unlockAt, u <= now { return false }
            return true
        case .restart: return lock.bootId == bootId
        case .timeRange:
            let inRange = inTimeRange(lock, now)
            return lock.rangeInverted ? !inRange : inRange
        case .schedule:
            if currentSlot(b, now) != nil { return true }
            guard lock.earlyMinutes > 0, let next = nextSlotStart(b, now) else { return false }
            return next - now <= Double(lock.earlyMinutes * 60)
        }
    }

    /// Ranges crossing midnight belong to the day they started on.
    static func inTimeRange(_ l: LockCfg, _ now: Double) -> Bool {
        let m = minuteOfDay(now), wd = weekday(now)
        if l.rangeStart <= l.rangeEnd { return l.rangeDays.contains(wd) && m >= l.rangeStart && m < l.rangeEnd }
        return (l.rangeDays.contains(wd) && m >= l.rangeStart) || (l.rangeDays.contains((wd + 6) % 7) && m < l.rangeEnd)
    }

    /// A locked block may only get stricter. Reports the first loosening it finds.
    static func validateLockedEdit(old: Block, new: Block) throws {
        func no(_ m: String) -> DeadboltError { .rejected("This block is locked. \(m)") }
        if !new.enabled && old.enabled { throw no("It can't be disabled.") }
        if !Set(old.websites).isSubset(of: new.websites) { throw no("Websites can't be removed.") }
        if !Set(old.apps).isSubset(of: new.apps) { throw no("Apps can't be removed.") }
        for e in Set(new.exceptions).subtracting(old.exceptions) {
            if e.contains("*") { throw no("Exceptions with wildcards can't be added.") }
            if old.websites.contains(where: { exceptionConflicts(e, with: $0) }) { throw no("Exception \(e) conflicts with a locked entry.") }
        }
        if old.scheduled != new.scheduled { throw no("The block type can't change.") }
        if old.scheduled {
            for s in old.slots where !new.slots.contains(where: { $0.weekday == s.weekday && $0.start <= s.start && $0.end >= s.end }) {
                throw no("Scheduled time can't be removed.")
            }
            for s in new.slots {
                if let o = old.slots.first(where: { $0.weekday == s.weekday && $0.start == s.start }) { try validateBreak(old: o.brk, new: s.brk) }
                else if s.brk.kind != .none { throw no("Added time can't include a break.") }
            }
        } else {
            try validateBreak(old: old.brk, new: new.brk)
        }
        if old.action != new.action { throw no("The device action can't change.") }
        switch (old.usersMode, new.usersMode) {
        case (_, .all): break
        case (.only, .only) where Set(old.users).isSubset(of: new.users): break
        case (.except, .except) where Set(new.users).isSubset(of: old.users): break
        default: throw no("It can't apply to fewer users.")
        }
        if old.autostart != new.autostart { throw no("The autostart can't change.") }
        if new.lock != old.lock {
            let extended = old.lock.kind == .timer && new.lock.kind == .timer && (new.lock.until ?? 0) >= (old.lock.until ?? 0)
            if !extended { throw no("The lock can't change.") }
        }
    }

    static func validateBreak(old: BreakCfg, new: BreakCfg) throws {
        func no(_ m: String) -> DeadboltError { .rejected("This block is locked. \(m)") }
        if old == new { return }
        if old.kind != new.kind { throw no("The break type can't change.") }
        switch old.kind {
        case .none: break
        case .pomodoro:
            if new.workMinutes < old.workMinutes || new.breakMinutes > old.breakMinutes { throw no("The pomodoro can only get stricter.") }
        case .allowance:
            if new.allowanceMinutes > old.allowanceMinutes || new.period != old.period || new.rollingMinutes < old.rollingMinutes { throw no("The allowance can only decrease.") }
        case .reward:
            if new.workMinutes < old.workMinutes || new.breakMinutes > old.breakMinutes { throw no("The reward can only get stricter.") }
        case .randomText:
            if new.textLength < old.textLength || new.breakMinutes > old.breakMinutes { throw no("Text can only get longer and breaks shorter.") }
        case .delay:
            if new.delaySeconds < old.delaySeconds || new.breakMinutes > old.breakMinutes { throw no("The delay can only increase and breaks shorten.") }
        case .sessions:
            if new.sessions > old.sessions || new.period != old.period || new.rollingMinutes < old.rollingMinutes { throw no("Sessions can only decrease.") }
        }
    }

    /// True when the exception would reopen part of a blocked entry.
    static func exceptionConflicts(_ exception: String, with entry: String) -> Bool {
        if entry.contains("*") { return true }
        func split(_ s: String) -> (String, String) {
            let t = s.lowercased().replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "").replacingOccurrences(of: "www.", with: "")
            let parts = t.split(separator: "/", maxSplits: 1).map(String.init)
            return (parts.first ?? "", parts.count > 1 ? parts[1] : "")
        }
        let (eh, ep) = split(exception), (bh, bp) = split(entry)
        guard eh == bh || eh.hasSuffix("." + bh) || bh.hasSuffix("." + eh) else { return false }
        return ep.isEmpty || bp.isEmpty || ep.hasPrefix(bp) || bp.hasPrefix(ep)
    }

    static func validateSchedule(_ b: Block) throws {
        for wd in 0..<7 {
            let day = b.slots.filter { $0.weekday == wd }.sorted { $0.start < $1.start }
            for s in day where s.start >= s.end || s.start < 0 || s.end > 1440 { throw DeadboltError.rejected("A scheduled block has invalid times.") }
            for (a, c) in zip(day, day.dropFirst()) where a.end > c.start { throw DeadboltError.rejected("You can't have overlapping blocks since blocks have a unique break type.") }
        }
    }

    static func validateBreakBounds(_ c: BreakCfg) throws {
        func bad(_ m: String) -> DeadboltError { .rejected(m) }
        switch c.kind {
        case .none: break
        case .pomodoro, .reward:
            guard (1...999).contains(c.workMinutes), (1...999).contains(c.breakMinutes) else { throw bad("Values need to be between 1 and 999.") }
        case .allowance:
            guard c.allowanceMinutes >= 1 else { throw bad("The allowance needs to be at least 1 minute.") }
        case .randomText:
            guard (1...5000).contains(c.textLength), (1...1440).contains(c.breakMinutes) else { throw bad("Text needs 1 to 5000 characters and a break up to 24 hours.") }
        case .delay:
            guard c.delaySeconds >= 1, (1...1440).contains(c.breakMinutes) else { throw bad("Delay and break are out of range.") }
        case .sessions:
            guard c.sessions >= 1 else { throw bad("The number of sessions needs to be at least 1.") }
        }
    }

    static func randomText(_ kind: TextKind, length: Int, custom: String) -> String {
        if kind == .custom { return custom }
        if kind == .gibberish {
            let chars = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
            return String((0..<length).map { _ in chars.randomElement()! })
        }
        let words = "focus steady river anchor window garden silver engine morning paper quiet stone bridge copper meadow lantern harbor pencil orchard canyon".split(separator: " ")
        var out = ""
        while out.count < length { out += (out.isEmpty ? "" : " ") + words.randomElement()! }
        return String(out.prefix(length))
    }

    static func hashPassword(_ password: String, salt: String) -> String {
        var derived = [UInt8](repeating: 0, count: 32)
        _ = password.withCString { pw in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw, strlen(pw), salt, salt.utf8.count,
                                 CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 200_000, &derived, 32)
        }
        return derived.map { String(format: "%02x", $0) }.joined()
    }

    static func newSalt() -> String { UUID().uuidString }
}
