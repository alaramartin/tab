// TabShell: reads and records the front app, draws ghosts, owns Tab/Esc, runs actions, and has the menu bar dropdown.
//   env TAB_DEBUG=1: details in the log (ghost labels, exec targets, OCR/typing/placement timings)
//   TabShell                       run (connects to ws://127.0.0.1:7800)
//   TabShell --selftest            draw every ghost kind at fixed rects, normal and high contrast
//   TabShell --tap-selftest        check the Tab/Esc/hold rules on synthetic events (no permissions needed)
//   TabShell --render out.png      render the selftest ghosts offscreen to a PNG (no permissions needed); --bg img.png, --dark,
//                                  --size WxH (points), --ghosts file.json ([{ghost, hc}] instead of the selftest layout)
//   TabShell --ax-dump [bundleId]  print the frontmost (or given) app's AX snapshot as JSON
//   TabShell --ax-bench [bundleId] [N]  time N snapshots: p50/p95/max, element counts by role
//   TabShell --exec '<Action JSON>'  run one action via the Actuator (click / type / key / navigate)
//   TabShell --testbed             a native test window (form + table) for end-to-end tests; touches no user app
//                                  (--signup adds a second form, --canvas a window with no AX, --chores a list and a tracker)
//   TabShell --ocr [bundleId]      read the app's window text and icons with Vision (vision fallback; needs Screen Recording)
//   TabShell --vision-selftest     read a drawn window image offscreen: text, icon boxes, cached names (no permissions needed)
//   flags: --high-contrast, --hub ws://host:port
import AppKit
import ApplicationServices

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
let selfBundleId = "dev.tab.shell"

