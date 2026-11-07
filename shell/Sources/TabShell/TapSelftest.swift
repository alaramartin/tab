// `TabShell --tap-selftest`: the input tap's Tab/Esc/hold rules (PLAN "Input tap"), checked without Accessibility.
// Synthetic CGEvents go straight into InputTap.handle with a fake delegate; creating events needs no permission,
// only posting them does. Exits 0 when every case passes.
import AppKit

private final class FakeShell: InputTapDelegate {
    var visibleGhost: Ghost?
    var paymentSettling = false
    var ownRects: [CGRect] = [CGRect(x: 1000, y: 0, width: 264, height: 196)]
    var calls: [String] = []
    func tapAccept(_ g: Ghost) { calls.append("accept \(g.id)"); visibleGhost = nil }
    func tapDismiss(_ g: Ghost) { calls.append("dismiss \(g.id)"); visibleGhost = nil }
    func tapBlockedPress(_ g: Ghost) { calls.append("shake \(g.id)") }
    func tapOtherInput(kind: String, report: Bool) { calls.append(report ? "input \(kind)" : "hide only") }
    func tapHoldProgress(started: Bool) {}
    func tapObserved(kind: RawInput.Kind, keyCode: Int64, flags: CGEventFlags, chars: String, location: CGPoint, ts: Double) {}
}

