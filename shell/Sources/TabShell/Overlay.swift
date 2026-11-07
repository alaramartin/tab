// The ghost overlay: one borderless, transparent, click-through window over the display that holds the ghost.
// Ghost views are flipped and their bounds start at that display's top-left in protocol points, so protocol
// (AX/top-left of the primary display) points are view points on any display.
// The ghost: highlight box, pill, cursor, inline text.
import AppKit

func hex(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: a)
}

/// Display geometry in protocol coordinates: top-left of the primary (menu bar) display, y down.
enum Screens {
    /// The primary display's frame. `NSScreen.screens` can be empty for a moment while displays reconfigure
    /// (a projector plugging in), so never force-unwrap it.
    static var primaryFrame: CGRect { NSScreen.screens.first?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900) }

    /// AppKit (bottom-left) global rect → protocol (top-left) rect.
    static func topLeft(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX, y: primaryFrame.height - r.maxY, width: r.width, height: r.height)
    }

    /// The display under protocol point `p`, else the primary.
    static func screen(at p: CGPoint) -> NSScreen? {
        NSScreen.screens.first { topLeft($0.frame).contains(p) } ?? NSScreen.screens.first
    }
}

struct Style {
    var hc: Bool
    var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    // Palette
    static let graphite: UInt32 = 0x8E8E93
    static let slate: UInt32 = 0x636366
    static let pay: UInt32 = 0x0052FF
    static let payHC: UInt32 = 0x0040D6
    static let blockFill: UInt32 = 0xD70015
    static let blockStroke: UInt32 = 0xFF3B30
    static let doneFill: UInt32 = 0x248A3D
    static let doneStroke: UInt32 = 0x34C759
    static let yellow: UInt32 = 0xFFD60A
    /// Suggestions (action/text) are bright red by default (human's call, 14:40: the graphite read as grey).
    static let suggest: UInt32 = 0xFF3B30
    static let blockDark: UInt32 = 0x2A0A0C // Blocked moves to a dark pill with a red edge, so it doesn't look like a suggestion

    private var k: CGFloat { hc ? 1.5 : 1 }

    // Box
    // Normal mode is a quiet outline that hugs the element (you notice it, it doesn't pop); HC stays loud on purpose.
    var boxOutset: CGFloat { hc ? 5 : 2 }
    /// The element's corner radius when the hub doesn't send one (an older web/hub).
    static let fallbackRadius: CGFloat = 6
    func boxStroke(_ kind: GhostKind) -> CGFloat { hc ? 4 : (kind == .action || kind == .text || kind == .blocked ? 2.5 : 1.5) }
    var hcRing: CGFloat { 1.5 }

    func boxColor(_ kind: GhostKind) -> NSColor {
        switch kind {
        case .action: return hc ? hex(Style.yellow) : hex(Style.suggest, 0.95)
        case .text: return hc ? hex(Style.yellow) : hex(Style.suggest, 0.85)
        case .pay: return hc ? hex(Style.yellow) : hex(Style.pay, 0.80)
        case .blocked: return hc ? hex(Style.blockStroke) : hex(Style.blockStroke, 0.90)
        case .done: return hc ? hex(Style.doneStroke) : hex(Style.doneStroke, 0.85)
        }
    }

    /// No tint on the element, except a faint red on Blocked (it's a warning).
    func boxFill(_ kind: GhostKind) -> NSColor? {
        kind == .blocked ? hex(Style.blockStroke, hc ? 0.12 : 0.06) : nil
    }

    // Pill
    var pillFont: NSFont { .systemFont(ofSize: 14 * k, weight: .semibold) }
    var pillTailFont: NSFont { .systemFont(ofSize: 14 * k, weight: .regular) }
    var pillH: CGFloat { 28 * k }
    var padL: CGFloat { 12 * k }
    var padR: CGFloat { 12 * k }
    var keyInset: CGFloat { 3 * k }
    var keyH: CGFloat { pillH - 2 * keyInset }
    var keyMinW: CGFloat { 1.5 * keyH }
    var keyPadH: CGFloat { 6 * k }
    var keyRadius: CGFloat { 5 * k }
    var keyFont: NSFont { .systemFont(ofSize: 12 * k, weight: .semibold) }
    var keyGap: CGFloat { 8 * k }
    var iconSize: CGFloat { 13 * k }
    var iconGap: CGFloat { 6 * k }
    var gap: CGFloat { hc ? 8 : 6 }
    var clamp: CGFloat { 4 }
    /// Longest label run before it truncates in the middle: a pill wider than this reads as a dialog, not a hint.
    var maxTextW: CGFloat { 460 * k }

    func pillFill(_ kind: GhostKind) -> NSColor {
        switch kind {
        case .action, .text: return hc ? .black : hex(Style.suggest)
        case .pay: return hc ? hex(Style.payHC) : hex(Style.pay)
        case .blocked: return hc ? hex(Style.blockFill) : hex(Style.blockDark)
        case .done: return hex(Style.doneFill)
        }
    }

    func pillText(_ kind: GhostKind) -> NSColor {
        (hc && (kind == .action || kind == .text)) ? hex(Style.yellow) : .white
    }

    /// (color, width) of the inner border: a hairline in normal mode, 2 pt in HC.
    func pillBorder(_ kind: GhostKind) -> (NSColor, CGFloat) {
        // Pay gets a stronger hairline: Base blue must keep an edge on blue pages (C's tickets site is royal blue).
        if !hc { return kind == .blocked ? (hex(Style.blockStroke), 2) : (NSColor.white.withAlphaComponent(kind == .pay ? 0.55 : 0.30), 1) }
        switch kind {
        case .action, .text, .pay: return (hex(Style.yellow), 2)
        case .blocked, .done: return (.white, 2)
        }
    }

    func keyFill(_ kind: GhostKind) -> NSColor {
        if hc { return kind == .blocked ? .white : hex(Style.yellow) }
        return NSColor.white.withAlphaComponent(kind == .pay || kind == .blocked ? 0.22 : 0.20)
    }

