// Universal perception: the focused window of whatever app is frontmost, read through Accessibility.
// No per-app code. Snapshots are triggered by AXObserver notifications (focus, value, window, layout changes),
// with a slow poll as a fallback, and run on a background queue with a 0.25 s messaging timeout.
//
// Privacy at the source: secure text fields report no value, denylisted apps (password managers, plus
// ~/.tab/config.json "denyApps") report nothing at all, and Tab's own process is never read.
import AppKit
import ApplicationServices

/// Apps Tab never reads or records. Extend with ~/.tab/config.json {"denyApps": ["bundle.id", ...]}.
let defaultDenyApps: Set<String> = [
    "com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword-osx",
    "com.apple.keychainaccess", "com.apple.Passwords", "com.bitwarden.desktop", "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal", "org.keepassxc.keepassxc",
]

/// An app's identity: its bundle id, or "exe:<name>" for a bare executable (no bundle), e.g. `TabShell --testbed`.
func appId(_ app: NSRunningApplication) -> String? {
    app.bundleIdentifier ?? app.executableURL.map { "exe:" + $0.lastPathComponent }
}

/// The running app with this identity (bundle id or "exe:<name>").
func runningApp(_ id: String) -> NSRunningApplication? {
    if id.hasPrefix("pid:"), let p = pid_t(id.dropFirst(4)) { return NSRunningApplication(processIdentifier: p) }
    if id.hasPrefix("exe:") {
        let name = String(id.dropFirst(4))
        let me = ProcessInfo.processInfo.processIdentifier
        // Several bare processes can share a name (a debug shell and a testbed): prefer one with a window on screen.
        let cands = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == nil && $0.executableURL?.lastPathComponent == name && $0.processIdentifier != me }
        return cands.first { AX.focusedWindow(pid: $0.processIdentifier) != nil } ?? cands.first
    }
    return NSRunningApplication.runningApplications(withBundleIdentifier: id).first
}

/// ~/.tab/config.json, re-read whenever the file changes (no restart needed):
///   {"denyApps": ["bundle.id", …]}   never read or record these (password managers are always excluded)
///   {"onlyApps": ["bundle.id", …]}   allow-list: read and record only these apps; everything else is ignored
enum TabConfig {
    private static let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tab/config.json")
    private static let lock = NSLock()
    private static var loadedAt: Date? = nil
    private static var checked = false
    private static var deny: Set<String> = defaultDenyApps
    private static var only: Set<String>? = nil

    private static func refresh() {
        let mtime = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
        if checked && mtime == loadedAt { return }
        checked = true
        loadedAt = mtime
        deny = defaultDenyApps
        only = nil
        guard let data = try? Data(contentsOf: url), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let d = obj["denyApps"] as? [String] { deny.formUnion(d) }
        if let o = obj["onlyApps"] as? [String], !o.isEmpty { only = Set(o) }
        log("config: \(deny.count) denied apps\(only.map { ", only \($0.sorted().joined(separator: ", "))" } ?? "")")
    }

    /// True when Tab must not read, record or suggest anything in this app.
    static func denied(_ bid: String?) -> Bool {
        guard let bid else { return true }
        if bid == selfBundleId { return true }
        lock.lock(); defer { lock.unlock() }
        refresh()
        if deny.contains(bid) { return true }
        if let only, !only.contains(bid) { return true }
        return false
    }
}

/// One element's attributes, fetched in a single batched AX call.
struct AXInfo {
    var role = "", subrole = "", title = "", desc = "", value: Any?, identifier = "", placeholder = "", help = ""
    var frame: Rect?
    var enabled = true, focused = false
    var children: [AXUIElement] = []

