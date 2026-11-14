// The user's rules are settings: a JSON file (~/.tab/rules.json, or TAB_RULES_FILE) that the menu bar dropdown edits
// directly, whether or not the hub is running. The hub reads the same file and picks up changes on its own
// (brain/src/rules.ts). {"rules": [{"id", "text", "enabled", "created"}]}; a plain list of strings is read too.
import Foundation

/// One rule, as the user wrote it ("booking an event adds it to Calendar").
struct TabRule: Codable, Equatable, Identifiable {
    var id: String
    var text: String
    var enabled: Bool
    var created: Double
}

enum RuleFile {
    static let maxRules = 20, maxText = 160

    static var url: URL {
        if let p = ProcessInfo.processInfo.environment["TAB_RULES_FILE"], !p.isEmpty { return URL(fileURLWithPath: p) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tab/rules.json")
    }

    static func load(from u: URL = url) -> [TabRule] {
        guard let data = try? Data(contentsOf: u), let raw = try? JSONSerialization.jsonObject(with: data) else { return [] }
        let list = (raw as? [Any]) ?? ((raw as? [String: Any])?["rules"] as? [Any]) ?? []
        var out: [TabRule] = []
        for (i, r) in list.enumerated() {
            let o = r as? [String: Any]
            guard let text = (r as? String) ?? (o?["text"] as? String), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            out.append(TabRule(id: o?["id"] as? String ?? "r\(i)", text: String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxText)),
                               enabled: o?["enabled"] as? Bool ?? true, created: o?["created"] as? Double ?? 0))
        }
        return Array(out.prefix(maxRules))
    }

    static func save(_ rules: [TabRule], to u: URL = url) {
        do {
            try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            try (enc.encode(["rules": rules]) + Data("\n".utf8)).write(to: u, options: .atomic)
        } catch {
            log("rules: couldn't save \(u.path): \(error.localizedDescription)")
        }
    }

    /// The text a new rule is saved with, or nil if it's empty, a duplicate, or the list is full.
    static func cleaned(_ text: String, existing: [TabRule]) -> String? {
        let t = String(text.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(maxText))
        guard !t.isEmpty, existing.count < maxRules, !existing.contains(where: { $0.text.lowercased() == t.lowercased() }) else { return nil }
        return t
    }

    static func newId() -> String { "r" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0..<1296), radix: 36) }
}