    var keyText: NSColor { hc ? .black : .white }
    /// Hold-progress sweep fill and the label colour over it.
    var holdFill: NSColor { hc ? .black : .white }
    var holdText: NSColor { hc ? hex(Style.yellow) : hex(Style.suggest) }

    var shadow: NSShadow? {
        if hc { return nil }
        let s = NSShadow()
        s.shadowColor = NSColor.black.withAlphaComponent(0.22)
        s.shadowBlurRadius = 8
        s.shadowOffset = NSSize(width: 0, height: -2)
        return s
    }

    // Motion (ms)
    var appearMs: Double { 140 }
    var appearRise: CGFloat { reduceMotion ? 0 : 4 }
    var pressMs: Double { 60 }
    var acceptFadeMs: Double { 120 }
    var dismissMs: Double { 100 }
    var doneFadeMs: Double { 220 }
    var shakeMs: Double { 320 }
    var holdHiddenMs: Double { 150 }
}

/// What the pill says, parsed from the protocol label.
struct PillContent {
    enum Icon { case none, block, check, repeat_, spinner }
    var head: String
    var tail: String? // drawn as " · tail"
    var key: String? // "tab" | "esc"
    var icon: Icon

    init(_ g: Ghost) {
        // One line, always: labels can carry error text from the hub (e.g. a multi-line wallet error in "Blocked · …").
        var label = g.label.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        var hadTab = false
        if label.hasSuffix("⇥") { hadTab = true; label = String(label.dropLast()).trimmingCharacters(in: .whitespaces) }
        icon = .none
        if g.kind == .done, label.hasSuffix("✓") { label = String(label.dropLast()).trimmingCharacters(in: .whitespaces) }
        if g.kind == .done { icon = .check }
        if g.kind == .blocked { icon = .block }
        // The pattern rule's ghosts (PLAN pill formats) get a loop: "teach once, then repeat" at a glance. "Do all " is a
        // saved workflow recalled on a later visit (B's `PatternEngine.recall`): the same unit, so the same loop.
        if g.kind == .action, ["Repeat for ", "Do the remaining ", "Do all "].contains(where: label.hasPrefix) { icon = .repeat_ }
        // Overlay's own state after Tab on a pay ghost (not a hub label): a spinner in the icon slot, and no keycap.
        if g.kind == .pay, label.hasPrefix("Paying") { icon = .spinner }
        key = g.kind == .blocked ? "esc" : g.kind == .done ? nil : (hadTab ? "tab" : nil)
        if let r = label.range(of: " · ") {
            head = String(label[..<r.lowerBound])
            tail = String(label[r.upperBound...])
        } else {
            head = label
            tail = nil
        }
    }

    var keyOnly: Bool { head.isEmpty && tail == nil && icon == .none && key != nil }
}

/// The pill: capsule, optional icon, two-weight label, keycap. Its frame includes a margin for the shadow.
final class PillView: NSView {
    static let margin: CGFloat = 12
    let kind: GhostKind
    let style: Style
    let content: PillContent
    let size: CGSize
    var pressed = false { didSet { needsDisplay = true } }
    var holdFraction: CGFloat? { didSet { needsDisplay = true } }
    var borderAlpha: CGFloat = 1 { didSet { needsDisplay = true } }
    /// Spinner phase, 0…1 per turn.
    var spin: CGFloat = 0 { didSet { needsDisplay = true } }

    /// The head didn't fit and was cut in the middle.
    private(set) var headCut = false
    private var textAttr: NSAttributedString?
    private var keyW: CGFloat = 0

    /// `maxW` caps the pill (the usable screen width); long labels truncate in the middle so both ends stay readable.
    init(ghost: Ghost, style: Style, maxW: CGFloat = .greatestFiniteMagnitude) {
        kind = ghost.kind
        self.style = style
        content = PillContent(ghost)
        let textColor = style.pillText(ghost.kind)
        var w: CGFloat
        var attr: NSAttributedString?
        var kw: CGFloat = 0
        var cut = false
        if let key = content.key {
            let tw = (key as NSString).size(withAttributes: [.font: style.keyFont]).width
            kw = max(style.keyMinW, ceil(tw) + 2 * style.keyPadH)
        }
        if !content.keyOnly {
            var chrome = style.padL + (content.icon != .none ? style.iconSize + style.iconGap : 0)
            chrome += content.key != nil ? style.keyGap + kw + style.keyInset : style.padR
            let room = max(80, min(style.maxTextW, maxW - chrome))
            let headAttrs: [NSAttributedString.Key: Any] = [.font: style.pillFont, .foregroundColor: textColor]
            let tailAttrs: [NSAttributedString.Key: Any] = [.font: style.pillTailFont, .foregroundColor: textColor.withAlphaComponent(0.82)]
            var head = content.head
            var tail = content.tail.map { " · \($0)" } ?? ""
            let headW = (head as NSString).size(withAttributes: headAttrs).width
            let tailW = (tail as NSString).size(withAttributes: tailAttrs).width
            if headW + tailW > room {
                // The tail gives way first: the head names the action ("Blocked · page says…", "Do all 6 from v1.4.0
                // · learned…"). Only a head with no room for a few tail characters truncates, in the middle and to at
                // most 60%, so both ends stay readable ("Type "Thanks…rebuilds" into Comment").
                let minTail = min(tailW, (" · ab…" as NSString).size(withAttributes: tailAttrs).width)
                let headRoom = headW + minTail <= room ? headW : max(room - tailW, min(headW, room * 0.6))
                head = PillView.fit(head, headRoom, headAttrs, .byTruncatingMiddle)
                cut = head != content.head
                tail = PillView.fit(tail, room - (head as NSString).size(withAttributes: headAttrs).width, tailAttrs, .byTruncatingTail)
            }
            let a = NSMutableAttributedString(string: head, attributes: headAttrs)
            if !tail.isEmpty { a.append(NSAttributedString(string: tail, attributes: tailAttrs)) }
            attr = a
        }
        if content.keyOnly {
            w = kw + 2 * style.keyInset
        } else {
            w = style.padL
            if content.icon != .none { w += style.iconSize + style.iconGap }
            w += ceil(attr?.size().width ?? 0)
            w += content.key != nil ? style.keyGap + kw + style.keyInset : style.padR
        }
        size = CGSize(width: w, height: style.pillH)
        textAttr = attr
        keyW = kw
        headCut = cut
        super.init(frame: CGRect(origin: .zero, size: CGSize(width: w + 2 * PillView.margin, height: style.pillH + 2 * PillView.margin)))
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    /// `s` shortened with an ellipsis until it fits `w` points (binary search on the character count).
    static func fit(_ s: String, _ w: CGFloat, _ attrs: [NSAttributedString.Key: Any], _ mode: NSLineBreakMode) -> String {
        func width(_ t: String) -> CGFloat { (t as NSString).size(withAttributes: attrs).width }
        guard width(s) > w else { return s }
        let chars = Array(s)
        // Trim only at the cut, so a leading " · " survives.
        func trimEnd(_ t: [Character]) -> String { String(t.reversed().drop { $0 == " " }.reversed()) }
        func trimStart(_ t: [Character]) -> String { String(t.drop { $0 == " " }) }
        func cut(_ n: Int) -> String {
            if mode == .byTruncatingMiddle {
                let head = (n + 1) / 2
                return trimEnd(Array(chars.prefix(head))) + "…" + trimStart(Array(chars.suffix(n - head)))
            }
            // At a word boundary when one is in reach ("· learned…", not "· learned 10:…"): it keeps ≥ 2/3 of the
            // cut, and index > 2 skips a leading " · " (a long URL or hash still cuts mid-word).
            var m = n
            if m < chars.count, chars[m] != " ", let sp = chars[..<m].lastIndex(of: " "), sp > 2, 3 * sp >= 2 * n { m = sp }
            return trimEnd(Array(chars.prefix(m))) + "…"
        }
        var lo = 0, hi = chars.count
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if width(cut(mid)) <= w { lo = mid } else { hi = mid - 1 }
        }
        return cut(lo)
    }