    static let names = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
                        "AXIdentifier", kAXPlaceholderValueAttribute, kAXHelpAttribute, kAXPositionAttribute, kAXSizeAttribute,
                        kAXEnabledAttribute, kAXFocusedAttribute, kAXChildrenAttribute] as [CFString]

    init() {}

    init(_ el: AXUIElement) {
        var out: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, AXInfo.names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
              let arr = out as? [Any], arr.count == AXInfo.names.count else { return }
        func v(_ i: Int) -> Any? {
            let x = arr[i] as CFTypeRef
            // Missing attributes come back as an AXValue of type kAXValueAXErrorType.
            if CFGetTypeID(x) == AXValueGetTypeID(), AXValueGetType(x as! AXValue) == .axError { return nil }
            return arr[i]
        }
        role = v(0) as? String ?? ""
        subrole = v(1) as? String ?? ""
        title = v(2) as? String ?? ""
        desc = v(3) as? String ?? ""
        value = v(4)
        identifier = v(5) as? String ?? ""
        placeholder = v(6) as? String ?? ""
        help = v(7) as? String ?? ""
        if let p = v(8), let s = v(9), CFGetTypeID(p as CFTypeRef) == AXValueGetTypeID(), CFGetTypeID(s as CFTypeRef) == AXValueGetTypeID() {
            var pt = CGPoint.zero, sz = CGSize.zero
            AXValueGetValue(p as! AXValue, .cgPoint, &pt)
            AXValueGetValue(s as! AXValue, .cgSize, &sz)
            frame = Rect(x: pt.x, y: pt.y, w: sz.width, h: sz.height)
        }
        enabled = (v(10) as? Bool) ?? true
        focused = (v(11) as? Bool) ?? false
        children = (v(12) as? [AXUIElement]) ?? []
    }

    var stringValue: String? {
        if let s = value as? String { return s }
        if let n = value as? NSNumber, role != "AXCheckBox", role != "AXRadioButton" { return n.stringValue }
        return nil
    }

    /// Visible name: description, then title, then (for static text) the value.
    var label: String {
        for s in [desc, title] where !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return s }
        if role == "AXStaticText" || role == "AXHeading" { return stringValue ?? "" }
        return ""
    }
}

enum AXSensor {
    /// AX role → protocol role. Anything else is structure (walked, not reported).
    static func protoRole(_ i: AXInfo) -> String? {
        switch i.role {
        case "AXButton", "AXMenuButton", "AXDisclosureTriangle": return "button"
        case "AXLink": return "link"
        case "AXTextField", "AXSearchField", "AXComboBox": return "textfield"
        case "AXTextArea": return "textarea"
        case "AXPopUpButton": return "select"
        case "AXCheckBox", "AXSwitch": return "checkbox"
        case "AXRadioButton": return i.subrole == "AXTabButton" ? "tab" : "checkbox"
        case "AXCell": return "cell"
        case "AXRow": return "row"
        case "AXMenuItem", "AXMenuBarItem": return "menuitem"
        case "AXSlider", "AXIncrementor": return "slider"
        case "AXStaticText", "AXHeading": return "text"
        case "AXImage": return i.label.isEmpty ? nil : "image"
        default: return nil
        }
    }

    static let interactive: Set<String> = ["button", "link", "textfield", "textarea", "select", "checkbox", "tab", "menuitem", "slider", "cell", "row"]
    static let sectionRoles: Set<String> = ["AXGroup", "AXScrollArea", "AXSplitGroup", "AXTabGroup", "AXSheet", "AXToolbar", "AXList", "AXTable", "AXOutline", "AXWebArea", "AXForm"]

    /// Path base for an element: AX identifier, else description, else title, else its AX role. Duplicates get "#n".
    static func pathBase(_ i: AXInfo) -> String {
        if !i.identifier.isEmpty { return "id:" + i.identifier }
        if !i.desc.isEmpty { return "desc:" + i.desc }
        if !i.title.isEmpty { return "title:" + i.title }
        if i.role == "AXStaticText", let v = i.stringValue, !v.isEmpty { return "text:" + String(v.prefix(60)) }
        return "role:" + i.role
    }

    struct Limits {
        var maxEls = 200
        var maxNodes = 4000
        var budgetMs = 80.0
        var maxText = 80 // static text is context, not a target: cap it so it can't crowd out controls
    }

