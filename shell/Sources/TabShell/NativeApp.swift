// STRETCH (branch stretch/calendar-native, never merge without explicit human permission):
// perception and actions inside one allow-listed native app, Calendar, via Accessibility.
// Only Calendar's controls are reported, never the user's events or calendar names (privacy: the hub and the model
// must not see personal calendar data). Synthetic input is tagged 0x7AB like every other event Tab posts.
import AppKit
import ApplicationServices

let nativeApps: Set<String> = ["com.apple.iCal"]

enum NativeApp {
    /// The app's Dock icon (top-left screen coords), matched by app URL, else by name. Nil if it isn't in the Dock.
    static func dockIcon(_ bid: String) -> Rect? {
        guard let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first,
              let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) else { return nil }
        let name = FileManager.default.displayName(atPath: appURL.path).replacingOccurrences(of: ".app", with: "")
        let root = AXUIElementCreateApplication(dock.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.25)
        for list in AX.children(root) {
            for item in AX.children(list) where (AX.attr(item, kAXSubroleAttribute) as String?) == "AXApplicationDockItem" {
                let url: URL? = AX.attr(item, kAXURLAttribute)
                let title: String? = AX.attr(item, kAXTitleAttribute)
                if url?.standardizedFileURL.path == appURL.standardizedFileURL.path || title == name { return AX.frame(item) }
            }
        }
        return nil
    }

    static let roles: [String: String] = ["AXButton": "button", "AXTextField": "textfield", "AXPopUpButton": "select", "AXCheckBox": "checkbox"]

    /// Stable path for an element: its AX identifier, else its description, else its title. Nil = not addressable.
    static func path(_ el: AXUIElement) -> String? {
        if let id: String = AX.attr(el, "AXIdentifier"), !id.isEmpty { return "id:" + id }
        if let d: String = AX.attr(el, kAXDescriptionAttribute), !d.isEmpty { return "desc:" + d }
        if let t: String = AX.attr(el, kAXTitleAttribute), !t.isEmpty { return "title:" + t }
        return nil
    }

    /// Private content we never report: the user's events and their calendar list.
    static func isPrivate(_ el: AXUIElement) -> Bool {
        let help: String = AX.attr(el, kAXHelpAttribute) ?? ""
        let id: String = AX.attr(el, "AXIdentifier") ?? ""
        return help.contains("This event belongs to calendar") || id.hasPrefix("calendarlist-") || id == "calendar-checkbox-button"
    }

    /// Visit addressable controls in the focused window (popovers are its children), depth-first.
    static func controls(pid: pid_t, depth: Int = 16, _ visit: (AXUIElement, String, String) -> Bool) {
        guard let w = AX.focusedWindow(pid: pid) else { return }
        AXUIElementSetMessagingTimeout(w, 0.25)
        func walk(_ el: AXUIElement, _ d: Int) -> Bool {
            if isPrivate(el) { return true }
            let r = AX.role(el)
            if let role = roles[r], let p = path(el) { if !visit(el, role, p) { return false } }
            guard d < depth else { return true }
            for c in AX.children(el) { if !walk(c, d + 1) { return false } }
            return true
        }
        _ = walk(w, 0)
    }

    static func state(pid: pid_t, bundleId: String, seq: Int) -> ScreenState? {
        var els: [El] = []
        controls(pid: pid) { el, role, p in
            guard let f = AX.frame(el), f.w > 0, f.h > 0 else { return true }
            let label = [AX.attr(el, kAXDescriptionAttribute) as String?, AX.attr(el, kAXTitleAttribute) as String?]
                .compactMap { $0 }.first { !$0.isEmpty } ?? String(p.drop(while: { $0 != ":" }).dropFirst())
            let value: String? = (AX.attr(el, kAXValueAttribute) as Any?) as? String
            let enabled: Bool = AX.attr(el, kAXEnabledAttribute) ?? true
            if !els.contains(where: { $0.id == p }) {
                els.append(El(id: p, role: role, label: String(label.prefix(80)), value: value, options: nil, checked: nil, rect: f, enabled: enabled, path: p, list: nil))
            }
            return els.count < 120
        }
        guard !els.isEmpty else { return nil }
        let title = AX.windowTitle(pid: pid)
        return ScreenState(source: "native", app: bundleId, window: title, url: nil, focused: true, elements: els, seq: seq, ts: nowMs())
    }

    static func element(pid: pid_t, path want: String) -> AXUIElement? {
        if let el = AXSensor.element(pid: pid, path: want) { return el } // the generic path every AX snapshot uses
        var found: AXUIElement?
        controls(pid: pid) { el, _, p in
            if p == want { found = el; return false }
            return true
        }
        return found
    }

    /// `element`, retried for up to `timeout` s: right after a cold launch Calendar has no window for a beat.
    static func waitElement(pid: pid_t, path: String?, timeout: Double = 3) -> AXUIElement? {
        guard let path else { return nil }
        let end = Date().addingTimeInterval(timeout)
        repeat {
            if let el = element(pid: pid, path: path) { return el }
            usleep(100_000)
        } while Date() < end
        return nil
    }

    /// Execute one native step. Returns an error string, or nil on success. Call off the main thread.
    static func exec(_ a: Action, pid: pid_t) -> String? {
        switch a.op {
        case "key":
            post(keyCode: keyCode(a.value ?? "Return"), pid: pid)
            return nil
        case "click":
            guard let el = waitElement(pid: pid, path: a.targetPath) else { return "target not found: \(a.targetPath ?? "-")" }
            let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
            return r == .success ? nil : "AXPress failed (\(r.rawValue))"
        case "type":
            guard let el = waitElement(pid: pid, path: a.targetPath) else { return "target not found: \(a.targetPath ?? "-")" }
            if AX.role(el) == "AXPopUpButton" { return choose(el, item: a.value ?? "") }
            AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            usleep(120_000)
            let want = a.value ?? ""
            type(want, pid: pid)
            // Calendar (and other native fields) apply unicode keystrokes on their own run loop.
            // Returning immediately lets the hub send Return ~0.15 s later, before the text is in the field.
            if !want.isEmpty {
                for _ in 0..<20 {
                    if let v: String = AX.attr(el, kAXValueAttribute), v == want || v.contains(want) { break }
                    usleep(50_000)
                }
                // Calendar parses the quick event a beat after the text lands; a Return right then created an untitled event once.
                usleep(300_000)
            }
            return nil
        default:
            return "native op \(a.op) not supported"
        }
    }

    /// Open a popup button and press the menu item titled `item`.
    static func choose(_ popup: AXUIElement, item: String) -> String? {
        AXUIElementPerformAction(popup, kAXPressAction as CFString)
        for _ in 0..<10 {
            usleep(100_000)
            var q = [popup]
            while !q.isEmpty {
                let el = q.removeFirst()
                if AX.role(el) == "AXMenuItem", (AX.attr(el, kAXTitleAttribute) as String?) == item {
                    return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success ? nil : "menu item press failed"
                }
                q.append(contentsOf: AX.children(el))
            }
        }
        return "no menu item \"\(item)\""
    }

    static let tag: Int64 = 0x7AB

    static func keyCode(_ name: String) -> CGKeyCode {
        switch name.lowercased() { case "return", "enter": return 36; case "escape", "esc": return 53; case "tab": return 48; default: return 36 }
    }

    static func post(keyCode: CGKeyCode, pid: pid_t) {
        let src = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: down) else { continue }
            e.setIntegerValueField(.eventSourceUserData, value: tag)
            e.postToPid(pid)
            usleep(20_000)
        }
    }

    static func type(_ text: String, pid: pid_t) {
        let src = CGEventSource(stateID: .hidSystemState)
        for ch in text.utf16 {
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { continue }
                var c = ch
                e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
                e.setIntegerValueField(.eventSourceUserData, value: tag)
                e.postToPid(pid)
            }
            usleep(8_000)
        }
    }
}