    /// Place the pill (not the margin) with its top-left at `p`.
    func place(at p: CGPoint) { setFrameOrigin(CGPoint(x: p.x - PillView.margin, y: p.y - PillView.margin)) }

    override func draw(_ dirty: NSRect) {
        let r = CGRect(x: PillView.margin, y: PillView.margin, width: size.width, height: size.height)
        let capsule = NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2)

        NSGraphicsContext.saveGraphicsState()
        style.shadow?.set()
        style.pillFill(kind).setFill()
        capsule.fill()
        NSGraphicsContext.restoreGraphicsState()

        // Inner border: stroke a path inset by half the width so it stays inside the capsule.
        // A key-only pill (text ghosts) skips it in HC: the yellow key is the edge, a second ring reads as brackets.
        let (bc, bw) = (style.hc && content.keyOnly) ? (NSColor.clear, 0) : style.pillBorder(kind)
        let ib = r.insetBy(dx: bw / 2, dy: bw / 2)
        let border = NSBezierPath(roundedRect: ib, xRadius: ib.height / 2, yRadius: ib.height / 2)
        border.lineWidth = bw
        bc.withAlphaComponent(bc.alphaComponent * borderAlpha).setStroke()
        border.stroke()

        var x = r.minX + (content.keyOnly ? style.keyInset : style.padL)
        let textColor = style.pillText(kind)
        if content.icon != .none {
            drawIcon(content.icon, in: CGRect(x: x, y: r.midY - style.iconSize / 2, width: style.iconSize, height: style.iconSize), color: textColor)
            x += style.iconSize + style.iconGap
        }
        if let t = textAttr {
            let ts = t.size()
            t.draw(at: CGPoint(x: x, y: r.midY - ts.height / 2))
        }
        if let key = content.key {
            let kr = CGRect(x: r.maxX - style.keyInset - keyW, y: r.minY + style.keyInset, width: keyW, height: style.keyH)
            drawKey(key, in: kr)
        }
    }

    private func drawKey(_ key: String, in kr: CGRect) {
        let path = NSBezierPath(roundedRect: kr, xRadius: style.keyRadius, yRadius: style.keyRadius)
        style.keyFill(kind).setFill()
        path.fill()
        // Key edge: a 1 pt darker band along the bottom so it reads as a physical key (none while pressed).
        if !pressed {
            NSGraphicsContext.saveGraphicsState()
            path.addClip()
            NSColor.black.withAlphaComponent(style.hc ? 0.22 : 0.18).setFill()
            CGRect(x: kr.minX, y: kr.maxY - 1.5 * (style.hc ? 1.5 : 1), width: kr.width, height: 1.5 * (style.hc ? 1.5 : 1)).fill()
            NSGraphicsContext.restoreGraphicsState()
        }
        if pressed {
            (style.hc ? NSColor.black.withAlphaComponent(0.25) : NSColor.white.withAlphaComponent(0.45)).setFill()
            path.fill()
        }
        let ts = (key as NSString).size(withAttributes: [.font: style.keyFont])
        let tp = CGPoint(x: kr.midX - ts.width / 2, y: kr.midY - ts.height / 2)
        let f = min(1, max(0, holdFraction ?? 0))
        let split = kr.minX + kr.width * f
        // Unfilled part.
        NSGraphicsContext.saveGraphicsState()
        CGRect(x: split, y: kr.minY, width: kr.maxX - split, height: kr.height).clip()
        (key as NSString).draw(at: tp, withAttributes: [.font: style.keyFont, .foregroundColor: style.keyText])
        NSGraphicsContext.restoreGraphicsState()
        guard f > 0 else { return }
        // Filled part: the sweep, and the label in the contrasting colour over it.
        NSGraphicsContext.saveGraphicsState()
        path.addClip()
        CGRect(x: kr.minX, y: kr.minY, width: split - kr.minX, height: kr.height).clip()
        style.holdFill.setFill()
        kr.fill()
        (key as NSString).draw(at: tp, withAttributes: [.font: style.keyFont, .foregroundColor: style.holdText])
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawIcon(_ icon: PillContent.Icon, in r: CGRect, color: NSColor) {
        // 12-unit viewBox, y down.
        let s = r.width / 12
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * s, y: r.minY + y * s) }
        let path = NSBezierPath()
        switch icon {
        case .block:
            path.appendOval(in: CGRect(x: r.minX + (6 - 4.9) * s, y: r.minY + (6 - 4.9) * s, width: 9.8 * s, height: 9.8 * s))
            path.move(to: p(2.6, 9.4))
            path.line(to: p(9.4, 2.6))
            path.lineWidth = 1.6 * s
        case .check:
            path.move(to: p(2.2, 6.4))
            path.line(to: p(4.9, 9))
            path.line(to: p(9.8, 3.2))
            path.lineWidth = 1.8 * s
        case .repeat_:
            // ↻: a clockwise arc (r 4.3 at 6,6; y down, so increasing angle is clockwise) from 1 o'clock round to
            // 12 o'clock, with a chevron at 12 pointing right, into the gap. Sampled, so the flipped view can't reverse it.
            let r = 4.3
            let pts = (0...24).map { i -> CGPoint in
                let a = (-50.0 + 310.0 * Double(i) / 24) * .pi / 180
                return p(6 + r * cos(a), 6 + r * sin(a))
            }
            path.move(to: pts[0])
            for q in pts.dropFirst() { path.line(to: q) }
            let e = pts.last!
            path.move(to: CGPoint(x: e.x - 2.1 * s, y: e.y - 1.8 * s))
            path.line(to: CGPoint(x: e.x + 0.3 * s, y: e.y))
            path.line(to: CGPoint(x: e.x - 2.1 * s, y: e.y + 1.8 * s))
            path.lineWidth = 1.6 * s
        case .spinner:
            // A faint ring with a bright quarter arc running round it.
            let ring = NSBezierPath(ovalIn: CGRect(x: r.minX + 1.4 * s, y: r.minY + 1.4 * s, width: 9.2 * s, height: 9.2 * s))
            ring.lineWidth = 1.6 * s
            color.withAlphaComponent(0.3).setStroke()
            ring.stroke()
            let a0 = Double(spin) * 2 * .pi
            let pts = (0...12).map { i -> CGPoint in
                let a = a0 + .pi / 2 * Double(i) / 12
                return p(6 + 4.6 * cos(a), 6 + 4.6 * sin(a))
            }
            path.move(to: pts[0])
            for q in pts.dropFirst() { path.line(to: q) }
            path.lineWidth = 1.6 * s
        case .none: return
        }
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        color.setStroke()
        path.stroke()
    }
}