    struct Node { let el: AXUIElement; let info: AXInfo; let path: String; let section: String?; let depth: Int; var cell: GridRef? = nil }

    /// Walk the focused window breadth-first (top of the window first), pruning subtrees that lie outside it.
    /// `visit` returns false to stop. Paths are computed the same way for snapshots and for exec lookups.
    static func walk(window w: AXUIElement, limits: Limits = Limits(), _ visit: (Node) -> Bool) {
        AXUIElementSetMessagingTimeout(w, 0.25)
        let winInfo = AXInfo(w)
        let bounds = winInfo.frame
        var counts: [String: Int] = [:]
        // Attributes are fetched when a node is dequeued, so nodes past the budget cost nothing.
        // Two queues: page content (anything inside an AXWebArea) is visited before the browser's own chrome, so when the
        // time budget runs out on a big page, it's toolbar buttons that are lost, not the page.
        var queue: [(AXUIElement, String?, Int, GridRef?)] = winInfo.children.map { ($0, nil, 1, nil) }
        var prio: [(AXUIElement, String?, Int, GridRef?)] = []
        var head = 0, pHead = 0, visited = 0
        let t0 = CFAbsoluteTimeGetCurrent()
        while pHead < prio.count || head < queue.count {
            if visited >= limits.maxNodes || (CFAbsoluteTimeGetCurrent() - t0) * 1000 > limits.budgetMs { break }
            let inPage = pHead < prio.count
            let (el, section, depth, inCell) = inPage ? prio[pHead] : queue[head]
            if inPage { pHead += 1 } else { head += 1 }
            visited += 1
            let info = AXInfo(el)
            if let f = info.frame, let b = bounds, f.w > 0, f.h > 0, !intersects(f, b) { continue } // offscreen subtree
            let base = pathBase(info)
            let n = counts[base, default: 0]
            counts[base] = n + 1
            let path = n == 0 ? base : "\(base)#\(n)"
            // Controls inside a table cell (an editable field, a checkbox) take the cell's row and column.
            let cell = info.role == "AXCell" ? grid(el, info) : inCell
            if !visit(Node(el: el, info: info, path: path, section: section, depth: depth, cell: cell)) { return }
            // A labelled container, or a heading, names the section its descendants belong to.
            var childSection = section
            if sectionRoles.contains(info.role), !info.label.isEmpty { childSection = String(info.label.prefix(60)) }
            if depth < 40 {
                let toPage = inPage || info.role == "AXWebArea"
                for c in info.children {
                    if toPage { prio.append((c, childSection, depth + 1, cell)) } else { queue.append((c, childSection, depth + 1, cell)) }
                }
            }
        }
    }

    static func intersects(_ a: Rect, _ b: Rect) -> Bool {
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
    }

    /// Cell / row position in a grid, from AXRowIndexRange / AXColumnIndexRange / AXIndex.
    static func grid(_ el: AXUIElement, _ info: AXInfo) -> GridRef? {
        if info.role == "AXCell" {
            func idx(_ name: String) -> Int? {
                guard let v: AXValue = AX.attr(el, name) else { return nil }
                var r = CFRange()
                return AXValueGetValue(v, .cfRange, &r) ? r.location : nil
            }
            if let r = idx("AXRowIndexRange") { return GridRef(row: r, col: idx("AXColumnIndexRange")) }
        }
        if info.role == "AXRow", let i: Int = AX.attr(el, "AXIndex") { return GridRef(row: i, col: nil) }
        return nil
    }

    /// Screen rect of the insertion point in a focused text element, for inline ghost text.
    static func caret(_ el: AXUIElement) -> Rect? {
        guard let sel: AXValue = AX.attr(el, kAXSelectedTextRangeAttribute) else { return nil }
        var out: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(el, kAXBoundsForRangeParameterizedAttribute as CFString, sel, &out) == .success,
              let v = out, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CGRect.zero
        guard AXValueGetValue(v as! AXValue, .cgRect, &r), r.height > 0 else { return nil }
        return Rect(x: r.origin.x, y: r.origin.y, w: max(r.width, 1), h: r.height)
    }

