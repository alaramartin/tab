// One session-level CGEventTap on keyDown, keyUp and leftMouseDown.
// The callback only reads event fields and touches main-thread state; anything slow (network, AX) is enqueued.
import AppKit
import Carbon.HIToolbox

let tabEventMarker: Int64 = 0x7AB
private let kTab: Int64 = 48
private let kEsc: Int64 = 53
/// Tab held this long dismisses instead of accepting (single-switch users have no Esc). The keycap sweep uses it too.
let holdDismissMs: Double = 600

protocol InputTapDelegate: AnyObject {
    /// The ghost the overlay currently shows, if any.
    var visibleGhost: Ghost? { get }
    /// Tab accepted a pay ghost and the payment is settling ("Paying…").
    var paymentSettling: Bool { get }
    /// Screen rects (top-left points) whose clicks are ours, e.g. the menu bar dropdown.
    var ownRects: [CGRect] { get }
    func tapAccept(_ g: Ghost)
    func tapDismiss(_ g: Ghost)
    func tapBlockedPress(_ g: Ghost)
    /// Any other real input: hide the ghost; tell the hub only if `report` (never for secure typing).
    func tapOtherInput(kind: String, report: Bool)
    func tapHoldProgress(started: Bool)
    /// Every reportable real input with its details, for the action recorder (ActionObserver).
    func tapObserved(kind: RawInput.Kind, keyCode: Int64, flags: CGEventFlags, chars: String, location: CGPoint, ts: Double)
}

final class InputTap {
    weak var delegate: InputTapDelegate?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

    // A swallowed Tab press in progress.
    private var tabPress: (ghost: Ghost, downAt: Double, dismissed: Bool)?
    private var holdTimer: DispatchWorkItem?
    private var escSwallowed = false
    private var tabSwallowedPaying = false

    var isRunning: Bool { tap != nil }

    /// Returns false if the tap can't be created (no Accessibility grant yet).
    @discardableResult
    func start() -> Bool {
        guard tap == nil else { return true }
        let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.leftMouseDown.rawValue)
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                        eventsOfInterest: mask, callback: inputTapCallback, userInfo: me) else { return false }
        tap = t
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        log("tap: running")
        return true
    }

    func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            log("tap: re-enabling after \(type == .tapDisabledByTimeout ? "timeout" : "user input")")
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            // Keys went by unseen; a held Tab's keyUp may be among them.
            if tabPress != nil { resetPress() }
            escSwallowed = false
            tabSwallowedPaying = false
            return Unmanaged.passUnretained(event)
        }
        if event.getIntegerValueField(.eventSourceUserData) == tabEventMarker { return Unmanaged.passUnretained(event) }
        guard let d = delegate else { return Unmanaged.passUnretained(event) }

        switch type {
        case .keyDown:
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            let mods = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
            if code == kTab, tabPress != nil {
                if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return nil } // autorepeat of a swallowed press
                // A fresh press while one is "in progress": its keyUp was lost (the tap was disabled). Start over.
                resetPress()
            }
            if code == kEsc, escSwallowed { return nil }
            // While a payment settles, Tab stays Tab's: swallowed, so a second pedal press doesn't move the page's focus.
            // It still counts as input (once per press); the hub keeps the in-flight payment from being re-offered.
            if code == kTab, mods.isEmpty, d.visibleGhost == nil, d.paymentSettling {
                if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { DispatchQueue.main.async { d.tapOtherInput(kind: "key", report: true) } }
                tabSwallowedPaying = true
                return nil
            }
            // Tab already held when the ghost appeared: its autorepeats are the old press, never an accept.
            let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            if let g = d.visibleGhost, g.kind != .done, mods.isEmpty, !(code == kTab && isRepeat) {
                if code == kTab {
                    tabPress = (g, nowMs(), false)
                    let w = DispatchWorkItem { [weak self] in self?.holdElapsed() }
                    holdTimer = w
                    DispatchQueue.main.asyncAfter(deadline: .now() + holdDismissMs / 1000, execute: w)
                    DispatchQueue.main.async { d.tapHoldProgress(started: true) }
                    return nil
                }
                if code == kEsc {
                    escSwallowed = true
                    DispatchQueue.main.async { d.tapDismiss(g) }
                    return nil
                }
            }
            // Typing in a secure field (a password) still hides the ghost, but nothing about it leaves this process.
            let secure = IsSecureEventInputEnabled()
            let chars = secure ? "" : unicode(event)
            let flags = event.flags, ts = nowMs()
            DispatchQueue.main.async {
                d.tapOtherInput(kind: "key", report: !secure)
                if !secure { d.tapObserved(kind: .key, keyCode: code, flags: flags, chars: chars, location: .zero, ts: ts) }
            }
            return Unmanaged.passUnretained(event)

        case .keyUp:
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            if code == kTab, let p = tabPress {
                tabPress = nil
                holdTimer?.cancel()
                holdTimer = nil
                let held = nowMs() - p.downAt
                DispatchQueue.main.async {
                    d.tapHoldProgress(started: false)
                    if p.dismissed { return }
                    if held >= holdDismissMs { d.tapDismiss(p.ghost) }
                    else if p.ghost.kind == .blocked { d.tapBlockedPress(p.ghost) }
                    else { d.tapAccept(p.ghost) }
                }
                return nil
            }
            if code == kTab, tabSwallowedPaying {
                tabSwallowedPaying = false
                return nil
            }
            if code == kEsc, escSwallowed {
                escSwallowed = false
                return nil
            }
            return Unmanaged.passUnretained(event)

        case .leftMouseDown:
            let loc = event.location
            if d.ownRects.contains(where: { $0.contains(loc) }) { return Unmanaged.passUnretained(event) }
            let ts = nowMs()
            DispatchQueue.main.async {
                d.tapOtherInput(kind: "click", report: true)
                d.tapObserved(kind: .click, keyCode: 0, flags: [], chars: "", location: loc, ts: ts)
            }
            return Unmanaged.passUnretained(event)

        default:
            return Unmanaged.passUnretained(event)
        }
    }

    private func resetPress() {
        tabPress = nil
        holdTimer?.cancel()
        holdTimer = nil
        let d = delegate
        DispatchQueue.main.async { d?.tapHoldProgress(started: false) }
    }

    /// Long press (single-switch users have no Esc): dismiss as soon as the hold crosses the threshold.
    private func holdElapsed() {
        guard var p = tabPress, !p.dismissed else { return }
        p.dismissed = true
        tabPress = p
        delegate?.tapHoldProgress(started: false)
        delegate?.tapDismiss(p.ghost)
    }
}

private func unicode(_ e: CGEvent) -> String {
    var len = 0
    var buf = [UniChar](repeating: 0, count: 8)
    e.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &len, unicodeString: &buf)
    return String(utf16CodeUnits: buf, count: len)
}

private func inputTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    return Unmanaged<InputTap>.fromOpaque(refcon).takeUnretainedValue().handle(type, event)
}
