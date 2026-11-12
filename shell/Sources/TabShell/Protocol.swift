// Codable mirrors of protocol/types.ts. Coordinates are global screen points, origin top-left of the main display.
import Foundation

struct Rect: Codable, Equatable {
    var x: Double, y: Double, w: Double, h: Double
}

struct Point: Codable, Equatable {
    var x: Double, y: Double
}

struct ListRef: Codable, Equatable {
    var key: String
    var index: Int
    var field: String?
}

struct El: Codable, Equatable {
    var id: String
    var role: String
    var label: String
    var value: String?
    var options: [String]?
    var checked: Bool?
    var rect: Rect
    var enabled: Bool
    var path: String?
    var list: ListRef?
    var section: String? = nil // nearest labelled container: "Shipping address"
    var axId: String? = nil
    var placeholder: String? = nil
    var help: String? = nil
    var focused: Bool? = nil
    var secure: Bool? = nil // password field: never carries a value
    var grid: GridRef? = nil
    var caret: Rect? = nil // insertion point of the focused text field
}

struct GridRef: Codable, Equatable {
    var row: Int
    var col: Int?
}

struct ScreenState: Codable {
    var type = "state"
    var app: String
    var window: String
    var url: String?
    var elements: [El]
    var seq: Int
    var ts: Double
    var nodes: Int? = nil // AX nodes walked (diagnostics)
    var vision: Bool? = nil // some elements were read from pixels: text (paths "ocr:…") and icons (paths "vis:…")
}

/// An action the user took in any app, resolved to the element it hit (ActionObserver).
struct UserEvent: Codable {
    var type = "user_event"
    var app: String
    var window: String?
    var url: String?
    var kind: String // "click" | "type" | "key"
    var target: El?
    var value: String?
    var before: String? // type: the field's value before the edit (partial: the text just before the insertion)
    var partial: Bool? = nil // type in a long text: `value` is only the inserted span
    var ts: Double
}

final class Action: Codable {
    var op: String
    var app: String
    var window: String?
    var url: String?
    var targetId: String?
    var targetPath: String?
    var value: String?
    var steps: [Action]?
    var label: String
    var confidence: Double
    var source: String
}

enum GhostKind: String, Codable {
    case action, text, pay, blocked, done
}

struct Ghost: Codable, Equatable {
    var id: String
    var kind: GhostKind
    var label: String
    var rect: Rect?
    var cursor: Point?
    var pillAt: Point?
    var ghostText: String?
    var ttlMs: Double?
    var place: String? // "below" (default) | "above" | "right" | "inside"
    var avoid: [Rect]? // nearby interactive elements the pill should not cover (used when `place` is absent)
    var caret: Rect? = nil // text ghost as a completion: draw only ghostText, right after this insertion point
}

struct TabDid: Codable, Equatable {
    var clicks: Int
    var keys: Int
}

struct LastTx: Codable, Equatable {
    var hash: String
    var explorerUrl: String
    var amountUsd: String
}

/// Every field optional so a partial hud from the hub still renders.
struct Hud: Codable, Equatable {
    var mode: String?
    var lastSource: String?
    var lastLatencyMs: Double?
    var modelCalls: Int?
    var shown: Int?
    var accepted: Int?
    var tabDid: TabDid?
    var youDid: Int?
    var lastTx: LastTx?
    var rules: [HudRule]?
    var goal: String?
}

/// A rule the user wrote in the HUD ("booking an event adds it to Calendar").
struct HudRule: Codable, Equatable {
    var id: String
    var text: String
    var enabled: Bool
}

struct IconLabel: Codable { var hash: String; var label: String }

// MARK: - hub → A

enum HubToShell: Decodable {
    case ghost(Ghost)
    case ghostHide
    case iconLabels([IconLabel])
    case exec(ghostId: String, action: Action)
    case hud(Hud)
    case memoryResults(query: String, results: [MemoryHit])
    case unknown(String)