func flagValue(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// MARK: - --ax-dump / --ax-bench [bundleId] [N]: read any app's focused window

if args.contains("--ax-dump") || args.contains("--ax-bench") {
    let bench = args.contains("--ax-bench")
    let flag = bench ? "--ax-bench" : "--ax-dump"
    let want = flagValue(flag).flatMap { $0.hasPrefix("--") || Int($0) != nil ? nil : $0 }
    let n = args.last.flatMap { Int($0) } ?? (bench ? 20 : 1)
    guard AXIsProcessTrusted() else { print("ax: not trusted (grant Accessibility to this binary's host)"); exit(1) }
    let app = want.flatMap(runningApp) ?? NSWorkspace.shared.frontmostApplication
    guard let app, let bid = appId(app) else { print("no app"); exit(1) }
    AXSensor.enableTree(pid: app.processIdentifier, bundleId: bid)
    var times: [Double] = []
    var last: ScreenState?
    for i in 0..<n {
        let t0 = CFAbsoluteTimeGetCurrent()
        last = AXSensor.state(pid: app.processIdentifier, bundleId: bid, seq: i)
        times.append((CFAbsoluteTimeGetCurrent() - t0) * 1000)
    }
    if bench {
        let s = times.sorted()
        let roles = Dictionary(grouping: last?.elements ?? [], by: { $0.role }).mapValues(\.count).sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
        print(String(format: "%@  snapshot p50 %.1f ms  p95 %.1f ms  max %.1f ms  · %d elements (%d AX nodes) · %@", bid,
                     s[s.count / 2], s[min(s.count - 1, Int(Double(s.count) * 0.95))], s.last!, last?.elements.count ?? 0, last?.nodes ?? 0,
                     roles.joined(separator: " ")))
    } else {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        print(String(decoding: try! enc.encode(last.map { [$0] } ?? []), as: UTF8.self))
    }
    exit(0)
}

// MARK: - --ocr [bundleId]: read the app's window through Vision (needs Screen Recording)

if let want = flagValue("--ocr") ?? (args.contains("--ocr") ? "" : nil) {
    let app = want.isEmpty ? NSWorkspace.shared.frontmostApplication : runningApp(want)
    guard let app else { print("no app"); exit(1) }
    print("screen recording permitted: \(VisionSensor.permitted)")
    _ = VisionSensor.elements(pid: app.processIdentifier) // first call lists windows; the second shows the steady state
    let t0 = CFAbsoluteTimeGetCurrent()
    let els = VisionSensor.elements(pid: app.processIdentifier)
    print(String(format: "%d elements in %.0f ms (capture %.0f ms, text %.0f ms, icons %.0f ms)", els.count, (CFAbsoluteTimeGetCurrent() - t0) * 1000,
                 VisionSensor.lastTiming?.captureMs ?? 0, VisionSensor.lastTiming?.recogniseMs ?? 0, VisionSensor.lastTiming?.objectsMs ?? 0))
    for e in els.prefix(40) { print("  \(e.role.padding(toLength: 6, withPad: " ", startingAt: 0)) \(Int(e.rect.x)),\(Int(e.rect.y)) \(Int(e.rect.w))×\(Int(e.rect.h))  \(e.label)") }
    exit(0)
}

// MARK: - --exec '<Action JSON>': run one action through the Actuator (testing; the app is the action's `app`)

if let json = flagValue("--exec") {
    guard AXIsProcessTrusted() else { print("ax: not trusted"); exit(1) }
    let a = try! JSONDecoder().decode(Action.self, from: Data(json.utf8))
    guard let app = runningApp(a.app) else { print("\(a.app) not running"); exit(1) }
    let t0 = CFAbsoluteTimeGetCurrent()
    let err = Actuator.exec(a, pid: app.processIdentifier)
    print(String(format: "%@ in %.0f ms", err ?? "ok", (CFAbsoluteTimeGetCurrent() - t0) * 1000))
    exit(err == nil ? 0 : 1)
}

// MARK: - App

final class Shell: NSObject, InputTapDelegate {
    let overlay: Overlay
    /// The menu bar dropdown: the goal in progress, rules, and Tab's commands.
    let menu = TabMenuModel()
    private lazy var menuPanel: TabMenuPanel = {
        let p = TabMenuPanel(model: menu)
        p.onOpenChange = { [weak self] open in
            if open { self?.overlay.hide() } // the dropdown takes Tab and Esc while it's open
            DispatchQueue.main.async { self?.statusItem?.button?.highlight(open) }
        }
        return p
    }()
    private var hubConnected = false
    let tap = InputTap()
    let hub: HubClient
    let ax = AXPoller() // any frontmost app, via Accessibility
    lazy var actions = ActionObserver(ax: ax)
    private var statusItem: NSStatusItem?
    /// Paused: nothing is read, recorded or suggested (menu bar → Pause Tab).
    private(set) var paused = false
    private lazy var memorySearch: MemorySearchPanel = {
        let p = MemorySearchPanel()
        p.search = { [weak self] q in
            guard let self, self.hubConnected else { return false }
            self.hub.send(.memorySearch(q))
            return true
        }
        return p
    }()

    init(hubURL: URL, highContrast: Bool) {
        overlay = Overlay(highContrast: highContrast)
        hub = HubClient(url: hubURL)
        super.init()
        menu.stopGoal = { [weak self] in self?.hub.send(.goalClear) }
        menu.onPause = { [weak self] in self?.togglePause() }
        menu.onSearch = { [weak self] in self?.openMemorySearch() }
        menu.onForget = { [weak self] in self?.forgetHour(); self?.menuPanel.close() }
        menu.onQuit = { NSApp.terminate(nil) }
        tap.delegate = self
        hub.onMessage = { [weak self] m in self?.handle(m) }
        hub.onConnect = { [weak self] in
            self?.hubConnected = true
            self?.menu.connected = true
            self?.reportFrontmost(NSWorkspace.shared.frontmostApplication)
        }
        // Hub gone: say so, and drop the ghost, so Tab stops being swallowed for an accept nobody will receive.
        hub.onDisconnect = { [weak self] in
            self?.hubConnected = false
            self?.menu.connected = false
            self?.overlay.hide()
        }
        ax.onState = { [weak self] s in if self?.paused == false { self?.hub.send(.state(s)) } }
        ax.onIconRequest = { [weak self] items in if self?.paused == false { self?.hub.send(.iconRequest(items)) } }
        actions.onEvent = { [weak self] e in if self?.paused == false { self?.hub.send(.userEvent(e)) } }
    }

    func start() {
        if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) {
            log("ax: not trusted yet; grant Accessibility to TabShell in System Settings → Privacy & Security")
        }
        startTapWhenTrusted()
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(appActivated(_:)),
                                                          name: NSWorkspace.didActivateApplicationNotification, object: nil)
        ax.setFrontmost(NSWorkspace.shared.frontmostApplication)
        hub.start()
        setUpMenuBar()
    }

    // MARK: menu bar item: a click opens the dropdown (TabMenu.swift)

    private func setUpMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let img = NSImage(systemSymbolName: "arrow.right.to.line", accessibilityDescription: "Tab") {
            img.isTemplate = true
            item.button?.image = img
        } else {
            item.button?.title = "⇥"
        }
        item.button?.toolTip = "Tab"
        item.button?.target = self
        item.button?.action = #selector(menuClicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem = item
    }

    @objc private func menuClicked() {
        if menuPanel.isVisible { return menuPanel.close() }
        guard let b = statusItem?.button, let w = b.window else { return }
        menu.reloadRules()
        menuPanel.show(below: w.convertToScreen(b.convert(b.bounds, to: nil)))
    }

    private func togglePause() {
        paused.toggle()
        menu.paused = paused
        if paused { overlay.hide() } else { ax.invalidate() }
        statusItem?.button?.image = NSImage(systemSymbolName: paused ? "pause.circle" : "arrow.right.to.line", accessibilityDescription: "Tab")
        statusItem?.button?.image?.isTemplate = true
        hub.send(.paused(paused))
        log(paused ? "paused: nothing is read, recorded or suggested" : "resumed")
    }

    private func forgetHour() {
        hub.send(.forget(sinceMs: 3_600_000))
        overlay.hide()
        log("forget: asked the hub to delete the last hour")
    }

    private func openMemorySearch() { memorySearch.show() }

    private func startTapWhenTrusted() {
        if tap.start() { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startTapWhenTrusted() }
    }

    // MARK: frontmost

    @objc private func appActivated(_ n: Notification) {
        let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        reportFrontmost(app)
    }

    private func reportFrontmost(_ app: NSRunningApplication?) {
        guard let app, let bid = appId(app), bid != selfBundleId else { return }
        ax.setFrontmost(app)
        // The window title is an AX round trip to another app; the tap shares the main run loop, so never block it.
        let pid = app.processIdentifier
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let title = AX.windowTitle(pid: pid)
            DispatchQueue.main.async {
                // Drop it if another app came forward meanwhile.
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
                self?.hub.send(.frontmost(app: bid, window: title))
            }
        }
    }

    // MARK: hub → A

    private func handle(_ m: HubToShell) {
        switch m {
        case .ghost(_) where paused:
            break
        case .ghost(let g):
            debugLog("ghost \(g.id) \(g.kind.rawValue) \"\(g.label)\" rect=\(g.rect.map { "\($0.x),\($0.y) \($0.w)×\($0.h)" } ?? "-") pillAt=\(g.pillAt.map { "\($0.x),\($0.y)" } ?? "-") place=\(g.place ?? "-") avoid=\(g.avoid?.count ?? 0)")
            overlay.show(g)
        case .ghostHide:
            log("ghost_hide")
            overlay.hide()
        case .iconLabels(let items):
            IconLabeler.store(items.map { (hash: $0.hash, label: $0.label) })
            log("icons named: \(items.map { $0.label.isEmpty ? "?" : $0.label }.joined(separator: ", "))")
            ax.invalidate()
        case .hud(let h):
            if menu.goal != h.goal { menu.goal = h.goal }
        case .exec(let ghostId, let action):
            exec(ghostId, action)
        case .memoryResults(let query, let results):
            memorySearch.show(results: results, for: query)
        case .unknown(let t):
            log("hub: ignoring \(t)")
        }
    }

    private func exec(_ ghostId: String, _ a: Action) {
        if a.op != "switch_app" {
            // Any app: click / type / key via Accessibility and synthetic input.
            ax.async { [weak self] in
                let err: String?
                if let app = runningApp(a.app) {
                    err = Actuator.exec(a, pid: app.processIdentifier)
                } else { err = "\(a.app) not running" }
                self?.ax.invalidate() // report the new screen
                DispatchQueue.main.async {
                    debugLog("exec \(ghostId): \(a.op) \(a.targetPath ?? a.value ?? "") → \(err ?? "ok")")
                    self?.hub.send(.execResult(ghostId: ghostId, ok: err == nil, error: err))
                }
            }
            return
        }
        guard a.op == "switch_app" else {
            hub.send(.execResult(ghostId: ghostId, ok: false, error: "shell only executes switch_app, got \(a.op)"))
            return
        }
        var bid = a.value ?? a.app
        // A rule names its app ("Calendar"): find it among running and installed apps.
        if bid.hasPrefix("name:") {
            let name = String(bid.dropFirst(5))
            guard let found = AppSwitcher.bundleId(named: name) else {
                hub.send(.execResult(ghostId: ghostId, ok: false, error: "no app named \(name)"))
                return
            }
            bid = found
        }
        AppSwitcher.activate(bid) { [weak self] ok, err in
            log("exec \(ghostId): switch_app \(bid) → \(ok ? "ok" : err ?? "failed")")
            self?.hub.send(.execResult(ghostId: ghostId, ok: ok, error: err))
        }
    }

    // MARK: InputTapDelegate

    /// While the dropdown is open, Tab and Esc are its own, not a ghost's.
    var visibleGhost: Ghost? { menuPanel.isVisible ? nil : overlay.current }
    var paymentSettling: Bool { overlay.isPaying }
    var ownRects: [CGRect] { menuPanel.isVisible ? [Screens.topLeft(menuPanel.frame)] : [] }

    func tapAccept(_ g: Ghost) {
        guard overlay.current?.id == g.id else { return }
        log("accept \(g.id)")
        overlay.hide(.accept)
        hub.send(.accept(ghostId: g.id))
    }

    func tapDismiss(_ g: Ghost) {
        log("dismiss \(g.id)")
        if overlay.current?.id == g.id { overlay.hide() }
        hub.send(.dismiss(ghostId: g.id))
    }

    func tapBlockedPress(_ g: Ghost) {
        overlay.shake()
    }

    func tapOtherInput(kind: String, report: Bool) {
        if let g = overlay.current, g.kind != .done { overlay.hide() }
        if report { hub.send(.input(kind: kind)) }
    }

    func tapHoldProgress(started: Bool) {
        if started { overlay.startHold(ms: holdDismissMs) } else { overlay.stopHold() }
    }

    func tapObserved(kind: RawInput.Kind, keyCode: Int64, flags: CGEventFlags, chars: String, location: CGPoint, ts: Double) {
        if paused { return }
        guard let app = NSWorkspace.shared.frontmostApplication, let bid = appId(app) else { return }
        if kind == .click, ownRects.contains(where: { $0.contains(location) }) { return }
        if kind == .key, menuPanel.isVisible { return } // typing a rule into the dropdown isn't something to record
        actions.observe(RawInput(kind: kind, keyCode: keyCode, flags: flags, chars: chars, location: location,
                                 pid: app.processIdentifier, bundleId: bid, ts: ts))
    }
}