/// One ghost: box, field cover + ghost text, cursor (drawn here) and the pill (a subview).
final class GhostView: NSView {
    let ghost: Ghost
    let style: Style
    let pill: PillView
    private(set) var pillRect: CGRect = .zero
    /// The pill sits inside the element (explicit `inside`, or chosen from `avoid`): then no cursor, it would hide under it.
    private var docked = false
    /// `inside` was asked for, but the field is too narrow for the label's head: placed like any other pill instead.
    private let insideDeclined: Bool
    private let usable: CGRect // top-left coords, below the menu bar

    init(ghost: Ghost, style: Style, frame: CGRect, usable: CGRect) {
        self.ghost = ghost
        self.style = style
        self.usable = usable
        let cap = GhostView.pillCap(ghost, style, usable)
        let inField = PillView(ghost: ghost, style: style, maxW: cap)
        // "Do a….4.0 · lear…" docked in a 200 pt field says nothing, and a pill wider than its field (the label room
        // never drops below 80 pt) spills out of it; below the field (or wherever `avoid` allows) it reads whole.
        insideDeclined = ghost.place == "inside" && (inField.headCut || inField.size.width > cap)
        pill = insideDeclined ? PillView(ghost: ghost, style: style, maxW: usable.width - 2 * style.clamp) : inField
        super.init(frame: frame)
        wantsLayer = true
        pillRect = layoutPill()
        pill.place(at: pillRect.origin)
        addSubview(pill)
    }

    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    // MARK: layout

    /// Textareas only: real single-line inputs run up to ~56 pt tall (C's pharmacy field is 46).
    private var isMultiline: Bool { (ghost.rect?.h ?? 0) >= 64 }

    private var ghostTextFont: NSFont {
        if ghost.kind == .text, let c = ghost.caret { return .systemFont(ofSize: min(22, max(11, c.h * 0.8))) }
        guard let r = ghost.rect, !isMultiline else { return .systemFont(ofSize: 14) }
        return .systemFont(ofSize: min(20, max(12, r.h * 0.42)))
    }

    /// Where an accept ripple starts: the box, or the pill for ghosts without a rect.
    var rippleRect: CGRect { boxRect() ?? pillRect }

    private func boxRect() -> CGRect? {
        guard let r = ghost.rect else { return nil }
        let o = style.boxOutset
        return CGRect(x: r.x - o, y: r.y - o, width: r.w + 2 * o, height: r.h + 2 * o)
    }

    /// The element's own corner radius (from the page's CSS), capped at a capsule.
    private var elementRadius: CGFloat {
        let r = ghost.rect.map { CGFloat(min($0.w, $0.h)) / 2 } ?? .greatestFiniteMagnitude
        return min(ghost.radius.map { CGFloat($0) } ?? Style.fallbackRadius, r)
    }

    /// The box's corner radius: concentric with the element's (its radius + the outset), so square buttons get a square
    /// box, rounded ones a rounded box and capsules a capsule.
    var boxCorner: CGFloat {
        guard let b = boxRect() else { return pillRect.height / 2 } // no rect: the ripple leaves the capsule pill
        return min(elementRadius + style.boxOutset, b.height / 2, b.width / 2)
    }