    /// Where the insertion point is in a text element (UTF-16 offset), if it says.
    static func caretOffset(_ el: AXUIElement) -> Int? {
        guard let sel: AXValue = AX.attr(el, kAXSelectedTextRangeAttribute) else { return nil }
        var r = CFRange()
        return AXValueGetValue(sel, .cfRange, &r) ? r.location : nil
    }

    /// 2000 characters of a long text: around the insertion point when there is one (a terminal's is at the end, so
    /// this is its latest output; a document's is where the user is writing), else the start.
    static func window(of v: String, around caret: Int?) -> String {
        let ns = v as NSString
        guard let c = caret, c > 1500 else { return String(v.prefix(2000)) }
        let start = max(0, min(c, ns.length) - 1500)
        let len = min(2000, ns.length - start)
        return ns.substring(with: NSRange(location: start, length: len))
    }

    /// Popup menus and combo boxes: option titles, only when cheap (already-materialized children).
    static func options(_ info: AXInfo) -> [String]? {
        guard info.role == "AXPopUpButton" || info.role == "AXComboBox" else { return nil }
        var out: [String] = []
        for c in info.children {
            for item in AX.children(c) where AX.role(item) == "AXMenuItem" {
                if let t: String = AX.attr(item, kAXTitleAttribute), !t.isEmpty { out.append(t) }
            }
        }
        return out.isEmpty ? nil : Array(out.prefix(40))
    }

    static func isSecure(_ info: AXInfo) -> Bool { info.subrole == "AXSecureTextField" || info.role == "AXSecureTextField" }

    /// One El from an AX node, or nil if it isn't worth reporting.
    static func makeEl(_ n: Node, includeText: Bool) -> El? {
        let i = n.info
        guard var role = protoRole(i), let f = i.frame, f.w > 0, f.h > 0 else { return nil }
        if role == "text" && !includeText { return nil }
        let secure = isSecure(i)
        var label = i.label
        if label.isEmpty { label = i.placeholder }
        // Window buttons say what they are in their subrole.
        if label.isEmpty, let named = ["AXCloseButton": "Close window", "AXMinimizeButton": "Minimize", "AXZoomButton": "Zoom",
                                       "AXFullScreenButton": "Full screen"][i.subrole] { label = named }
        if label.isEmpty, role == "cell" || role == "row" { label = "" } // cells are addressed by grid, not label
        else if label.isEmpty, role == "text" { return nil }
        var value: String? = nil
        if !secure, role != "text", role != "button", role != "link", let v = i.stringValue {
            value = v.count <= 2000 ? v : window(of: v, around: i.focused ? caretOffset(n.el) : nil)
        }
        var checked: Bool? = nil
        if role == "checkbox" || role == "tab" { checked = (i.value as? NSNumber).map { $0.intValue != 0 } }
        if i.role == "AXButton", i.subrole == "AXToggle" { checked = (i.value as? NSNumber).map { $0.intValue != 0 }; role = "checkbox" }
        var e = El(id: n.path, role: role, label: String(label.prefix(80)), value: value, options: options(i), checked: checked,
                   rect: f, enabled: i.enabled, path: n.path, list: nil)
        e.section = n.section
        e.axId = i.identifier.isEmpty ? nil : i.identifier
        e.placeholder = i.placeholder.isEmpty ? nil : String(i.placeholder.prefix(80))
        e.help = i.help.isEmpty ? nil : String(i.help.prefix(120))
        e.focused = i.focused ? true : nil
        e.secure = secure ? true : nil
        if role == "cell" || role == "row" { e.grid = grid(n.el, i) } else if let c = n.cell { e.grid = c }
        if i.focused, role == "textfield" || role == "textarea" { e.caret = caret(n.el) }
        return e
    }