enum AppSwitcher {
    /// The bundle id of the app called `name` (case-insensitive): a running one first, then an installed one.
    static func bundleId(named name: String) -> String? {
        let n = name.lowercased()
        if let r = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName?.lowercased() == n && $0.bundleIdentifier != nil }) {
            return r.bundleIdentifier
        }
        let fm = FileManager.default
        let dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities", fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
        for d in dirs {
            guard let items = try? fm.contentsOfDirectory(atPath: d) else { continue }
            if let hit = items.first(where: { $0.lowercased() == n + ".app" }), let b = Bundle(path: "\(d)/\(hit)")?.bundleIdentifier { return b }
        }
        return nil
    }

    /// Activate by bundle id. A background (LSUIElement) app can't always activate others under cooperative activation,
    /// so try NSRunningApplication, then AX frontmost, then LaunchServices; confirm by pid.
    static func activate(_ bid: String, done: @escaping (Bool, String?) -> Void) {
        let instances = NSRunningApplication.runningApplications(withBundleIdentifier: bid)
        guard let app = instances.first else { return open(bid, done: done) }
        let pid = app.processIdentifier
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return done(true, nil) }
        app.activate(options: [.activateAllWindows])
        DispatchQueue.global(qos: .userInitiated).async { AX.setFrontmost(pid: pid) } // AX off the tap's run loop
        confirm(pid, tries: 6) { ok in
            if ok { return done(true, nil) }
            // LaunchServices can't choose between instances, so only fall back to it when there's one.
            if instances.count == 1 { open(bid, done: done) } else { done(false, "\(bid) (pid \(pid)) did not come to the front") }
        }
    }

    private static func open(_ bid: String, done: @escaping (Bool, String?) -> Void) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) else { return done(false, "no app \(bid)") }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, err in
            DispatchQueue.main.async {
                if let err { return done(false, err.localizedDescription) }
                guard let pid = app?.processIdentifier else { return done(false, "\(bid) did not launch") }
                confirm(pid, tries: 10) { ok in done(ok, ok ? nil : "\(bid) did not come to the front") }
            }
        }
    }

    private static func confirm(_ pid: pid_t, tries: Int, _ cb: @escaping (Bool) -> Void) {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return cb(true) }
        if tries == 0 { return cb(false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { confirm(pid, tries: tries - 1, cb) }
    }
}