    private func layoutPill() -> CGRect {
        let size = pill.size
        var p: CGPoint
        if ghost.kind == .text, let c = ghost.caret {
            // Completion: the pill follows the gray text on the same line.
            let tw = ((ghost.ghostText ?? "") as NSString).size(withAttributes: [.font: ghostTextFont]).width
            p = CGPoint(x: c.x + c.w + 1 + ceil(tw) + 6, y: c.y + (c.h - size.height) / 2)
            if p.x + size.width > usable.maxX - style.clamp { p = CGPoint(x: c.x, y: c.y + c.h + style.gap) }
        } else if ghost.kind == .text, let r = ghost.rect {
            if isMultiline {
                p = CGPoint(x: r.x + r.w - size.width - 8, y: r.y + r.h - size.height - 8)
            } else {
                let tw = ((ghost.ghostText ?? "") as NSString).size(withAttributes: [.font: ghostTextFont]).width
                let x = r.x + 8 + ceil(tw) + 6
                let right = CGPoint(x: r.x + r.w + style.gap + style.boxOutset, y: r.y + (r.h - size.height) / 2)
                if x + size.width <= r.x + r.w - 4 {
                    p = CGPoint(x: x, y: r.y + (r.h - size.height) / 2)
                } else if right.x + size.width <= usable.maxX - style.clamp {
                    p = right
                } else {
                    // No room inline or to the right (a narrow field at the screen edge): below the box, so the
                    // pill never sits on top of the ghost text.
                    let o = style.boxOutset
                    p = CGPoint(x: r.x + r.w + o - size.width, y: r.y + r.h + o + style.gap)
                    if p.y + size.height > usable.maxY - style.clamp { p.y = r.y - o - style.gap - size.height }
                }
            }
        } else if let b = boxRect(), let r = ghost.rect {
            let above = CGPoint(x: b.minX, y: b.minY - style.gap - size.height)
            let right = CGPoint(x: b.maxX + style.gap, y: b.midY - size.height / 2)
            switch insideDeclined ? nil : ghost.place {
            case "above" where above.y >= usable.minY + style.clamp:
                p = above
            case "right" where right.x + size.width <= usable.maxX - style.clamp:
                p = right
            case "inside":
                p = inside(r, size)
                docked = true
            // Not for pay/blocked: they end the flow, and what sits above their button is the amount they quote (Total,
            // Copay). Scored, the HC Blocked pill docked inside resale's Buy button, hiding it; below covers fine print.
            case nil where !(ghost.avoid ?? []).isEmpty && ghost.kind != .pay && ghost.kind != .blocked:
                p = leastCovering(b, r, size, above: above, right: right)
                docked = p == inside(r, size)
            default:
                p = CGPoint(x: b.minX, y: b.maxY + style.gap)
                if p.y + size.height > usable.maxY - style.clamp { p.y = above.y }
                // Neither fits (the element fills the screen, e.g. a whole card or editor): dock inside its visible bottom-left.
                if p.y < usable.minY + style.clamp {
                    let vis = b.intersection(usable)
                    if !vis.isNull { p = CGPoint(x: vis.minX + 8, y: vis.maxY - size.height - 8) }
                }
            }
        } else if let a = ghost.pillAt {
            p = CGPoint(x: a.x, y: a.y - size.height) // pillAt = the pill's bottom-left corner
        } else {
            p = CGPoint(x: usable.midX - size.width / 2, y: usable.minY + 40)
        }
        p.x = min(max(p.x, usable.minX + style.clamp), usable.maxX - size.width - style.clamp)
        p.y = min(max(p.y, usable.minY + style.clamp), usable.maxY - size.height - style.clamp)
        return CGRect(origin: p, size: size)
    }

    /// The pill's widest: the usable screen, and for an explicit `inside` the field itself, so a long label gives way
    /// (tail first) instead of spilling past the field's edges ("Do all 6 from v1.4.0 · learned…" in HC on the
    /// tracker's 425 pt search box).
    static func pillCap(_ g: Ghost, _ style: Style, _ usable: CGRect) -> CGFloat {
        let screen = usable.width - 2 * style.clamp
        guard g.place == "inside", g.kind != .text, let r = g.rect else { return screen }
        return min(screen, r.w - 2 * insideInset(r, style.pillH))
    }

    private static func insideInset(_ r: Rect, _ pillH: CGFloat) -> CGFloat { max(4, (r.h - pillH) / 2) }

    /// Docked at the element's right end like a badge, equal space right and top/bottom.
    private func inside(_ r: Rect, _ size: CGSize) -> CGPoint {
        let inset = GhostView.insideInset(r, size.height)
        return CGPoint(x: r.x + r.w - size.width - inset, y: r.y + (r.h - size.height) / 2)
    }