    private enum K: String, CodingKey { case type, ghost, ghostId, action, hud, items, query, results }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "ghost": self = .ghost(try c.decode(Ghost.self, forKey: .ghost))
        case "ghost_hide": self = .ghostHide
        case "icon_labels": self = .iconLabels(try c.decode([IconLabel].self, forKey: .items))
        case "exec": self = .exec(ghostId: try c.decode(String.self, forKey: .ghostId), action: try c.decode(Action.self, forKey: .action))
        case "hud": self = .hud(try c.decode(Hud.self, forKey: .hud))
        case "memory_results": self = .memoryResults(query: try c.decode(String.self, forKey: .query), results: try c.decode([MemoryHit].self, forKey: .results))
        default: self = .unknown(type)
        }
    }
}

// MARK: - A → hub

enum ShellToHub: Encodable {
    case hello
    case frontmost(app: String, window: String)
    case state(ScreenState)
    case userEvent(UserEvent)
    case iconRequest([IconLabeler.Request])
    case paused(Bool)
    case forget(sinceMs: Double)
    case memorySearch(String)
    case ruleAdd(String)
    case ruleRemove(String)
    case ruleToggle(id: String, enabled: Bool)
    case goalClear
    case input(kind: String) // "key" | "click"
    case accept(ghostId: String)
    case dismiss(ghostId: String)
    case execResult(ghostId: String, ok: Bool, error: String?)

    private enum K: String, CodingKey { case type, role, app, window, kind, ghostId, ok, error, item, items, paused, sinceMs, query, text, id, enabled }

    func encode(to encoder: Encoder) throws {
        if case .state(let s) = self { return try s.encode(to: encoder) }
        if case .userEvent(let e) = self { return try e.encode(to: encoder) }
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case .hello:
            try c.encode("hello", forKey: .type)
            try c.encode("shell", forKey: .role)
        case .frontmost(let app, let window):
            try c.encode("frontmost", forKey: .type)
            try c.encode(app, forKey: .app)
            try c.encode(window, forKey: .window)
        case .state, .userEvent: break
        case .paused(let p):
            try c.encode("paused", forKey: .type)
            try c.encode(p, forKey: .paused)
        case .forget(let ms):
            try c.encode("forget", forKey: .type)
            try c.encode(ms, forKey: .sinceMs)
        case .ruleAdd(let t):
            try c.encode("rule_add", forKey: .type)
            try c.encode(t, forKey: .text)
        case .ruleRemove(let id):
            try c.encode("rule_remove", forKey: .type)
            try c.encode(id, forKey: .id)
        case .ruleToggle(let id, let on):
            try c.encode("rule_toggle", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(on, forKey: .enabled)
        case .goalClear:
            try c.encode("goal_clear", forKey: .type)
        case .memorySearch(let q):
            try c.encode("memory_search", forKey: .type)
            try c.encode(q, forKey: .query)
        case .iconRequest(let items):
            try c.encode("icon_request", forKey: .type)
            try c.encode(items, forKey: .items)
        case .input(let kind):
            try c.encode("input", forKey: .type)
            try c.encode(kind, forKey: .kind)
        case .accept(let id):
            try c.encode("accept", forKey: .type)
            try c.encode(id, forKey: .ghostId)
        case .dismiss(let id):
            try c.encode("dismiss", forKey: .type)
            try c.encode(id, forKey: .ghostId)
        case .execResult(let id, let ok, let error):
            try c.encode("exec_result", forKey: .type)
            try c.encode(id, forKey: .ghostId)
            try c.encode(ok, forKey: .ok)
            try c.encodeIfPresent(error, forKey: .error)
        }
    }
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// Details (ghost labels, typed values, timings) only with TAB_DEBUG=1; the normal log stays free of what the user does.
let debugEnabled = ProcessInfo.processInfo.environment["TAB_DEBUG"] != nil
func debugLog(_ s: String) { if debugEnabled { log(s) } }

func log(_ s: String) {
    let f = DateFormatter.logStamp.string(from: Date())
    print("\(f) \(s)")
}

extension DateFormatter {
    static let logStamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()
}