func runTapSelftest() -> Never {
    let tap = InputTap()
    let fake = FakeShell()
    tap.delegate = fake
    var failures = 0

    func key(_ code: CGKeyCode, down: Bool, repeat isRepeat: Bool = false, flags: CGEventFlags = [], marker: Bool = false) -> CGEvent {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
        e.flags = flags
        if isRepeat { e.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
        if marker { e.setIntegerValueField(.eventSourceUserData, value: tabEventMarker) }
        return e
    }
    func click(_ x: CGFloat, _ y: CGFloat) -> CGEvent {
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
    }
    /// Feed one event; true if it passed through to the app.
    func feed(_ e: CGEvent) -> Bool {
        let type = e.type
        return tap.handle(type, e) != nil
    }
    /// Let the main queue run (the tap defers delegate calls with DispatchQueue.main.async).
    func settle(_ ms: Double) { RunLoop.main.run(until: Date().addingTimeInterval(ms / 1000)) }
    func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        print("  \(ok ? "✓" : "✗") \(name)\(ok ? "" : " — \(detail())")")
        if !ok { failures += 1 }
    }
    func ghost(_ id: String, _ kind: GhostKind) -> Ghost { Ghost(id: id, kind: kind, label: "x ⇥", rect: Rect(x: 10, y: 10, w: 80, h: 30)) }
    func reset(_ g: Ghost?) { fake.visibleGhost = g; fake.calls = []; settle(5) }
    let tabK: CGKeyCode = 48, escK: CGKeyCode = 53, aK: CGKeyCode = 0

    print("tap selftest")

    reset(nil)
    let d0 = feed(key(tabK, down: true)), u0 = feed(key(tabK, down: false)); settle(20)
    check("no ghost: Tab passes through", d0 && u0)

    reset(ghost("a", .action))
    let d1 = feed(key(tabK, down: true)), r1 = feed(key(tabK, down: true, repeat: true))
    settle(100)
    let u1 = feed(key(tabK, down: false)); settle(20)
    check("action: Tab down, autorepeat and up are swallowed", !d1 && !r1 && !u1)
    check("action: a short press accepts once", fake.calls == ["accept a"], "\(fake.calls)")

    reset(ghost("h", .pay))
    let d2 = feed(key(tabK, down: true)); settle(700)
    let calls2 = fake.calls
    let u2 = feed(key(tabK, down: false)); settle(20)
    check("pay: holding ≥ 600 ms dismisses during the hold", calls2 == ["dismiss h"], "\(calls2)")
    check("pay: the held press never accepts", !d2 && !u2 && fake.calls == ["dismiss h"], "\(fake.calls)")

    reset(ghost("b", .blocked))
    let d3 = feed(key(tabK, down: true)); settle(50)
    let u3 = feed(key(tabK, down: false)); settle(20)
    check("blocked: Tab is swallowed and only shakes", !d3 && !u3 && fake.calls == ["shake b"], "\(fake.calls)")

    reset(ghost("e", .action))
    let d4 = feed(key(escK, down: true)); settle(20)
    let u4 = feed(key(escK, down: false)); settle(20)
    check("Esc on a ghost: swallowed (down and up), dismisses", !d4 && !u4 && fake.calls == ["dismiss e"], "\(fake.calls)")

    reset(ghost("d", .done))
    let d5 = feed(key(tabK, down: true)), u5 = feed(key(tabK, down: false))
    let d5e = feed(key(escK, down: true)), u5e = feed(key(escK, down: false)); settle(20)
    check("done ghost: Tab and Esc pass through", d5 && u5 && d5e && u5e)

    reset(ghost("c", .action))
    let d6 = feed(key(tabK, down: true, flags: .maskCommand)); settle(20)
    check("⌘Tab with a ghost: passes through, counts as other input", d6 && fake.calls == ["input key"], "\(fake.calls)")

    reset(ghost("l", .action))
    _ = feed(key(tabK, down: true)) // its keyUp is "lost"
    settle(50)
    let d7 = feed(key(tabK, down: true)); settle(50)
    let u7 = feed(key(tabK, down: false)); settle(20)
    check("lost keyUp: the next fresh press starts over and accepts once", !d7 && !u7 && fake.calls == ["accept l"], "\(fake.calls)")

    reset(ghost("t", .action))
    _ = feed(key(tabK, down: true)) // the tap gets disabled mid-press and the keyUp is never seen
    let off = CGEvent(source: nil)!
    _ = tap.handle(.tapDisabledByTimeout, off)
    settle(700)
    let calls9 = fake.calls
    let d10 = feed(key(tabK, down: true)); settle(50)
    let u10 = feed(key(tabK, down: false)); settle(20)
    check("tap disabled mid-press: the press is dropped (no hold dismiss), the next one accepts", calls9.isEmpty && !d10 && !u10 && fake.calls == ["accept t"], "\(calls9) then \(fake.calls)")

    reset(nil)
    _ = feed(key(tabK, down: true)) // Tab held down before any ghost…
    fake.visibleGhost = ghost("r", .action) // …then a ghost appears
    let r11 = feed(key(tabK, down: true, repeat: true)), u11 = feed(key(tabK, down: false)); settle(20)
    check("Tab held from before the ghost: its autorepeat and keyUp pass, nothing accepted", r11 && u11 && !fake.calls.contains("accept r"), "\(fake.calls)")

    reset(ghost("m", .action))
    let d8 = feed(key(tabK, down: true, marker: true)), u8 = feed(key(tabK, down: false, marker: true)); settle(20)
    check("our own events (0x7AB) pass through untouched", d8 && u8 && fake.calls.isEmpty, "\(fake.calls)")

    reset(ghost("k", .action))
    let d9 = feed(key(aK, down: true)); settle(20)
    check("another key: passes through, reported as input", d9 && fake.calls == ["input key"], "\(fake.calls)")

    reset(ghost("o", .action))
    let c1 = feed(click(1100, 50)); settle(20)
    let hudCalls = fake.calls
    let c2 = feed(click(300, 300)); settle(20)
    check("click on the HUD: passes through, not input", c1 && hudCalls.isEmpty, "\(hudCalls)")
    check("click elsewhere: passes through, reported as input", c2 && fake.calls == ["input click"], "\(fake.calls)")

    reset(nil)
    fake.paymentSettling = true // Tab accepted a pay ghost; "Paying…" is up, no ghost is current
    let d12 = feed(key(tabK, down: true)), r12 = feed(key(tabK, down: true, repeat: true)), u12 = feed(key(tabK, down: false)); settle(20)
    check("paying: Tab down, autorepeat and up are swallowed, counted once as input", !d12 && !r12 && !u12 && fake.calls == ["input key"], "\(fake.calls)")
    fake.calls = []
    let k12 = feed(key(aK, down: true)), c12 = feed(click(300, 300)); settle(20)
    check("paying: other keys and clicks pass through, reported as input", k12 && c12 && fake.calls == ["input key", "input click"], "\(fake.calls)")
    fake.paymentSettling = false

    print(failures == 0 ? "all passed" : "\(failures) failed")
    exit(failures == 0 ? 0 : 1)
}