    /// With `avoid` and no explicit `place`: the first of below, above, right, inside (fields wide enough for it) whose
    /// pill fits on screen and covers none of the nearby elements; if all cover something, the one that covers least.
    /// Forms flow downward, so what's below the target is probably the next step: covering it costs 3×, covering a
    /// finished step above costs 1×. Right reads a little worse than above/below (1.2×).
    private func leastCovering(_ b: CGRect, _ r: Rect, _ size: CGSize, above: CGPoint, right: CGPoint) -> CGPoint {
        let target = CGRect(x: r.x, y: r.y, width: r.w, height: r.h)
        // Containers of the target (a label wrapping a checkbox) aren't obstacles.
        let others = (ghost.avoid ?? []).map { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) }
            .filter { !$0.contains(CGPoint(x: target.midX, y: target.midY)) }
        var cands = [CGPoint(x: b.minX, y: b.maxY + style.gap), above, right]
        if r.w >= size.width + 24 { cands.append(inside(r, size)) }
        let onScreen = usable.insetBy(dx: style.clamp, dy: style.clamp)
        func covered(_ p: CGPoint) -> CGFloat {
            let pr = CGRect(origin: p, size: size).insetBy(dx: -2, dy: -2)
            let area = others.reduce(0) { acc, o in
                let i = pr.intersection(o)
                return acc + (i.isNull ? 0 : i.width * i.height * (o.midY > target.maxY ? 3 : 1))
            }
            return p == right ? area * 1.2 : area
        }
        let fitting = cands.filter { onScreen.contains(CGRect(origin: $0, size: size)) }
        if debugEnabled {
            log("place \(ghost.id): " + cands.map { "\(Int($0.x)),\(Int($0.y)) fits=\(fitting.contains($0)) cost=\(Int(covered($0)))" }.joined(separator: " | "))
        }
        return fitting.min { covered($0) < covered($1) } ?? cands[0] // min keeps the first of equals: below wins ties
    }

    /// The cursor tip, from the rect (lower-right quadrant, clear of centred labels). Only action ghosts with a cursor.
    private func cursorTip() -> CGPoint? {
        // No cursor under a docked pill: the badge already points at the element.
        guard ghost.kind == .action, ghost.cursor != nil, !docked, let r = ghost.rect else { return nil }
        // Tall targets (cards, editors): stay near the top, where the label usually is, not mid-air.
        if r.w >= 48 { return CGPoint(x: min(r.x + 0.78 * r.w, r.x + r.w - 14), y: r.y + min(0.62 * r.h, 40)) }
        return CGPoint(x: r.x + 0.6 * r.w, y: r.y + 0.6 * r.h)
    }

    // MARK: drawing

    /// Completion: the field already holds what the user typed; draw only the rest, at the insertion point.
    private var completion: CGRect? {
        guard ghost.kind == .text, let c = ghost.caret else { return nil }
        return CGRect(x: c.x, y: c.y, width: c.w, height: c.h)
    }

    private func drawCompletion(at c: CGRect) {
        guard let gt = ghost.ghostText, !gt.isEmpty else { return }
        let font = ghostTextFont
        var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: style.hc ? NSColor.black : hex(Style.graphite)]
        if style.hc { attrs[.backgroundColor] = hex(Style.yellow) }
        let size = (gt as NSString).size(withAttributes: attrs)
        (gt as NSString).draw(at: CGPoint(x: c.maxX + 1, y: c.midY - size.height / 2), withAttributes: attrs)
    }

    override func draw(_ dirty: NSRect) {
        let k = ghost.kind
        if let c = completion {
            drawCompletion(at: c)
            return
        }
        if let b = boxRect() {
            let sw = style.boxStroke(k)
            let path = NSBezierPath(roundedRect: b, xRadius: boxCorner, yRadius: boxCorner)
            if let fill = style.boxFill(k) { fill.setFill(); path.fill() }
            if style.hc {
                path.lineWidth = sw + 2 * style.hcRing
                NSColor.black.setStroke()
                path.stroke()
            }
            path.lineWidth = sw
            style.boxColor(k).setStroke()
            path.stroke()
        }

        if k == .text, let r = ghost.rect { drawGhostText(in: CGRect(x: r.x, y: r.y, width: r.w, height: r.h)) }
        if let tip = cursorTip() { drawCursor(at: tip) }
    }

    private func drawGhostText(in r: CGRect) {
        // Field cover: Tab brings its own paper, so the text reads on any field and hides the page placeholder.
        NSColor.white.setFill()
        let cr = max(0, elementRadius - 1.5) // inside the field's own corners
        NSBezierPath(roundedRect: r.insetBy(dx: 1.5, dy: 1.5), xRadius: cr, yRadius: cr).fill()
        guard let gt = ghost.ghostText, !gt.isEmpty else { return }
        let font = ghostTextFont
        let para = NSMutableParagraphStyle()
        var attrs: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: para,
                                                    .foregroundColor: style.hc ? NSColor.black : hex(Style.graphite)]
        if style.hc { attrs[.backgroundColor] = hex(Style.yellow) }
        if isMultiline {
            para.lineBreakMode = .byWordWrapping
            para.minimumLineHeight = 20.3
            para.maximumLineHeight = 20.3
            // Leave the bottom-right corner to the pill.
            (gt as NSString).draw(with: CGRect(x: r.minX + 8, y: r.minY + 8, width: r.width - 16, height: max(20.3, r.height - 16 - pill.size.height)),
                                  options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
        } else {
            para.lineBreakMode = .byTruncatingTail
            let lh = ceil(font.pointSize * 1.2)
            para.minimumLineHeight = lh
            para.maximumLineHeight = lh
            let inline = pillRect.minX > r.minX && pillRect.minX < r.maxX
            let maxW = inline ? pillRect.minX - 6 - (r.minX + 8) + 6 : r.width - 16
            (gt as NSString).draw(with: CGRect(x: r.minX + 8, y: r.midY - lh / 2, width: maxW, height: lh),
                                  options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
        }
    }

    private func drawCursor(at p: CGPoint) {
        let s: CGFloat = style.hc ? 1.4 : 1.0
        let pts: [CGPoint] = [(0, 0), (0, 17), (4.2, 13.2), (7.0, 19.6), (9.6, 18.5), (6.9, 12.2), (12.2, 12.2)]
            .map { CGPoint(x: p.x + $0.0 * s, y: p.y + $0.1 * s) }
        let path = NSBezierPath()
        path.move(to: pts[0])
        for q in pts.dropFirst() { path.line(to: q) }
        path.close()
        path.lineJoinStyle = .round
        NSGraphicsContext.saveGraphicsState()
        let sh = NSShadow()
        sh.shadowColor = NSColor.black.withAlphaComponent(0.30)
        sh.shadowBlurRadius = 3
        sh.shadowOffset = NSSize(width: 0, height: -1)
        sh.set()
        (style.hc ? hex(Style.yellow) : hex(Style.suggest)).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        (style.hc ? NSColor.black : NSColor.white.withAlphaComponent(0.95)).setStroke()
        path.lineWidth = style.hc ? 1.5 : 1.2
        path.stroke()
    }
}

final class Overlay {
    enum Exit { case accept, dismiss, done }

