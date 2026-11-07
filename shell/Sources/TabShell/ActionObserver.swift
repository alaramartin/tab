// Turns raw input from the tap into actions resolved to the element they hit, in any app:
//   click  → the AX element under the pointer (climbed to the nearest control)
//   type   → one action per edit burst in a field: value before and after, committed on blur, Return/Tab, a click
//            elsewhere, or 1.2 s without typing. Fields that expose no value (canvas apps) report the typed text.
//   key    → shortcuts (cmd/ctrl/opt + key) and navigation keys (Return, Tab, Escape, arrows, Delete)
// Nothing is reported for secure input, secure fields, or denylisted apps. All AX work runs on the AX queue.
import AppKit
import ApplicationServices
import Carbon.HIToolbox

struct RawInput {
    enum Kind { case key, click }
    var kind: Kind
    var keyCode: Int64 = 0
    var flags: CGEventFlags = []
    var chars: String = ""
    var location: CGPoint = .zero
    var pid: pid_t
    var bundleId: String
    var ts: Double
}

final class ActionObserver {
    private let ax: AXPoller
    var onEvent: ((UserEvent) -> Void)?

    // The edit burst in progress (AX queue only).
    private var typing: (pid: pid_t, bundleId: String, el: AXUIElement?, before: String?, chars: String, startTs: Double)?
    private var burst = 0 // bumped on every keystroke; a commit timer only fires if no key came after it
    static let commitAfter = 1.2

    init(ax: AXPoller) { self.ax = ax }

    static let navKeys: [Int64: String] = [36: "Return", 76: "Enter", 48: "Tab", 53: "Escape", 51: "Delete", 117: "ForwardDelete",
                                           123: "Left", 124: "Right", 125: "Down", 126: "Up", 115: "Home", 119: "End", 116: "PageUp", 121: "PageDown"]

    /// Called on the main thread for every real (non-Tab-generated) input that may be reported.
    func observe(_ r: RawInput) {
        guard !TabConfig.denied(r.bundleId), !IsSecureEventInputEnabled() else { return }
        ax.async { [weak self] in self?.handle(r) }
    }

    private func handle(_ r: RawInput) {
        switch r.kind {
        case .click:
            commitTyping()
            guard let ev = clickEvent(r) else { return }
            emit(ev)
        case .key:
            let mods = r.flags.intersection([.maskCommand, .maskControl, .maskAlternate])
            if !mods.isEmpty || ActionObserver.navKeys[r.keyCode] != nil && r.keyCode != 51 && r.keyCode != 117 {
                // A shortcut or navigation key ends the edit burst first, so the log reads type → key.
                commitTyping()
                let name = keyName(r)
                emit(UserEvent(app: r.bundleId, window: nil, url: nil, kind: "key", target: focusedEl(pid: r.pid), value: name, ts: r.ts))
                return
            }
            startOrContinueTyping(r)
        }
    }

    // MARK: click

