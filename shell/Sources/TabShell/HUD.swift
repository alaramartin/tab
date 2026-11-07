// The HUD: a small non-activating panel in the top right. Clicking it never steals focus.
// The HUD panel.
import AppKit

final class HUDPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class HUD {
    let panel: HUDPanel
    private let view: HUDView
    /// The card's shadow (black α .35, blur 20, 8 pt down) is drawn in a click-through window right behind the panel.
    /// Drawn inside the panel it would need a transparent margin, and the window server routes clicks on any
    /// non-transparent pixel to us, so the soft edge would swallow clicks meant for the window underneath.
    /// It follows the panel on didMove rather than as a child window: on a scaled display the window server
    /// placed a child window off-centre and moved it at 0.81× the parent's drag.
    private let shadow: NSWindow
    private var moveObserver: NSObjectProtocol?
    var onClick: ((String) -> Void)? {
        get { view.onClick }
        set { view.onClick = newValue }
    }

    init() {
        let size = HUDView.size
        panel = HUDPanel(contentRect: CGRect(origin: .zero, size: size), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isFloatingPanel = true // resets the level to .floating, so the level is set after it
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.level = .statusBar
        view = HUDView(frame: CGRect(origin: .zero, size: size))
        panel.contentView = view

        let m = HUDShadowView.margin
        let sf = CGRect(x: 0, y: 0, width: size.width + 2 * m, height: size.height + 2 * m)
        shadow = NSWindow(contentRect: sf, styleMask: [.borderless], backing: .buffered, defer: false)
        shadow.isOpaque = false
        shadow.backgroundColor = .clear
        shadow.hasShadow = false
        shadow.ignoresMouseEvents = true
        shadow.isReleasedWhenClosed = false
        shadow.collectionBehavior = panel.collectionBehavior
        shadow.level = .statusBar
        shadow.contentView = HUDShadowView(frame: sf)

        view.onMoved = { [weak self] in self?.savePosition() }
        // Every move (drag, place(), the system relocating it after a display change) carries the shadow along.
        moveObserver = NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: nil) { [weak self] _ in
            self?.syncShadow()
        }
        place()
        if isVisible { show() }
    }

    deinit {
        if let moveObserver { NotificationCenter.default.removeObserver(moveObserver) }
    }

    // Position and visibility persist across launches (menu bar item: Show HUD / Reset HUD position).
    private static let posKey = "hudOrigin", hiddenKey = "hudHidden"

    var isVisible: Bool { !UserDefaults.standard.bool(forKey: HUD.hiddenKey) }

    func setVisible(_ v: Bool) {
        UserDefaults.standard.set(!v, forKey: HUD.hiddenKey)
        if v {
            place()
            show()
        } else {
            shadow.orderOut(nil)
            panel.orderOut(nil)
        }
    }

    /// Panel in front, its shadow right behind it.
    private func show() {
        panel.orderFrontRegardless()
        syncShadow()
        shadow.order(.below, relativeTo: panel.windowNumber)
    }

    private func syncShadow() {
        let m = HUDShadowView.margin
        shadow.setFrameOrigin(NSPoint(x: panel.frame.minX - m, y: panel.frame.minY - m))
    }

    /// Where the user dragged it, if that's still on a screen; else the top-right corner.
    func place() {
        let s = HUDView.size
        if let o = UserDefaults.standard.array(forKey: HUD.posKey) as? [Double], o.count == 2 {
            let f = CGRect(x: o[0], y: o[1], width: s.width, height: s.height)
            if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(f) }) {
                panel.setFrameOrigin(f.origin)
                return
            }
        }
        // `screens` can be empty for a moment while displays reconfigure (a projector plugging in).
        guard let vf = NSScreen.screens.first?.visibleFrame else { return }
        panel.setFrameOrigin(CGPoint(x: vf.maxX - s.width - 12, y: vf.maxY - s.height - 12))
    }

    func resetPosition() {
        UserDefaults.standard.removeObject(forKey: HUD.posKey)
        place()
    }

    private func savePosition() {
        UserDefaults.standard.set([Double(panel.frame.minX), Double(panel.frame.minY)], forKey: HUD.posKey)
    }

    /// Panel frame in top-left screen points (for the input tap). Empty while hidden. The shadow is not ours: it's click-through.
    var screenRect: CGRect {
        guard panel.isVisible else { return .zero }
        return Screens.topLeft(panel.frame)
    }

    func update(_ hud: Hud) { view.hud = hud }
    func setConnected(_ c: Bool) { view.connected = c }
    func setHighContrast(_ hc: Bool) { view.highContrast = hc }
}