    private let window: NSWindow
    private let root: NSView
    private var views: [String: GhostView] = [:]
    private var hideTimers: [String: DispatchWorkItem] = [:]
    private var holdTimer: Timer?
    var highContrast: Bool
    private(set) var current: Ghost?
    /// After Tab on a pay ghost: "Paying $0.30 · tickets.localhost" with a spinner, until the hub's next ghost (Paid ✓
    /// or Blocked), a hide, or `payingTimeout`. The hub sends nothing while the payment settles (9.6 s on venue wifi),
    /// and a blank screen at the moment money moves reads as a hang. Not `current`: Tab and Esc pass through meanwhile.
    private var paying: (ghost: Ghost, appear: DispatchWorkItem, timeout: DispatchWorkItem, spin: Timer)?
    static var payingTimeout: Double = 45
    var isPaying: Bool { paying != nil }

    /// The covered display's frame and visible frame (below the menu bar, above the Dock), in protocol points.
    private var screenTL: CGRect = .zero
    private var usable: CGRect = .zero

    init(highContrast: Bool) {
        self.highContrast = highContrast
        let f = Screens.primaryFrame
        window = NSWindow(contentRect: f, styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        // One above the HUD (.statusBar): a ghost is never hidden under the HUD panel.
        window.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        window.isReleasedWhenClosed = false
        root = FlippedView(frame: CGRect(origin: .zero, size: f.size))
        root.wantsLayer = true
        window.contentView = root
        cover(NSScreen.screens.first)
        window.orderFrontRegardless()
        // A projector plugging in, mirroring, or a resolution change moves and resizes displays under us.
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.screenTL = .zero // force a re-frame
            if let g = self.current ?? self.paying?.ghost { self.cover(self.screen(for: g)); self.redraw() } else { self.cover(NSScreen.screens.first) }
        }
    }

    private var style: Style { Style(hc: highContrast) }

    /// The display a ghost belongs on: the one under its rect's centre or its pill anchor.
    private func screen(for g: Ghost) -> NSScreen? {
        if let r = g.rect { return Screens.screen(at: CGPoint(x: r.x + r.w / 2, y: r.y + r.h / 2)) }
        if let a = g.pillAt { return Screens.screen(at: CGPoint(x: a.x, y: a.y - 1)) }
        return NSScreen.screens.first
    }

    /// Move the window over `s` (no-op if it's already there).
    private func cover(_ s: NSScreen?) {
        let f = s?.frame ?? Screens.primaryFrame
        let tl = Screens.topLeft(f)
        usable = s.map { Screens.topLeft($0.visibleFrame) } ?? tl
        guard tl != screenTL else { return }
        screenTL = tl
        // Leftovers laid out for the old display (an accepted ghost's fade, its ripple) would draw at the wrong place
        // on the new one for up to 320 ms: drop them. Live ghosts are re-added by the caller.
        let live = Set(views.values.map(ObjectIdentifier.init))
        for sub in root.subviews where !live.contains(ObjectIdentifier(sub)) { sub.removeFromSuperview() }
        window.setFrame(f, display: false)
        root.frame = CGRect(origin: .zero, size: f.size)
    }

    /// Show the single live ghost (replaces any other).
    func show(_ g: Ghost) {
        if let cur = current, cur == g, views[g.id] != nil { return }
        endPaying()
        let sameId = current?.id == g.id
        for id in Array(views.keys) { remove(id, exit: nil) }
        current = g
        add(g, animated: !sameId) // a rect update for the same ghost moves without re-animating
        if let ttl = g.ttlMs {
            let w = DispatchWorkItem { [weak self] in
                guard let self, self.current?.id == g.id else { return }
                self.hide(.done)
            }
            hideTimers[g.id] = w
            DispatchQueue.main.asyncAfter(deadline: .now() + ttl / 1000, execute: w)
        }
    }

    /// Selftest: draw many at once, each with its own contrast mode.
    func showAll(_ gs: [(Ghost, Bool)]) {
        endPaying()
        for id in Array(views.keys) { remove(id, exit: nil) }
        for (g, hc) in gs { add(g, animated: false, hc: hc) }
    }

    func hide(_ exit: Exit = .dismiss) {
        endPaying(fade: true) // a ghost_hide or a hub disconnect ends "Paying…" too
        guard let cur = current else { return }
        current = nil
        stopHold()
        remove(cur.id, exit: exit)
        if exit == .accept, cur.kind == .pay { startPaying(cur) }
    }

    func redraw() {
        let payingShown = paying.map { views[$0.ghost.id] != nil } ?? false
        guard current != nil || payingShown else { return }
        for id in Array(views.keys) { remove(id, exit: nil) }
        if let cur = current { add(cur, animated: false) }
        if payingShown, let p = paying { add(p.ghost, animated: false) }
    }