    private func clickEvent(_ r: RawInput) -> UserEvent? {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.25)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(sys, Float(r.location.x), Float(r.location.y), &hit) == .success, var el = hit else {
            return UserEvent(app: r.bundleId, window: nil, kind: "click", target: nil, value: "\(Int(r.location.x)),\(Int(r.location.y))", ts: r.ts)
        }
        // Climb from the leaf (often static text inside a button) to the nearest control.
        for _ in 0..<6 {
            if let role = AXSensor.protoRole(AXInfo(el)), AXSensor.interactive.contains(role) { break }
            guard let p: AXUIElement = AX.attr(el, kAXParentAttribute) else { break }
            el = p
        }
        // The click belongs to the process that owns the element (a system dialog over TextEdit is not TextEdit).
        var pid = r.pid, bid = r.bundleId
        var owner: pid_t = 0
        if AXUIElementGetPid(el, &owner) == .success, owner != r.pid, let app = NSRunningApplication(processIdentifier: owner) {
            guard let b = appId(app), !TabConfig.denied(b) else { return nil }
            pid = owner
            bid = b
        }
        var target = describe(pid: pid, el)
        // A window AX can't see into (canvas, CEF): the click goes to the text OCR read under the pointer.
        if target == nil || !AXSensor.interactive.contains(target!.role), let o = VisionSensor.element(pid: pid, at: r.location) { target = o }
        // Clicks with no addressable target still carry the point (canvas apps).
        return UserEvent(app: bid, window: nil, kind: "click", target: target,
                         value: target == nil ? "\(Int(r.location.x)),\(Int(r.location.y))" : nil, ts: r.ts)
    }

    // MARK: typing

    private func startOrContinueTyping(_ r: RawInput) {
        let isDelete = r.keyCode == 51 || r.keyCode == 117
        if typing == nil || typing!.pid != r.pid {
            commitTyping()
            let el = focusedElement(pid: r.pid)
            let info = el.map { AXInfo($0) }
            if let info, AXSensor.isSecure(info) { return } // a password field: nothing, not even that it was typed in
            typing = (r.pid, r.bundleId, el, info?.stringValue, "", r.ts)
        }
        if isDelete { typing!.chars = String(typing!.chars.dropLast()) } else { typing!.chars += r.chars }
        burst += 1
        let mine = burst
        ax.after(ActionObserver.commitAfter) { [weak self] in
            if let self, self.burst == mine { self.commitTyping() }
        }
    }

    private func commitTyping() {
        burst += 1
        guard let t = typing else { return }
        typing = nil
        guard t.el != nil else { return } // keys with nothing focused (no window) went nowhere
        var target: El? = nil
        var after: String? = nil
        var el = t.el
        if debugEnabled {
            let now = focusedElement(pid: t.pid)
            log("typing commit: start role \(el.map { AXInfo($0).role } ?? "-") · focused now \(now.map { "\(AXInfo($0).role)/\(AXInfo($0).subrole)" } ?? "-")")
        }
        // Focus can land on a field editor a beat after the first key (a table cell starts editing on click):
        // if the burst began on a non-text element, use whatever text element has focus now.
        if let cur = el, !["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(AXInfo(cur).role),
           let now = focusedElement(pid: t.pid), ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(AXInfo(now).role) {
            el = now
        }
        if let el {
            let info = AXInfo(el)
            if AXSensor.isSecure(info) { return }
            after = info.stringValue
            target = describe(pid: t.pid, el)
        }
        // Fields with a readable value report it; others (canvas, type-to-select) report what was typed.
        var value = after ?? t.chars
        var before = t.before
        var partial: Bool? = nil
        if value.isEmpty && (before ?? "").isEmpty { return }
        if let after, after == t.before { return } // nothing changed (e.g. arrow keys in a text view)
        // Documents: keep only what this burst inserted, plus the text just before it as context.
        if let after, let b = t.before, after.count > 280 || b.count > 280 {
            let (inserted, context) = ActionObserver.edit(from: b, to: after)
            value = inserted
            before = context
            partial = true
        }
        var ev = UserEvent(app: t.bundleId, window: nil, kind: "type", target: target, value: String(value.prefix(4000)),
                           before: before.map { String($0.suffix(4000)) }, ts: t.startTs)
        ev.partial = partial
        emit(ev)
    }

    // MARK: helpers

    /// What changed between two versions of a long text: the inserted span, and up to 120 characters before it.
    static func edit(from a: String, to b: String) -> (inserted: String, context: String) {
        let x = Array(a), y = Array(b)
        var p = 0
        while p < x.count, p < y.count, x[p] == y[p] { p += 1 }
        var s = 0
        while s < x.count - p, s < y.count - p, x[x.count - 1 - s] == y[y.count - 1 - s] { s += 1 }
        let inserted = String(y[p..<(y.count - s)])
        let context = String(y[max(0, p - 120)..<p])
        return (inserted, context)
    }

    private func keyName(_ r: RawInput) -> String {
        var parts: [String] = []
        if r.flags.contains(.maskControl) { parts.append("ctrl") }
        if r.flags.contains(.maskAlternate) { parts.append("opt") }
        if r.flags.contains(.maskShift) { parts.append("shift") }
        if r.flags.contains(.maskCommand) { parts.append("cmd") }
        if let n = ActionObserver.navKeys[r.keyCode] { parts.append(n) }
        else { parts.append(r.chars.isEmpty ? "key\(r.keyCode)" : r.chars.lowercased()) }
        return parts.joined(separator: "+")
    }

    private func focusedElement(pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        return AX.attr(app, kAXFocusedUIElementAttribute)
    }

    private func focusedEl(pid: pid_t) -> El? { focusedElement(pid: pid).flatMap { describe(pid: pid, $0) } }

    /// The El a snapshot would give this element (same path), by walking the focused window to it.
    func describe(pid: pid_t, _ target: AXUIElement) -> El? {
        guard let w = AX.focusedWindow(pid: pid) else { return nil }
        var out: El?
        AXSensor.walk(window: w, limits: .init(maxEls: .max, maxNodes: 6000, budgetMs: 250)) { n in
            guard CFEqual(n.el, target) else { return true }
            out = AXSensor.makeEl(n, includeText: true)
            if out == nil, let f = n.info.frame { // a structural element (group, canvas): keep what we know
                out = El(id: n.path, role: "other", label: String(n.info.label.prefix(80)), value: nil, options: nil, checked: nil,
                         rect: f, enabled: n.info.enabled, path: n.path, list: nil)
                out?.section = n.section
            }
            return false
        }
        if out == nil { // outside the focused window (menu bar, popover): describe it without a stable path
            let i = AXInfo(target)
            if let f = i.frame { out = El(id: AXSensor.pathBase(i), role: AXSensor.protoRole(i) ?? "other", label: String(i.label.prefix(80)), value: nil,
                                          options: nil, checked: nil, rect: f, enabled: i.enabled, path: AXSensor.pathBase(i), list: nil) }
        }
        return out
    }

    private func emit(_ e: UserEvent) {
        var e = e
        if e.window == nil, let pid = runningApp(e.app)?.processIdentifier {
            e.window = AX.windowTitle(pid: pid)
        }
        DispatchQueue.main.async { self.onEvent?(e) }
    }
}