/// Only the card's shadow, outside the card (the card itself is drawn by HUDView in the panel above).
final class HUDShadowView: NSView {
    static let margin: CGFloat = 36
    override var isFlipped: Bool { true }

    override func draw(_ dirty: NSRect) {
        let card = bounds.insetBy(dx: Self.margin, dy: Self.margin)
        let path = NSBezierPath(roundedRect: card, xRadius: HUDView.radius, yRadius: HUDView.radius)
        NSGraphicsContext.saveGraphicsState()
        // Clip the card out, then let the card cast the shadow: only the part outside the card lands.
        let clip = NSBezierPath(rect: bounds)
        clip.append(path)
        clip.windingRule = .evenOdd
        clip.addClip()
        let s = NSShadow()
        s.shadowColor = NSColor.black.withAlphaComponent(0.35)
        s.shadowBlurRadius = 20
        s.shadowOffset = NSSize(width: 0, height: -8) // NSShadow offsets ignore flipping: −8 is down on screen
        s.set()
        NSColor.black.setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
    }
}

final class HUDView: NSView {
    static let radius: CGFloat = 12
    static let size = CGSize(width: 264, height: L.height)
    /// Height of the Tab did / You did block alone (the end-of-demo reveal card).
    static let revealHeight: CGFloat = L.divY

    /// Layout in flipped points from the card's top. `…Base` values are text baselines.
    private enum L {
        static let padH: CGFloat = 16
        static let keyY: CGFloat = 14, keyH: CGFloat = 18     // [tab] did · You did
        static let numBase: CGFloat = 65                       // the two big numbers
        static let barY: CGFloat = 75, barH: CGFloat = 6       // the proportion bar
        static let subBase: CGFloat = 97                       // shares, clicks · keys
        static let divY: CGFloat = 109
        static let chipY: CGFloat = 120, chipH: CGFloat = 20   // last prediction (not drawn: the HUD is reveal + payments only)
        static let statBase: CGFloat = 156                     // session totals (not drawn)
        static let paidY: CGFloat = 120, paidH: CGFloat = 22   // last payment + ledger
        static let footY: CGFloat = 198, footH: CGFloat = 16   // high contrast + mode (not drawn)
        static let height: CGFloat = 156
    }

    var hud = Hud() {
        didSet {
            // Flash only for a payment that happens while we watch: the first hud after a (re)connect
            // carries the old tx, and a hub restart must not read as a new payment.
            if seenHud, let tx = hud.lastTx, tx != oldValue.lastTx { markPaid() }
            seenHud = true
            updateDot()
            retargetCounters()
            needsDisplay = true
        }
    }
    var connected = false {
        didSet {
            // A new connection starts fresh: no flash carried over, and its first hud only sets the baseline.
            if connected != oldValue {
                seenHud = false
                paidUntil = nil
            }
            updateDot()
            needsDisplay = true
        }
    }
    var highContrast = false { didSet { needsDisplay = true } }
    var onClick: ((String) -> Void)?
    var onMoved: (() -> Void)?
    /// The reveal card: only the Tab did / You did block, drawn `drawScale`× (vector, so it stays sharp), counting
    /// up over `countSeconds`.
    var revealOnly = false
    var drawScale: CGFloat = 1
    var countSeconds = 0.35
    /// Layout space: the view's bounds before `drawScale`.
    private var lb: CGRect { CGRect(x: 0, y: 0, width: bounds.width / drawScale, height: bounds.height / drawScale) }
    private func dirty(_ r: CGRect) { if drawScale == 1 { setNeedsDisplay(r) } else { needsDisplay = true } }