    private func startPaying(_ g: Ghost) {
        var p = g
        p.id = g.id + "-paying"
        let rest = g.label.replacingOccurrences(of: "⇥", with: "").trimmingCharacters(in: .whitespaces)
        p.label = rest.hasPrefix("Pay ") ? "Paying " + rest.dropFirst(4) : "Paying…"
        let st = style
        let appear = DispatchWorkItem { [weak self] in self?.add(p, animated: true) }
        let timeout = DispatchWorkItem { [weak self] in self?.endPaying(fade: true) }
        let t0 = CACurrentMediaTime()
        let spin = Overlay.onCommonModes(Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            guard !st.reduceMotion, let v = self?.views[p.id] else { return }
            v.pill.spin = CGFloat(((CACurrentMediaTime() - t0) / 0.9).truncatingRemainder(dividingBy: 1)) // a turn per 0.9 s
        })
        paying = (p, appear, timeout, spin)
        // After the accept press and fade (60 + 120 ms), so it reads as the same pill changing state.
        DispatchQueue.main.asyncAfter(deadline: .now() + (st.pressMs + st.acceptFadeMs) / 1000, execute: appear)
        DispatchQueue.main.asyncAfter(deadline: .now() + Overlay.payingTimeout, execute: timeout)
    }

    private func endPaying(fade: Bool = false) {
        guard let p = paying else { return }
        paying = nil
        p.appear.cancel()
        p.timeout.cancel()
        p.spin.invalidate()
        remove(p.ghost.id, exit: fade ? .dismiss : nil)
    }

    func shake() {
        guard let cur = current, let v = views[cur.id] else { return }
        if style.reduceMotion {
            // Border alpha 1 → .4 → 1 over the shake's 320 ms, no movement.
            let p = v.pill
            let t0 = CACurrentMediaTime()
            let ms = style.shakeMs
            Overlay.onCommonModes(Timer(timeInterval: 1.0 / 60, repeats: true) { t in
                let f = min(1, (CACurrentMediaTime() - t0) * 1000 / ms)
                p.borderAlpha = 1 - 0.6 * CGFloat(sin(f * .pi))
                if f >= 1 { p.borderAlpha = 1; t.invalidate() }
            })
            return
        }
        let a = CAKeyframeAnimation(keyPath: "transform.translation.x")
        a.values = [0, -7, 7, -5, 5, -2, 0]
        a.duration = style.shakeMs / 1000
        v.layer?.add(a, forKey: "shake")
    }

    /// Tab is down on the current ghost: after 150 ms, sweep the keycap to full at `ms` after keyDown.
    func startHold(ms: Double) {
        stopHold()
        guard let cur = current, let v = views[cur.id] else { return }
        let t0 = CACurrentMediaTime()
        let hidden = style.holdHiddenMs / 1000
        holdTimer = Overlay.onCommonModes(Timer(timeInterval: 1.0 / 60, repeats: true) { _ in
            let el = CACurrentMediaTime() - t0
            guard el >= hidden else { return }
            v.pill.holdFraction = CGFloat(el * 1000 / ms)
        })
    }

    /// Schedule on the common modes, so animations keep running while a menu is open or the HUD is dragged.
    @discardableResult
    static func onCommonModes(_ t: Timer) -> Timer {
        RunLoop.main.add(t, forMode: .common)
        return t
    }

    func stopHold() {
        holdTimer?.invalidate()
        holdTimer = nil
        for v in views.values where v.pill.holdFraction != nil { v.pill.holdFraction = nil }
    }

    private func add(_ g: Ghost, animated: Bool, hc: Bool? = nil) {
        let st = Style(hc: hc ?? highContrast)
        cover(screen(for: g))
        let v = GhostView(ghost: g, style: st, frame: root.bounds, usable: usable)
        v.setBoundsOrigin(screenTL.origin) // view points = protocol points on this display
        views[g.id] = v
        root.addSubview(v)
        guard animated else { return }
        v.alphaValue = 0
        let target = v.pill.frame.origin
        v.pill.setFrameOrigin(CGPoint(x: target.x, y: target.y + st.appearRise))
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = st.appearMs / 1000
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            v.animator().alphaValue = 1
            v.pill.animator().setFrameOrigin(target)
        }
    }

    /// exit nil = remove at once.
    private func remove(_ id: String, exit: Exit?) {
        hideTimers[id]?.cancel()
        hideTimers[id] = nil
        guard let v = views.removeValue(forKey: id) else { return }
        let st = v.style
        guard let exit else { v.removeFromSuperview(); return }
        switch exit {
        case .dismiss, .done:
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = (exit == .done ? st.doneFadeMs : st.dismissMs) / 1000
                ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                v.animator().alphaValue = 0
            }, completionHandler: { v.removeFromSuperview() })
        case .accept:
            v.pill.pressed = true
            if !st.reduceMotion { ripple(from: v) }
            DispatchQueue.main.asyncAfter(deadline: .now() + st.pressMs / 1000) {
                if !st.reduceMotion, let layer = v.pill.layer {
                    let s = CABasicAnimation(keyPath: "transform.scale")
                    s.fromValue = 1
                    s.toValue = 0.97
                    s.duration = st.acceptFadeMs / 1000
                    s.fillMode = .forwards
                    s.isRemovedOnCompletion = false
                    layer.add(s, forKey: "accept")
                }
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = st.acceptFadeMs / 1000
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                    v.animator().alphaValue = 0
                }, completionHandler: { v.removeFromSuperview() })
            }
        }
    }
}

extension Overlay {
    /// Accept feedback the room can see: a ring leaves the target and fades, so it's clear where Tab acted.
    fileprivate func ripple(from v: GhostView) {
        let ring = RippleView(frame: root.bounds, rect: v.rippleRect, corner: v.boxCorner, style: v.style, kind: v.ghost.kind)
        ring.setBoundsOrigin(v.bounds.origin)
        root.addSubview(ring, positioned: .below, relativeTo: v)
        let t0 = CACurrentMediaTime()
        Overlay.onCommonModes(Timer(timeInterval: 1.0 / 60, repeats: true) { t in
            let f = min(1, (CACurrentMediaTime() - t0) / RippleView.seconds)
            ring.progress = CGFloat(1 - pow(1 - f, 3)) // ease-out cubic
            if f >= 1 { t.invalidate(); ring.removeFromSuperview() }
        })
    }
}

/// One expanding, fading ring around a rect (accept feedback).
final class RippleView: NSView {
    static let seconds = 0.32
    let rect: CGRect
    let corner: CGFloat
    let style: Style
    let kind: GhostKind
    var progress: CGFloat = 0 { didSet { needsDisplay = true } }

    init(frame: CGRect, rect: CGRect, corner: CGFloat, style: Style, kind: GhostKind) {
        self.rect = rect
        self.corner = corner
        self.style = style
        self.kind = kind
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }

    override func draw(_ dirty: NSRect) {
        // Normal: a small, quiet ring (1 → 8 pt out). HC keeps the big one (2 → 16 pt).
        let grow = style.hc ? 2 + 14 * progress : 1 + 7 * progress
        let r = rect.insetBy(dx: -grow, dy: -grow)
        let radius = min(r.height / 2, corner + grow) // concentric with the box
        let path = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
        path.lineWidth = (style.hc ? 4 : 1.5) * (1 - progress) + 0.5
        style.boxColor(kind).withAlphaComponent((style.hc ? 0.85 : 0.6) * (1 - progress)).setStroke()
        path.stroke()
    }
}

class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