    /// Snapshot of `pid`'s focused window. Interactive elements first (focused one first of all), then text, ≤ maxEls.
    static func state(pid: pid_t, bundleId: String, seq: Int, limits: Limits = Limits()) -> ScreenState? {
        stateAndRefs(pid: pid, bundleId: bundleId, seq: seq, limits: limits)?.0
    }

    /// The snapshot plus each element's AXUIElement (same order), so later changes to one element can be patched in.
    static func stateAndRefs(pid: pid_t, bundleId: String, seq: Int, limits: Limits = Limits()) -> (ScreenState, [AXUIElement])? {
        guard let w = AX.focusedWindow(pid: pid) else { return nil }
        var controls: [(El, AXUIElement)] = [], texts: [(El, AXUIElement)] = []
        var url: String?
        var nodes = 0
        walk(window: w, limits: limits) { n in
            nodes += 1
            if n.info.role == "AXWebArea", url == nil, let u: URL = AX.attr(n.el, "AXURL") { url = u.absoluteString }
            if let e = makeEl(n, includeText: texts.count < limits.maxText) {
                if e.role == "text" { texts.append((e, n.el)) } else { controls.append((e, n.el)) }
            }
            return controls.count < limits.maxEls
        }
        // The focused element and its neighbourhood matter most; keep them if we have to cut.
        if let fi = controls.firstIndex(where: { $0.0.focused == true }), fi > 0 { controls.insert(controls.remove(at: fi), at: 0) }
        let all = Array((controls + texts).prefix(limits.maxEls))
        let title = (AX.attr(w, kAXTitleAttribute) as String?) ?? ""
        var st = ScreenState(source: "ax", app: bundleId, window: title, url: url, focused: true, elements: all.map(\.0), seq: seq, ts: nowMs())
        st.nodes = nodes
        return (st, all.map(\.1))
    }

    /// Find an element by the path a snapshot gave it.
    static func element(pid: pid_t, path want: String) -> AXUIElement? {
        guard let w = AX.focusedWindow(pid: pid) else { return nil }
        var found: AXUIElement?
        walk(window: w, limits: Limits(maxEls: .max, maxNodes: 8000, budgetMs: 400)) { n in
            if n.path == want { found = n.el; return false }
            return true
        }
        if found == nil, let app = Optional(AXUIElementCreateApplication(pid)) {
            // Menus and popovers can live outside the focused window (the menu bar, a context menu).
            for root in [AX.attr(app, kAXMenuBarAttribute) as AXUIElement?].compactMap({ $0 }) {
                walk(window: root, limits: Limits(maxEls: .max, maxNodes: 2000, budgetMs: 200)) { n in
                    if n.path == want { found = n.el; return false }
                    return true
                }
            }
        }
        return found
    }

    /// Electron apps hide their AX tree until asked; Chrome builds its web tree for assistive clients.
    static func enableTree(pid: pid_t, bundleId: String) {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if bundleId.hasPrefix("com.google.Chrome") || bundleId.hasPrefix("com.brave") || bundleId.hasPrefix("com.microsoft.edgemac") || bundleId == "company.thebrowser.Browser" {
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
    }
}

/// Watches the frontmost app through AXObserver and reports its screen when it changes.
final class AXPoller {
    private let queue = DispatchQueue(label: "tab.ax", qos: .userInitiated)
    private var target: (pid: pid_t, bundleId: String)?
    private var observer: AXObserver?
    private var lastSig: String?
    private var seq = 0
    private var pending: DispatchWorkItem?
    private var timer: DispatchSourceTimer?
    /// Apps another reader already covers (Terminal: TerminalReader keeps its 40-line `term` element).
    var skip: Set<String> = []
    var onState: ((ScreenState) -> Void)?
    var onSnapshotMs: ((Double, Int) -> Void)?
    var onIconRequest: (([IconLabeler.Request]) -> Void)?

