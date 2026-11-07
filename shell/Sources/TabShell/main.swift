// TabShell: reads and records the front app, draws ghosts and the HUD, owns Tab/Esc, runs actions.
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
    let hud: HUD
    private var hubConnected = false
    let tap = InputTap()
    let hub: HubClient
    let ax = AXPoller() // any frontmost app, via Accessibility
    lazy var actions = ActionObserver(ax: ax)
    private var lastHud = Hud()
    private var statusItem: NSStatusItem?
    /// Paused: nothing is read, recorded or suggested (menu bar → Pause Tab).
    private(set) var paused = false
    private var pauseItem: NSMenuItem?
    private var showHudItem: NSMenuItem?
    private var contrastItem: NSMenuItem?

    init(hubURL: URL, highContrast: Bool) {
        overlay = Overlay(highContrast: highContrast)
        hud = HUD()
        hub = HubClient(url: hubURL)
        super.init()
        hud.setHighContrast(highContrast)
        hud.onClick = { [weak self] item in self?.hudClicked(item) }
        tap.delegate = self
        hub.onMessage = { [weak self] m in self?.handle(m) }
        hub.onConnect = { [weak self] in
            self?.hubConnected = true
            self?.hud.setConnected(true)
            self?.reportFrontmost(NSWorkspace.shared.frontmostApplication)
        }
        // Hub gone: say so, and drop the ghost, so Tab stops being swallowed for an accept nobody will receive.
        hub.onDisconnect = { [weak self] in
            self?.hubConnected = false
            self?.hud.setConnected(false)
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
        // Re-place the HUD only when displays change; a polling re-place would snap it back mid-drag.
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.replaceHud()
        }
    }

    // MARK: menu bar item (show/hide and reset the HUD, high contrast, quit)

    private func setUpMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let img = NSImage(systemSymbolName: "arrow.right.to.line", accessibilityDescription: "Tab") {
            img.isTemplate = true
            item.button?.image = img
        } else {
            item.button?.title = "⇥"
        }
        item.button?.toolTip = "Tab"
        let menu = NSMenu()
        let show = NSMenuItem(title: "Show HUD", action: #selector(toggleHud), keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        let reset = NSMenuItem(title: "Reset HUD Position", action: #selector(resetHud), keyEquivalent: "")
        reset.target = self
        menu.addItem(reset)
        let pause = NSMenuItem(title: "Pause Tab", action: #selector(togglePause), keyEquivalent: "")
        pause.target = self
        menu.addItem(pause)
        pauseItem = pause
        let forget = NSMenuItem(title: "Forget the Last Hour", action: #selector(forgetHour), keyEquivalent: "")
        forget.target = self
        menu.addItem(forget)
        menu.addItem(.separator())
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit TabShell", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
        showHudItem = show
        contrastItem = nil
        refreshMenu()
    }

    private func refreshMenu() {
        showHudItem?.state = hud.isVisible ? .on : .off
        contrastItem?.state = overlay.highContrast ? .on : .off
    }

    @objc private func toggleHud() {
        hud.setVisible(!hud.isVisible)
        refreshMenu()
    }

    @objc private func resetHud() {
        hud.resetPosition()
        if !hud.isVisible { hud.setVisible(true) }
        refreshMenu()
    }

    @objc private func toggleContrast() { hudClicked("contrast") }


    @objc private func togglePause() {
        paused.toggle()
        pauseItem?.title = paused ? "Resume Tab" : "Pause Tab"
        if paused { overlay.hide() } else { ax.invalidate() }
        statusItem?.button?.image = NSImage(systemSymbolName: paused ? "pause.circle" : "arrow.right.to.line", accessibilityDescription: "Tab")
        statusItem?.button?.image?.isTemplate = true
        hub.send(.paused(paused))
        log(paused ? "paused: nothing is read, recorded or suggested" : "resumed")
    }

    @objc private func forgetHour() {
        hub.send(.forget(sinceMs: 3_600_000))
        overlay.hide()
        log("forget: asked the hub to delete the last hour")
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func startTapWhenTrusted() {
        if tap.start() { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startTapWhenTrusted() }
    }

    private func replaceHud() { if hud.isVisible { hud.place() } }

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
            lastHud = h
            hud.update(h)
        case .exec(let ghostId, let action):
            exec(ghostId, action)
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
        let bid = a.value ?? a.app
        AppSwitcher.activate(bid) { [weak self] ok, err in
            log("exec \(ghostId): switch_app \(bid) → \(ok ? "ok" : err ?? "failed")")
            self?.hub.send(.execResult(ghostId: ghostId, ok: ok, error: err))
        }
    }

    private func hudClicked(_ item: String) {
        switch item {
        case "contrast":
            overlay.highContrast.toggle()
            hud.setHighContrast(overlay.highContrast)
            overlay.redraw()
            refreshMenu()
        case "ledger":
            if let u = lastHud.lastTx.flatMap({ URL(string: $0.explorerUrl) }) { NSWorkspace.shared.open(u) }
        default:
            break
        }
    }

    // MARK: InputTapDelegate

    var visibleGhost: Ghost? { overlay.current }
    var paymentSettling: Bool { overlay.isPaying }
    var ownRects: [CGRect] { [hud.screenRect] }

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
        actions.observe(RawInput(kind: kind, keyCode: keyCode, flags: flags, chars: chars, location: location,
                                 pid: app.processIdentifier, bundleId: bid, ts: ts))
    }
}