// MARK: - --selftest

func selftestGhosts(screen: CGSize) -> [(Ghost, Bool)] {
    func set(_ x0: Double, _ hc: Bool, _ tag: String) -> [(Ghost, Bool)] {
        let w = 200.0, h = 36.0
        var y = 70.0
        var x0 = x0
        let k = hc ? 1.3 : 1.0
        // Wrap to a new column before running off the bottom of the screen.
        func next(_ dy: Double = 84) -> Double {
            if y + dy * k > Double(screen.height) - 60 { y = 70; x0 += hc ? 470 : 380 }
            defer { y += dy * k }
            return y
        }
        var out: [(Ghost, Bool)] = []
        var r = Rect(x: 0, y: next(), w: 120, h: h); r.x = x0
        out.append((Ghost(id: "\(tag)-action", kind: .action, label: "Click Checkout ⇥", rect: r, cursor: Point(x: r.x + r.w / 2, y: r.y + r.h / 2)), hc))
        r = Rect(x: 0, y: next(), w: w + 60, h: h); r.x = x0
        out.append((Ghost(id: "\(tag)-text", kind: .text, label: "⇥", rect: r, ghostText: "4471-209"), hc))
        r = Rect(x: 0, y: next(140), w: w + 160, h: 90); r.x = x0
        out.append((Ghost(id: "\(tag)-textarea", kind: .text, label: "⇥", rect: r,
                          ghostText: "Fix checkout rounding. Totals were rounded per line item instead of once at the end, so 2 × $0.15 could show $0.31."), hc))
        r = Rect(x: 0, y: next(), w: 140, h: h); r.x = x0
        out.append((Ghost(id: "\(tag)-pay", kind: .pay, label: "Pay $0.30 · example.com ⇥", rect: r), hc))
        r = Rect(x: 0, y: next(), w: 140, h: h); r.x = x0
        out.append((Ghost(id: "\(tag)-blocked", kind: .blocked, label: "Blocked · page says $0.30, payment asks $0.51", rect: r), hc))
        r = Rect(x: 0, y: next(), w: 140, h: h); r.x = x0
        out.append((Ghost(id: "\(tag)-done", kind: .done, label: "Paid $0.30 ✓", rect: r), hc))
        r = Rect(x: 0, y: next(), w: hc ? 440 : 340, h: hc ? 46 : 32); r.x = x0
        out.append((Ghost(id: "\(tag)-repeat", kind: .action, label: "Repeat for ENG-150 · #13 ⇥", rect: r, place: "inside"), hc))
        r = Rect(x: 0, y: next(), w: 90, h: 30); r.x = x0
        out.append((Ghost(id: "\(tag)-batch", kind: .action, label: "Do the remaining 3 ⇥", rect: r), hc))
        r = Rect(x: 0, y: next(), w: hc ? 440 : 340, h: hc ? 46 : 32); r.x = x0
        out.append((Ghost(id: "\(tag)-recall", kind: .action, label: "Do all 6 from v1.4.0 · learned 10:03 am ⇥", rect: r, place: "inside"), hc))
        out.append((Ghost(id: "\(tag)-term", kind: .action, label: "Open pull request ⇥", pillAt: { let py = next() + 40; return Point(x: x0, y: py) }()), hc))
        return out
    }
    let half = Double(screen.width) / 2
    return set(60, false, "n") + set(half - 120, true, "hc")
}

