// Generic execution in any app (EXTENDED_PLAN.md §2): no per-app code.
//   click     AXPress when the element supports it, else a real click at its centre
//   type      popups: open and pick the item; fields: focus, select all, then keystrokes (short text) or a paste that
//             restores the clipboard (long or multi-line text); returns once the field shows the text
//   key       any combo: "Return", "cmd+shift+t", "Down", "opt+Left", "a"
//   navigate  open the URL (default browser)
// Every synthetic event carries Tab's marker so the tap ignores it. Call off the main thread.
import AppKit
import ApplicationServices

enum Actuator {
    static let tag = tabEventMarker

    static func exec(_ a: Action, pid: pid_t) -> String? {
        switch a.op {
        case "key":
            return key(a.value ?? "Return", pid: pid)
        case "click":
            if let p = a.targetPath, p.hasPrefix("ocr:") { return clickOCR(p, pid: pid) }
            guard let el = NativeApp.waitElement(pid: pid, path: a.targetPath) else { return "target not found: \(a.targetPath ?? "-")" }
            return click(el)
        case "type":
            if let p = a.targetPath, p.hasPrefix("ocr:") {
                if let err = clickOCR(p, pid: pid) { return err }
                usleep(150_000)
                if (a.value ?? "").count > 40 { paste(a.value ?? "", pid: pid) } else { NativeApp.type(a.value ?? "", pid: pid) }
                return nil
            }
            guard let el = NativeApp.waitElement(pid: pid, path: a.targetPath) else { return "target not found: \(a.targetPath ?? "-")" }
            if AX.role(el) == "AXPopUpButton" || AX.role(el) == "AXComboBox" && a.value.map({ !$0.isEmpty }) == true && AX.children(el).contains(where: { AX.role($0) == "AXList" }) {
                if let err = NativeApp.choose(el, item: a.value ?? "") { return err }
                // The menu applies the choice after it closes: return once the popup shows it (≤ 1 s).
                for _ in 0..<20 {
                    if (AX.attr(el, kAXValueAttribute) as String?) == a.value { break }
                    usleep(50_000)
                }
                return nil
            }
            return type(a.value ?? "", into: el, pid: pid)
        case "navigate":
            guard let s = a.value, let url = URL(string: s) else { return "bad url" }
            return NSWorkspace.shared.open(url) ? nil : "could not open \(s)"
        default:
            return "op \(a.op) not supported"
        }
    }

    /// A target read from pixels: click the centre of where its text was last seen (re-read the window if unknown).
    static func clickOCR(_ path: String, pid: pid_t) -> String? {
        var r = VisionSensor.rect(for: path)
        if r == nil { _ = VisionSensor.elements(pid: pid); r = VisionSensor.rect(for: path) }
        guard let r else { return "text \(path.dropFirst(4)) not on screen" }
        mouseClick(at: CGPoint(x: r.x + r.w / 2, y: r.y + r.h / 2))
        return nil
    }

    static func actions(_ el: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    static func click(_ el: AXUIElement) -> String? {
        if actions(el).contains(kAXPressAction as String), AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return nil }
        guard let f = AX.frame(el), f.w > 0, f.h > 0 else { return "no press action and no frame" }
        mouseClick(at: CGPoint(x: f.x + f.w / 2, y: f.y + f.h / 2))
        return nil
    }

    static func mouseClick(at p: CGPoint) {
        let src = CGEventSource(stateID: .hidSystemState)
        for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            guard let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: .left) else { continue }
            e.setIntegerValueField(.eventSourceUserData, value: tag)
            e.post(tap: .cghidEventTap)
            usleep(t == .mouseMoved ? 15_000 : 30_000)
        }
    }

    static func type(_ text: String, into el: AXUIElement, pid: pid_t) -> String? {
        // Focus: AX first; if the field doesn't take it, click into it.
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(80_000)
        if (AX.attr(el, kAXFocusedAttribute) as Bool?) != true, let f = AX.frame(el) {
            mouseClick(at: CGPoint(x: f.x + min(f.w / 2, 40), y: f.y + f.h / 2))
            usleep(120_000)
        }
        // Replace, don't append: select everything in the field first.
        let current: String = AX.attr(el, kAXValueAttribute) ?? ""
        if !current.isEmpty {
            if let r = AXValueCreate(.cfRange, [CFRange(location: 0, length: (current as NSString).length)]) {
                AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, r)
            }
            usleep(40_000)
        }
        if text.count > 40 || text.contains("\n") { paste(text, pid: pid) } else { NativeApp.type(text, pid: pid) }
        // Wait until the field shows it (apps apply input on their own run loop), then a beat for parsers like Calendar's.
        if !text.isEmpty {
            for _ in 0..<30 {
                if let v: String = AX.attr(el, kAXValueAttribute), v == text || v.contains(text) { break }
                usleep(50_000)
            }
            usleep(150_000)
        }
        return nil
    }

    /// Paste through the clipboard, then put the user's clipboard back.
    static func paste(_ text: String, pid: pid_t) {
        let pb = NSPasteboard.general
        let saved = pb.pasteboardItems?.map { item -> [(NSPasteboard.PasteboardType, Data)] in
            item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
        } ?? []
        pb.clearContents()
        pb.setString(text, forType: .string)
        _ = key("cmd+v", pid: pid)
        usleep(250_000)
        pb.clearContents()
        let items = saved.map { pairs -> NSPasteboardItem in
            let it = NSPasteboardItem()
            for (t, d) in pairs { it.setData(d, forType: t) }
            return it
        }
        if !items.isEmpty { pb.writeObjects(items) }
    }

    // MARK: keys

    static let named: [String: CGKeyCode] = [
        "return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "forwarddelete": 117, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]
    // ANSI layout virtual key codes for printable keys.
    static let printable: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
        "n": 45, "m": 46, ".": 47, "`": 50,
    ]

    /// Parse "cmd+shift+t" / "Return" / "opt+Left" into a key code and modifier flags.
    static func parse(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
        var flags: CGEventFlags = []
        var keyName = combo
        let parts = combo.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        if parts.count > 1 {
            keyName = parts.last!.isEmpty ? "+" : parts.last!
            for m in parts.dropLast() {
                switch m.lowercased() {
                case "cmd", "command": flags.insert(.maskCommand)
                case "shift": flags.insert(.maskShift)
                case "opt", "alt", "option": flags.insert(.maskAlternate)
                case "ctrl", "control": flags.insert(.maskControl)
                default: break
                }
            }
        }
        if let c = named[keyName.lowercased()] { return (c, flags) }
        if keyName.count == 1, let ch = keyName.lowercased().first, let c = printable[ch] {
            if keyName.uppercased() == keyName, keyName.lowercased() != keyName { flags.insert(.maskShift) }
            return (c, flags)
        }
        return nil
    }

    static func key(_ combo: String, pid: pid_t) -> String? {
        guard let (code, flags) = parse(combo) else { return "unknown key \(combo)" }
        let src = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { continue }
            e.flags = flags
            e.setIntegerValueField(.eventSourceUserData, value: tag)
            e.postToPid(pid)
            usleep(20_000)
        }
        return nil
    }
}