enum AppSwitcher {
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

/// Every HUD state side by side, with its shadow, 4 per row (--dark: on a dark page).
func renderHUD(to out: String) {
    let tx = LastTx(hash: "0x8f3a91c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f",
                    explorerUrl: "https://sepolia.basescan.org/tx/0x8f3a", amountUsd: "0.30")
    // (name, connected, high contrast, hud before, hud). A tx that appears between `before` and `hud` is a payment
    // seen live, so it flashes green; one already there on the first hud after connecting does not.
    let states: [(String, Bool, Bool, Hud?, Hud)] = [
        ("offline, stale numbers", false, false, nil,
         Hud(mode: "shown", lastSource: "model", lastLatencyMs: 212, modelCalls: 3, shown: 4, accepted: 3, tabDid: TabDid(clicks: 9, keys: 14), youDid: 9)),
        ("idle, fresh start", true, false, nil, Hud(mode: "idle", modelCalls: 0, shown: 0, accepted: 0, tabDid: TabDid(clicks: 0, keys: 0), youDid: 0)),
        ("predicting", true, false, nil, Hud(mode: "predicting", lastSource: "model", lastLatencyMs: 212, modelCalls: 3, shown: 3, accepted: 2,
                                             tabDid: TabDid(clicks: 3, keys: 0), youDid: 5)),
        ("just paid", true, false,
         Hud(mode: "running", lastSource: "model", lastLatencyMs: 188, modelCalls: 4, shown: 3, accepted: 3, tabDid: TabDid(clicks: 2, keys: 0), youDid: 6),
         Hud(mode: "shown", lastSource: "model", lastLatencyMs: 188, modelCalls: 4, shown: 3, accepted: 3, tabDid: TabDid(clicks: 3, keys: 0), youDid: 7, lastTx: tx)),
        ("a repeat", true, false, nil,
         Hud(mode: "shown", lastSource: "pattern", lastLatencyMs: 2, modelCalls: 6, shown: 8, accepted: 7, tabDid: TabDid(clicks: 9, keys: 131), youDid: 61, lastTx: tx)),
        ("running, <1 ms", true, false, nil,
         Hud(mode: "running", lastSource: "pattern", lastLatencyMs: 0, modelCalls: 6, shown: 9, accepted: 8, tabDid: TabDid(clicks: 14, keys: 150), youDid: 64, lastTx: tx)),
        ("high contrast", true, true, nil,
         Hud(mode: "idle", lastSource: "model", lastLatencyMs: 640, modelCalls: 9, shown: 16, accepted: 15, tabDid: TabDid(clicks: 31, keys: 168), youDid: 72,
             lastTx: LastTx(hash: tx.hash, explorerUrl: tx.explorerUrl, amountUsd: "0.05"))),
        ("stress", true, false, nil,
         Hud(mode: "predicting", lastSource: "pattern", lastLatencyMs: 1234, modelCalls: 99, shown: 99, accepted: 99, tabDid: TabDid(clicks: 480, keys: 754),
             youDid: 9999, lastTx: LastTx(hash: tx.hash, explorerUrl: tx.explorerUrl, amountUsd: "1234.56"))),
    ]
    let s = HUDView.size(expanded: true)
    let gap: CGFloat = 48, cols = 4
    let rows = (states.count + cols - 1) / cols
    let root = BackgroundView(frame: CGRect(x: 0, y: 0, width: CGFloat(cols) * (s.width + gap) + gap, height: CGFloat(rows) * (s.height + gap) + gap))
    root.dark = args.contains("--dark")
    for (i, (name, connected, hc, before, h)) in states.enumerated() {
        let o = CGPoint(x: gap + CGFloat(i % cols) * (s.width + gap), y: gap + CGFloat(i / cols) * (s.height + gap))
        let open = i % 2 == 1 // every other one with the breakdown open
        let vs = HUDView.size(expanded: open)
        root.addSubview(HUDShadowView(frame: CGRect(x: o.x - HUDShadowView.margin, y: o.y - HUDShadowView.margin, width: vs.width + 2 * HUDShadowView.margin, height: vs.height + 2 * HUDShadowView.margin)))
        let v = HUDView(frame: CGRect(origin: o, size: vs))
        v.expanded = open
        v.connected = connected
        if let before { v.hud = before }
        v.hud = h
        v.highContrast = hc
        root.addSubview(v)
        let cap = NSTextField(labelWithString: name)
        cap.font = .systemFont(ofSize: 11, weight: .medium)
        cap.textColor = root.dark ? .lightGray : .darkGray
        cap.frame = CGRect(x: o.x, y: o.y - 20, width: s.width, height: 16)
        root.addSubview(cap)
    }
    guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { fatalError("no bitmap") }
    root.cacheDisplay(in: root.bounds, to: rep)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
    print("wrote \(out)")
}

// MARK: - main

if args.contains("--tap-selftest") { runTapSelftest() }
if args.contains("--vision-selftest") { runVisionSelftest() }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
if let out = flagValue("--render-hud") {
    renderHUD(to: out)
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
if args.contains("--testbed") {
    app.setActivationPolicy(.regular)
    if args.contains("--canvas") { canvasTestbed = CanvasTestbed() } else { testbed = Testbed() }
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