// MARK: - --render

final class BackgroundView: FlippedView {
    var image: NSImage?
    var dark = false
    override func draw(_ dirty: NSRect) {
        if let image { image.draw(in: bounds); return }
        (dark ? NSColor(srgbRed: 0.12, green: 0.12, blue: 0.13, alpha: 1) : NSColor.white).setFill()
        bounds.fill()
    }
}

let highContrastFlag = args.contains("--high-contrast")

func renderSelftest(to out: String) {
    let size = flagValue("--size").map { s -> CGSize in
        let p = s.split(separator: "x").compactMap { Double($0) }
        return CGSize(width: p[0], height: p[1])
    } ?? NSScreen.screens.first!.frame.size
    let root = BackgroundView(frame: CGRect(origin: .zero, size: size))
    root.dark = args.contains("--dark")
    root.image = flagValue("--bg").flatMap { NSImage(contentsOfFile: $0) }
    // --ghosts file.json: [{"ghost": Ghost, "hc": Bool?}] in view points, instead of the selftest layout.
    // `hold` (0…1) draws the keycap's hold sweep at that fraction; `ripple` (0…1) an accept ripple frame.
    struct Item: Decodable { var ghost: Ghost; var hc: Bool?; var hold: Double?; var ripple: Double? }
    let items: [Item] = flagValue("--ghosts").map { path in
        let data = try! Data(contentsOf: URL(fileURLWithPath: path))
        return try! JSONDecoder().decode([Item].self, from: data)
    } ?? selftestGhosts(screen: size).map { Item(ghost: $0.0, hc: $0.1, hold: $0.0.id.hasSuffix("-repeat") ? 0.55 : nil, ripple: nil) }
    for it in items {
        let st = Style(hc: it.hc ?? highContrastFlag)
        let v = GhostView(ghost: it.ghost, style: st, frame: root.bounds, usable: root.bounds)
        v.pill.holdFraction = it.hold.map { CGFloat($0) }
        if let f = it.ripple {
            let ring = RippleView(frame: root.bounds, rect: v.rippleRect, corner: v.boxCorner, style: st, kind: it.ghost.kind)
            ring.progress = CGFloat(f)
            root.addSubview(ring)
            v.pill.pressed = true
            v.alphaValue = CGFloat(max(0, 1 - f * 2.5)) // the ghost fades out under the ring (120 of 320 ms)
        }
        root.addSubview(v)
    }
    guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { fatalError("no bitmap") }
    root.cacheDisplay(in: root.bounds, to: rep)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
    print("wrote \(out) \(Int(size.width))×\(Int(size.height)) pt")
}

