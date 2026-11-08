import Foundation

enum BlockKind: String, Codable { case content, device }
enum DeviceAction: String, Codable { case lock, signOut, shutDown }
enum BreakKind: String, Codable { case none, pomodoro, allowance, reward, randomText, delay, sessions }
enum Period: String, Codable { case block, daily, weekly, monthly, rolling }
enum TextKind: String, Codable { case words, gibberish, custom }
enum RewardMode: String, Codable { case working, inactive }
enum LockKind: String, Codable { case none, timer, randomText, delay, password, timeRange, schedule, restart }
enum AutostartKind: String, Codable { case none, oneTime, timeOfDay, signIn, schedule }
enum UsersMode: String, Codable { case all, only, except }

/// Flat on purpose: the UI edits this shape directly over JSON. `kind` decides which fields matter.
struct BreakCfg: Codable, Equatable {
    var kind: BreakKind = .none
    var workMinutes = 25
    var breakMinutes = 5
    var allowanceMinutes = 60
    var period: Period = .block
    var rollingMinutes = 60
    var refillMinute = 0
    var refillWeekday = 1
    var rewardMode: RewardMode = .working
    var textLength = 100
    var textKind: TextKind = .words
    var customText = ""
    var hideTypos = false
    var keepText = true
    var delaySeconds = 300
    var sessions = 3
    var maxSessionMinutes = 0
}

struct Slot: Codable, Equatable {
    var weekday: Int   // 0 = Sunday
    var start: Int     // minutes from midnight
    var end: Int
    var brk = BreakCfg()
}

struct LockCfg: Codable, Equatable {
    var kind: LockKind = .none
    var until: Double?
    var autoDisable = false
    var text = ""
    var textKind: TextKind = .words
    var textLength = 100
    var delaySeconds = 300
    var passwordHash = ""
    var passwordSalt = ""
    var rangeStart = 540
    var rangeEnd = 1020
    var rangeDays = [1, 2, 3, 4, 5]
    var rangeInverted = false
    var earlyMinutes = 0
    var bootId = ""
}

struct Autostart: Codable, Equatable {
    var kind: AutostartKind = .none
    var at: Double?
    var minute = 540
    var days = [1, 2, 3, 4, 5]
    var durationMinutes = 0
    var lockSettings = false
    var firedKey = ""
}

struct AppEntry: Codable, Equatable, Hashable {
    var path: String
    var bundleId: String?
    var isFolder = false
    var isBinary = false
}

struct Block: Codable, Equatable {
    var id = UUID().uuidString
    var name = "New block"
    var kind: BlockKind = .content
    var enabled = false
    var enabledAt: Double?
    var websites: [String] = []
    var exceptions: [String] = ["file://*"]
    var apps: [AppEntry] = []
    var scheduled = false
    var slots: [Slot] = []
    var brk = BreakCfg()
    var lock = LockCfg()
    var autostart = Autostart()
    var action: DeviceAction = .lock
    var usersMode: UsersMode = .all
    var users: [String] = []
}

struct Settings: Codable, Equatable {
    var theme = "system"
    var firstWeekday = 0
    var use24h = false
    var extensionErrorDialog = true
    var noLockHint = true
    var emptyScheduleHint = true
    var appAction = "forceClose"
    var blockInactiveTabs = false
    var blockEmbedded = false
    var countInactive = false
    var requireUnblockPress = false
    var blockUnsupportedBrowsers = false
    var blockFinderPreviews = false
    var blockActivityMonitor = false
    var blockDateTime = false
    var blockUsersGroups = false
    var blockLoginItems = false
    var blockScreenTime = false
    var blockTerminal = false
    var allowFileUrls = true
    var autoBlockAdult = true
    var extensionGraceSeconds = 60
    var notifyAppBlocked = true
    var notifyTimerEnd = true
    var notifyRange = true
    var notifyDelayEnd = true
    var notifyScheduleStart = true
    var notifyScheduleEnd = true
    var scheduleWarnings = "2,5"
    var notifyBreak = true
    var notifyAllowanceOut = true
    var allowanceWarnings = "1,5"
    var notifyAutostart = true
    var autostartWarnings = "5"
    var statsEnabled = true
    var statsIncognito = true
    var passwordHash = ""
    var passwordSalt = ""
    var passwordUnlocksBlocks = false
    var passwordLocksAll = false
    var passwordRestrictDashboard = false
    var passwordRestrictBlocks = false
    var passwordRestrictStats = false
    var passwordRestrictStart = false
    var passwordRestrictEdit = false
}

struct Config: Codable {
    var blocks: [Block] = []
    var settings = Settings()
}

/// Mutable per-block facts the config must not carry, so exports stay clean.
struct BreakRuntime: Codable, Equatable {
    var windowKey = ""
    var usedSeconds = 0.0
    var usage: [String: Double] = [:]  // minute epoch -> seconds, rolling allowance only
    var workedSeconds = 0.0
    var breakUntil: Double?
    var delayUntil: Double?
    var challenge = ""
    var sessionStarts: [Double] = []
    var sessionOpen: Double?
    var sessionLastUse: Double?
    var pomodoroAnchor: Double?
    var pressed = false
    var lastUse: Double?
}

struct LockRuntime: Codable, Equatable {
    var unlockAt: Double?
    var rangeLocked = false
}

/// A supported browser running without its extension during a lock. Survives restarts and relaunches, so neither buys a new grace period.
struct MissingBrowser: Codable, Equatable {
    var since: Double?
    var strikes = 0
}

struct State: Codable {
    var breaks: [String: BreakRuntime] = [:]
    var locks: [String: LockRuntime] = [:]
    var highWater = 0.0
    var bootId = ""
    var notified: [String: Double] = [:]
    var sites: [String: SiteVerdict] = [:]
    var modelCallDay = ""
    var modelCalls = 0
    var missing: [String: MissingBrowser] = [:]
    var zone = ""
    var monoAtSave = 0.0
}

struct BlockStatus: Codable {
    var id: String
    var name: String
    var kind: BlockKind
    var enabled: Bool
    var armed: Bool
    var blocking: Bool
    var locked: Bool
    var reason: String
    var until: Double?
    var breakKind: BreakKind
    var leftSeconds: Double?
    var sessionsLeft: Int?
    var delayUntil: Double?
    var challenge: String?
    var hideTypos = false
    var keepText = true
    var needsPress = false
    var lockKind: LockKind
    var unlockAt: Double?
}

enum DeadboltError: Error, CustomStringConvertible {
    case rejected(String)
    var description: String { if case .rejected(let m) = self { return m }; return "error" }
}