    private var seenHud = false
    private var paidUntil: Date?
    private var dragStart: (mouse: NSPoint, origin: NSPoint)?
    private var dragged = false
    private var ledgerRect: CGRect = .zero
    private var contrastRect: CGRect = .zero
    private var dotAlpha: CGFloat = 1
    private var pulse: Timer?

    // Count-up: what the big numbers and the bar show right now.
    private var shownTab: Double = 0, shownYou: Double = 0
    private var countUp: (fromTab: Double, fromYou: Double, toTab: Double, toYou: Double, t0: CFTimeInterval)?
    private var countTimer: Timer?

    private let primary = NSColor.white.withAlphaComponent(0.92)
    private let secondary = NSColor.white.withAlphaComponent(0.60)
    private let disabled = NSColor.white.withAlphaComponent(0.45)
    private let tabBlue = hex(0x0A84FF)
    private let tabBlueText = hex(0x409CFF) // the same blue, lifted for 11 pt text on the dark card
    private let youWhite = NSColor.white.withAlphaComponent(0.85)
    private let patternGreen = hex(0x30D158)
    private let modelPurple = hex(0xBF5AF2)
    private let modelPurpleText = hex(0xDA8FFF) // lifted for chip text: plain #BF5AF2 sank on a projector
    private let paidGreen = hex(0x30D158)

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError() }

    var mode: String { connected ? (hud.mode ?? "idle") : "offline" }

    private var tabTotal: Int { (hud.tabDid?.clicks ?? 0) + (hud.tabDid?.keys ?? 0) }

    private func modeColor() -> NSColor {
        switch mode {
        case "offline": return hex(0xFF3B30)
        case "predicting": return tabBlue
        case "shown": return .white
        case "running": return hex(Style.yellow)
        default: return hex(Style.graphite)
        }
    }

    /// Pulse the dot (alpha 1 → .35 → 1, 900 ms) only while predicting.
    private func updateDot() {
        if mode == "predicting", !revealOnly { // the reveal card has no dot
            guard pulse == nil else { return }
            let t0 = CACurrentMediaTime()
            let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
                guard let self else { return }
                let ph = (CACurrentMediaTime() - t0).truncatingRemainder(dividingBy: 0.9) / 0.9
                self.dotAlpha = 0.35 + 0.65 * CGFloat((cos(ph * 2 * .pi) + 1) / 2)
                self.dirty(CGRect(x: self.bounds.width / 2, y: L.footY - 4, width: self.bounds.width / 2, height: L.footH + 8))
            }
            RunLoop.main.add(t, forMode: .common) // keeps pulsing while the HUD is dragged
            pulse = t
        } else {
            pulse?.invalidate()
            pulse = nil
            dotAlpha = 1
        }
    }

    private func markPaid() {
        paidUntil = Date().addingTimeInterval(3)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.05) { [weak self] in self?.needsDisplay = true }
    }

    /// Tab did / You did count up to a new value (350 ms, ease-out). Decreases (a hub restart), reduced motion,
    /// and offscreen renders jump straight to the value.
    private func retargetCounters() {
        let tt = Double(tabTotal), ty = Double(hud.youDid ?? 0)
        if tt < shownTab { shownTab = tt }
        if ty < shownYou { shownYou = ty }
        if let c = countUp, c.toTab == tt, c.toYou == ty { return } // already heading there
        guard tt != shownTab || ty != shownYou else { stopCountUp(); return }
        if window == nil || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            shownTab = tt
            shownYou = ty
            stopCountUp()
            return
        }
        countUp = (shownTab, shownYou, tt, ty, CACurrentMediaTime())
        guard countTimer == nil else { return }
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.stepCountUp() }
        RunLoop.main.add(t, forMode: .common)
        countTimer = t
    }

    private func stepCountUp() {
        guard let c = countUp else { return stopCountUp() }
        let p = min(1, (CACurrentMediaTime() - c.t0) / countSeconds)
        let e = 1 - pow(1 - p, 3)
        shownTab = c.fromTab + (c.toTab - c.fromTab) * e
        shownYou = c.fromYou + (c.toYou - c.fromYou) * e
        if p >= 1 { stopCountUp() }
        dirty(CGRect(x: 0, y: 0, width: bounds.width, height: L.divY))
    }

    private func stopCountUp() {
        countTimer?.invalidate()
        countTimer = nil
        countUp = nil
    }

    // MARK: text helpers

    private func mono(_ size: CGFloat, _ w: NSFont.Weight) -> NSFont { .monospacedDigitSystemFont(ofSize: size, weight: w) }

    /// SF Pro Rounded with tabular digits, for the two big numbers.
    private static func heroFont(_ size: CGFloat) -> NSFont {
        let base = NSFont.monospacedDigitSystemFont(ofSize: size, weight: .semibold)
        guard let d = base.fontDescriptor.withDesign(.rounded), let f = NSFont(descriptor: d, size: size) else { return base }
        return f
    }
    private static let hero32 = heroFont(32)

    private func run(_ s: String, _ f: NSFont, _ c: NSColor) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: c])
    }

    private func join(_ parts: [NSAttributedString]) -> NSAttributedString {
        let a = NSMutableAttributedString()
        parts.forEach { a.append($0) }
        return a
    }

    /// Number in semibold primary, words in regular secondary: "4" + "/5 accepted".
    private func stat(_ parts: [(String, Bool)], size: CGFloat = 11) -> NSAttributedString {
        join(parts.map { run($0.0, mono(size, $0.1 ? .semibold : .regular), $0.1 ? primary : secondary) })
    }

    private func width(_ a: NSAttributedString) -> CGFloat { ceil(a.size().width) }

    private func ascender(_ a: NSAttributedString) -> CGFloat {
        var asc: CGFloat = 0
        a.enumerateAttribute(.font, in: NSRange(location: 0, length: a.length)) { v, _, _ in
            if let f = v as? NSFont { asc = max(asc, f.ascender) }
        }
        return asc
    }

    /// Draw with the baseline at `base`; with `maxW`, truncate the tail instead of running into a neighbour.
    private func draw(_ a: NSAttributedString, x: CGFloat, base: CGFloat, maxW: CGFloat? = nil) {
        let top = base - ascender(a)
        guard let maxW, width(a) > maxW else { return a.draw(at: CGPoint(x: x, y: top)) }
        let m = NSMutableAttributedString(attributedString: a)
        let ps = NSMutableParagraphStyle()
        ps.lineBreakMode = .byTruncatingTail
        m.addAttribute(.paragraphStyle, value: ps, range: NSRange(location: 0, length: m.length))
        m.draw(with: CGRect(x: x, y: top, width: maxW, height: ascender(a) + 6), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    private func drawRight(_ a: NSAttributedString, right: CGFloat, base: CGFloat) {
        draw(a, x: right - width(a), base: base)
    }

    /// Baseline that centres capitals of `f` in a row from `y` of height `h`.
    private func centred(_ y: CGFloat, _ h: CGFloat, _ f: NSFont) -> CGFloat { (y + h / 2 + f.capHeight / 2).rounded() }

    private func capsule(_ r: CGRect, _ c: NSColor) {
        c.setFill()
        NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2).fill()
    }

    private func latency(_ ms: Double, size: CGFloat) -> NSAttributedString {
        if ms < 1 { return stat([("<1", true), (" ms", false)], size: size) }
        let v = ms < 10 && ms.rounded() != ms ? String(format: "%.1f", ms) : "\(Int(ms.rounded()))"
        return stat([(v, true), (" ms", false)], size: size)
    }

    // MARK: drawing

    override func draw(_ dirtyRect: NSRect) {
        if drawScale != 1 { NSGraphicsContext.current?.cgContext.scaleBy(x: drawScale, y: drawScale) }
        let card = NSBezierPath(roundedRect: lb, xRadius: HUDView.radius, yRadius: HUDView.radius)
        hex(0x1C1C1E, revealOnly ? 0.97 : 0.94).setFill()
        card.fill()
        let edge = NSBezierPath(roundedRect: lb.insetBy(dx: 0.5, dy: 0.5), xRadius: HUDView.radius - 0.5, yRadius: HUDView.radius - 0.5)
        NSColor.white.withAlphaComponent(0.10).setStroke()
        edge.lineWidth = 1 / drawScale
        edge.stroke()
        if revealOnly { return drawReveal() }

        // Offline: the numbers are stale, so they step back; the footer (mode, switch) stays bright.
        let ctx = NSGraphicsContext.current?.cgContext
        if !connected {
            ctx?.setAlpha(0.5)
            ctx?.beginTransparencyLayer(auxiliaryInfo: nil)
        }
        drawReveal()
        NSColor.white.withAlphaComponent(0.10).setFill()
        CGRect(x: L.padH, y: L.divY, width: lb.width - 2 * L.padH, height: 1).fill()
        drawPaid() // human's call (14:40): no prediction rows, no high-contrast switch, no mode footer
        if !connected {
            ctx?.endTransparencyLayer()
            ctx?.setAlpha(1)
        }
    }

    /// The end-of-demo reveal: [tab] did vs You did, a two-segment bar, and the shares.
    private func drawReveal() {
        let x0 = L.padH, x1 = lb.width - L.padH, w = x1 - x0

        // Labels. "Tab" is the keycap the ghost teaches, in the bar's blue: it doubles as the legend.
        let kf = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let lf = NSFont.systemFont(ofSize: 11, weight: .medium)
        let kt = run("tab", kf, .white)
        let key = CGRect(x: x0, y: L.keyY, width: max(width(kt) + 12, 30), height: L.keyH)
        let kp = NSBezierPath(roundedRect: key, xRadius: 4.5, yRadius: 4.5)
        tabBlue.setFill()
        kp.fill()
        NSGraphicsContext.saveGraphicsState()
        kp.addClip()
        NSColor.black.withAlphaComponent(0.22).setFill() // the keycap's bottom edge, as on the ghost
        CGRect(x: key.minX, y: key.maxY - 1.5, width: key.width, height: 1.5).fill()
        NSGraphicsContext.restoreGraphicsState()
        let lb = (key.minY + (key.height - 1.5) / 2 + kf.xHeight / 2).rounded() // lowercase: centre the x-height
        draw(kt, x: key.midX - width(kt) / 2, base: lb)
        draw(run("did", lf, secondary), x: key.maxX + 5, base: lb)
        drawRight(run("You did", lf, secondary), right: x1, base: lb)

        // Numbers (they count up; see retargetCounters).
        let tab = Int(shownTab.rounded()), you = Int(shownYou.rounded())
        var tn = run("\(tab)", HUDView.hero32, primary), yn = run("\(you)", HUDView.hero32, primary)
        if width(tn) + width(yn) + 16 > w { // 6+ digits: shrink both, on the same baseline, rather than collide
            let f = HUDView.heroFont(max(11, (32 * (w - 16) / (width(tn) + width(yn))).rounded(.down)))
            tn = run("\(tab)", f, primary)
            yn = run("\(you)", f, primary)
        }
        draw(tn, x: x0 - 1, base: L.numBase)
        drawRight(yn, right: x1 + 1, base: L.numBase)

        // Bar: Tab's share from the left in blue, yours from the right in white, 3 pt apart.
        let total = shownTab + shownYou
        if total <= 0 {
            capsule(CGRect(x: x0, y: L.barY, width: w, height: L.barH), NSColor.white.withAlphaComponent(0.10))
        } else if shownYou <= 0 {
            capsule(CGRect(x: x0, y: L.barY, width: w, height: L.barH), tabBlue)
        } else if shownTab <= 0 {
            capsule(CGRect(x: x0, y: L.barY, width: w, height: L.barH), youWhite)
        } else {
            let gap: CGFloat = 3
            let tw = min(max(((w - gap) * CGFloat(shownTab / total)).rounded(), L.barH), w - gap - L.barH)
            capsule(CGRect(x: x0, y: L.barY, width: tw, height: L.barH), tabBlue)
            capsule(CGRect(x: x0 + tw + gap, y: L.barY, width: w - tw - gap, height: L.barH), youWhite)
        }

        // Under the bar: each side's share at its end, plus what Tab did in clicks and keys.
        let td = hud.tabDid ?? TabDid(clicks: 0, keys: 0)
        let breakdown = "\(td.clicks) \(td.clicks == 1 ? "click" : "clicks") · \(td.keys) \(td.keys == 1 ? "key" : "keys")"
        if total > 0 {
            let tp = Int((100 * shownTab / total).rounded())
            let right = run("\(100 - tp)%", mono(11, .semibold), youWhite)
            drawRight(right, right: x1, base: L.subBase)
            let left = join([run("\(tp)%", mono(11, .semibold), tabBlueText), run("  " + breakdown, mono(11, .regular), secondary)])
            draw(left, x: x0, base: L.subBase, maxW: w - width(right) - 12)
        } else {
            draw(run(breakdown, mono(11, .regular), secondary), x: x0, base: L.subBase)
        }
    }

    /// Last prediction (where it came from, did it cost a model call, how fast), then session totals.
    private func drawPrediction() {
        let x0 = L.padH, x1 = lb.width - L.padH
        let f12 = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let base = centred(L.chipY, L.chipH, f12)
        if let src = hud.lastSource {
            let c: NSColor = src == "pattern" ? patternGreen : src == "model" ? modelPurple : hex(Style.graphite)
            let label = src.count > 14 ? "\(src.prefix(13))…" : src // protocol says pattern | model; never outgrow the card
            let t = run(label, f12, src == "model" ? modelPurpleText : c)
            let chip = CGRect(x: x0, y: L.chipY, width: width(t) + 18, height: L.chipH)
            capsule(chip, c.withAlphaComponent(0.22))
            draw(t, x: chip.minX + 9, base: base)
            var detail: [NSAttributedString] = []
            if src == "pattern" { detail.append(stat([("0", true), (" model calls", false)], size: 12)) }
            if let ms = hud.lastLatencyMs {
                if !detail.isEmpty { detail.append(stat([(" · ", false)], size: 12)) }
                detail.append(latency(ms, size: 12))
            }
            if !detail.isEmpty { draw(join(detail), x: chip.maxX + 8, base: base, maxW: x1 - chip.maxX - 8) }
        } else {
            draw(run("no prediction yet", .systemFont(ofSize: 12), disabled), x: x0, base: base)
        }

        let calls = hud.modelCalls ?? 0
        // "0/0 accepted" on a fresh start reads like an error: say what it means until the first ghost.
        let acc = (hud.shown ?? 0) == 0 ? run("none offered yet", .systemFont(ofSize: 11), disabled)
            : stat([("\(hud.accepted ?? 0)", true), ("/\(hud.shown ?? 0) accepted", false)])
        var total = stat([("\(calls)", true), (calls == 1 ? " model call so far" : " model calls so far", false)])
        if width(acc) + width(total) + 12 > x1 - x0 { total = stat([("\(calls)", true), (calls == 1 ? " model call" : " model calls", false)]) }
        draw(acc, x: x0, base: L.statBase, maxW: x1 - x0 - width(total) - 12)
        drawRight(total, right: x1, base: L.statBase)
    }

    /// Last payment and the ledger button. Green with a check for 3 s after a payment we saw happen.
    private func drawPaid() {
        let x0 = L.padH, x1 = lb.width - L.padH
        let bf = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let hasTx = hud.lastTx != nil
        let fresh = hasTx && (paidUntil ?? .distantPast) > Date()
        let bt = run("ledger ↗", bf, fresh ? paidGreen : hasTx ? primary : disabled)
        ledgerRect = CGRect(x: x1 - width(bt) - 16, y: L.paidY + 1, width: width(bt) + 16, height: L.paidH - 2)
        let fill = fresh ? paidGreen.withAlphaComponent(0.20) : NSColor.white.withAlphaComponent(hasTx ? 0.12 : 0.05)
        fill.setFill()
        NSBezierPath(roundedRect: ledgerRect, xRadius: 6, yRadius: 6).fill()
        let base = centred(L.paidY, L.paidH, bf)
        draw(bt, x: ledgerRect.minX + 8, base: base)

        let maxW = ledgerRect.minX - 8 - x0
        guard let tx = hud.lastTx else {
            return draw(run("no payments yet", .systemFont(ofSize: 11), disabled), x: x0, base: base)
        }
        let short = tx.hash.count > 12 ? "\(tx.hash.prefix(6))…\(tx.hash.suffix(4))" : tx.hash
        let line = join([
            run(fresh ? "✓ Paid " : "Paid ", .systemFont(ofSize: 11, weight: fresh ? .semibold : .medium), fresh ? paidGreen : primary),
            run("$\(tx.amountUsd)", mono(11, .semibold), fresh ? paidGreen : primary),
            run(" · \(short)", mono(11, .regular), fresh ? paidGreen.withAlphaComponent(0.85) : secondary),
        ])
        draw(line, x: x0, base: base, maxW: maxW)
    }

    /// High-contrast switch on the left (the hit target), mode dot and word on the right.
    private func drawFooter() {
        let x0 = L.padH, x1 = lb.width - L.padH
        let mf = NSFont.systemFont(ofSize: 11, weight: .medium)
        let base = centred(L.footY, L.footH, mf)

        // The mode names are the protocol's; "shown" reads as jargon on a projector, so a ghost on screen says what Tab is doing.
        let word = run(mode == "shown" ? "suggesting" : mode, mf, mode == "offline" ? primary : secondary)
        let wx = x1 - width(word)
        draw(word, x: wx, base: base)
        let dot = CGRect(x: wx - 6 - 7, y: L.footY + (L.footH - 7) / 2, width: 7, height: 7)
        modeColor().withAlphaComponent(dotAlpha).setFill()
        NSBezierPath(ovalIn: dot).fill()

        let track = CGRect(x: x0, y: L.footY + (L.footH - 14) / 2, width: 24, height: 14)
        capsule(track, highContrast ? hex(Style.yellow) : NSColor.white.withAlphaComponent(0.20))
        (highContrast ? hex(0x1C1C1E) : NSColor.white).setFill() // HC is black on yellow, the switch too
        NSBezierPath(ovalIn: CGRect(x: track.minX + (highContrast ? 11 : 1), y: track.minY + 1, width: 12, height: 12)).fill()
        draw(run("High contrast", mf, highContrast ? primary : secondary), x: track.maxX + 8, base: base)
        contrastRect = CGRect(x: 0, y: L.footY - 6, width: dot.minX - 8, height: lb.height - (L.footY - 6))
    }

    // MARK: mouse

    // Drag anywhere to move the panel; a click that moves less than 6 pt still hits ledger / high contrast.
    override func mouseDown(with e: NSEvent) {
        guard let w = window else { return }
        dragStart = (NSEvent.mouseLocation, w.frame.origin)
        dragged = false
    }

    override func mouseDragged(with e: NSEvent) {
        guard let w = window, let d = dragStart else { return }
        let m = NSEvent.mouseLocation
        if !dragged, hypot(m.x - d.mouse.x, m.y - d.mouse.y) < 6 { return }
        dragged = true
        w.setFrameOrigin(NSPoint(x: d.origin.x + m.x - d.mouse.x, y: d.origin.y + m.y - d.mouse.y))
    }

    override func mouseUp(with e: NSEvent) {
        defer { dragStart = nil }
        if dragged {
            onMoved?()
            return
        }
        let q = convert(e.locationInWindow, from: nil)
        let p = CGPoint(x: q.x / drawScale, y: q.y / drawScale)
        if revealOnly || (L.keyY + L.keyH...L.barY + L.barH + 4).contains(p.y) {
            onClick?("reveal") // the numbers: open (or, on the card, close) the end-of-demo reveal
        } else if ledgerRect.contains(p) {
            if hud.lastTx != nil { onClick?("ledger") }
        } else if contrastRect.contains(p) {
            onClick?("contrast")
        }
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
}