    private static let notes = [kAXFocusedUIElementChangedNotification, kAXValueChangedNotification, kAXFocusedWindowChangedNotification,
                                kAXWindowCreatedNotification, kAXLayoutChangedNotification, kAXSelectedTextChangedNotification,
                                kAXTitleChangedNotification, kAXUIElementDestroyedNotification, kAXMenuOpenedNotification,
                                kAXMenuClosedNotification, kAXSelectedChildrenChangedNotification, kAXSelectedRowsChangedNotification]

    func setFrontmost(_ app: NSRunningApplication?) {
        let bid = app.flatMap(appId)
        let t: (pid_t, String)? = (app != nil && !TabConfig.denied(bid) && !skip.contains(bid ?? "")) ? (app!.processIdentifier, bid!) : nil
        DispatchQueue.main.async { self.attach(t) }
        if timer == nil {
            let tm = DispatchSource.makeTimerSource(queue: queue)
            tm.schedule(deadline: .now() + 1, repeating: .milliseconds(1000), leeway: .milliseconds(100))
            tm.setEventHandler { [weak self] in self?.tick() } // fallback for apps that post few notifications
            tm.resume()
            timer = tm
        }
    }

    /// Observer lives on the main run loop; snapshots on `queue`.
    private func attach(_ t: (pid_t, String)?) {
        if let o = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode) }
        observer = nil
        queue.async { self.target = t.map { (pid: $0.0, bundleId: $0.1) }; self.lastSig = nil; self.lastState = nil; self.lastRefs = [] }
        guard let (pid, bid) = t, AXIsProcessTrusted() else { return }
        queue.async { AXSensor.enableTree(pid: pid, bundleId: bid) }
        var obs: AXObserver?
        let cb: AXObserverCallback = { _, el, note, refcon in
            guard let refcon else { return }
            Unmanaged<AXPoller>.fromOpaque(refcon).takeUnretainedValue().changed(el, note as String)
        }
        guard AXObserverCreate(pid, cb, &obs) == .success, let obs else { return }
        let app = AXUIElementCreateApplication(pid)
        let me = Unmanaged.passUnretained(self).toOpaque()
        for n in AXPoller.notes { AXObserverAddNotification(obs, app, n as CFString, me) }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = obs
        changed()
    }

    private var lastTick: CFAbsoluteTime = 0
    private var lastState: ScreenState?
    private var lastRefs: [AXUIElement] = []

    /// Typing in a big window: the notification names the element whose value changed. If the last snapshot has it,
    /// patch its value and caret (~1 ms) and send that right away; a full walk follows 300 ms later for anything
    /// structural (a suggestion list appearing). Everything else takes the normal path.
    func changed(_ el: AXUIElement, _ note: String) {
        guard note == kAXValueChangedNotification || note == kAXSelectedTextChangedNotification else { return changed() }
        queue.async {
            guard var st = self.lastState, let i = self.lastRefs.firstIndex(where: { CFEqual($0, el) }), i < st.elements.count else { return self.changed() }
            let info = AXInfo(el)
            // Only typing is patched; a checkbox, a slider or a selection change takes the normal (fast) full path.
            guard ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(info.role), !AXSensor.isSecure(info) else { return self.changed() }
            if let v = info.stringValue {
                st.elements[i].value = v.count <= 2000 ? v : AXSensor.window(of: v, around: info.focused ? AXSensor.caretOffset(el) : nil)
            }
            if st.elements[i].focused == true { st.elements[i].caret = AXSensor.caret(el) }
            self.seq += 1
            st.seq = self.seq
            st.ts = nowMs()
            self.lastState = st
            DispatchQueue.main.async { self.onState?(st) }
            self.fullSoon()
        }
    }

    private var fullPending: DispatchWorkItem?
    private func fullSoon() {
        fullPending?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.lastTick = CFAbsoluteTimeGetCurrent(); self?.tick() }
        fullPending = w
        queue.asyncAfter(deadline: .now() + 0.3, execute: w)
    }

    /// Coalesce bursts of notifications (typing posts one per key) into one snapshot. The first change after a quiet
    /// moment goes out after 30 ms (a click's result, fast); changes during a burst every 100 ms (CPU).
    func changed() {
        queue.async {
            if self.pending != nil { return }
            let w = DispatchWorkItem { [weak self] in self?.pending = nil; self?.lastTick = CFAbsoluteTimeGetCurrent(); self?.tick() }
            self.pending = w
            let quiet = CFAbsoluteTimeGetCurrent() - self.lastTick > 0.3
            self.queue.asyncAfter(deadline: .now() + (quiet ? 0.03 : 0.1), execute: w)
        }
    }

    /// Force the next snapshot out even if unchanged (after an exec, so the hub sees the new screen).
    func invalidate() { queue.async { self.lastSig = nil; self.changed() } }

    private var lastOCR: (pid: pid_t, at: CFAbsoluteTime, els: [El])?
    private var ocrRunning = false
    private let ocrQueue = DispatchQueue(label: "tab.ocr", qos: .utility)

    private func tick() {
        guard let target, AXIsProcessTrusted(), !TabConfig.denied(target.bundleId) else { return }
        seq += 1
        let t0 = CFAbsoluteTimeGetCurrent()
        guard let (snap, refs) = AXSensor.stateAndRefs(pid: target.pid, bundleId: target.bundleId, seq: seq) else { return }
        var st = snap
        lastRefs = refs
        // Icon-only controls get names from the vision model (cached by image hash; unknown ones go to the hub).
        let iconReqs = IconLabeler.apply(&st, pid: target.pid)
        if !iconReqs.isEmpty { DispatchQueue.main.async { self.onIconRequest?(iconReqs) } }
        // Little to read through AX (canvas, CEF, games): read the window's text instead. OCR runs on its own queue
        // (it takes a few hundred ms); this snapshot carries the last result, and a fresh one triggers a new snapshot.
        if VisionSensor.permitted, let w = AX.focusedWindow(pid: target.pid), VisionSensor.poor(st, window: AX.frame(w)) {
            let now = CFAbsoluteTimeGetCurrent()
            if let o = lastOCR, o.pid == target.pid {
                st.elements += o.els.prefix(max(0, 200 - st.elements.count))
                st.vision = true
            }
            if !ocrRunning, lastOCR == nil || lastOCR!.pid != target.pid || now - lastOCR!.at > 1.5 {
                ocrRunning = true
                let pid = target.pid
                ocrQueue.async {
                    let t0 = CFAbsoluteTimeGetCurrent()
                    let els = VisionSensor.elements(pid: pid)
                    if ProcessInfo.processInfo.environment["TAB_DEBUG_OCR"] != nil {
                        log(String(format: "ocr: %d elements in %.0f ms (pid %d)", els.count, (CFAbsoluteTimeGetCurrent() - t0) * 1000, pid))
                    }
                    self.queue.async {
                        self.ocrRunning = false
                        self.lastOCR = (pid, CFAbsoluteTimeGetCurrent(), els)
                        self.changed()
                    }
                }
            }
        }
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        let sig = st.window + "\n" + (st.url ?? "") + "\n" + st.elements.map { "\($0.id)|\($0.value ?? "")|\($0.checked.map { "\($0)" } ?? "")|\($0.focused == true)|\(Int($0.rect.x)),\(Int($0.rect.y))" }.joined(separator: "\n")
        onSnapshotMs?(ms, st.elements.count)
        lastState = st
        if sig == lastSig { return }
        lastSig = sig
        DispatchQueue.main.async { self.onState?(st) }
    }

    /// Run `body` on the AX queue (AX calls wait on the other app; never on the tap's run loop).
    func async(_ body: @escaping () -> Void) { queue.async(execute: body) }
    func after(_ seconds: Double, _ body: @escaping () -> Void) { queue.asyncAfter(deadline: .now() + seconds, execute: body) }
}