// MARK: - main

if args.contains("--tap-selftest") { runTapSelftest() }
if args.contains("--vision-selftest") { runVisionSelftest() }
if args.contains("--subtree-selftest") { runSubtreeSelftest() }
if args.contains("--cover-selftest") { runCoverSelftest() }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
if let out = flagValue("--render-menu") {
    TabMenuPanel.render(to: out)
    exit(0)
}
if let out = flagValue("--render-memory-search") {
    MemorySearchPanel.render(to: out)
    exit(0)
}
if let out = flagValue("--render") {
    renderSelftest(to: out)
    exit(0)
}
let highContrast = args.contains("--high-contrast")
var shell: Shell?
var selftestOverlay: Overlay?

var testbed: Testbed?
var canvasTestbed: CanvasTestbed?
var choresTestbed: ChoresTestbed?
if args.contains("--testbed") {
    app.setActivationPolicy(.regular)
    if args.contains("--canvas") { canvasTestbed = CanvasTestbed() } else if args.contains("--chores") { choresTestbed = ChoresTestbed() } else { testbed = Testbed() }
    log("testbed: window open")
} else if args.contains("--selftest") {
    let o = Overlay(highContrast: highContrast)
    o.showAll(selftestGhosts(screen: NSScreen.screens.first!.frame.size))
    selftestOverlay = o
    log("selftest: drawing every ghost kind (left normal, right high contrast)")
} else {
    let url = URL(string: flagValue("--hub") ?? "ws://127.0.0.1:\(ProcessInfo.processInfo.environment["HUB_PORT"] ?? "7800")")!
    shell = Shell(hubURL: url, highContrast: highContrast)
    shell!.start()
    log("vision: screen recording \(VisionSensor.permitted ? "granted: windows with little Accessibility are read with OCR" : "not granted: the OCR fallback is off (System Settings → Privacy & Security → Screen Recording → TabShell)")")
    log("TabShell running · hub \(url)")
}

signal(SIGTERM) { _ in exit(0) }
app.run()
