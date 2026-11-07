// drive: real macOS input for recording takes (needs Accessibility for the calling app).
//   drive move X Y [ms]       eased human-like move to screen point (points, top-left origin)
//   drive click X Y [ms]      move then left click
//   drive key tab|esc|return|down|up|cmd-a|delete
//   drive type "text" [cps]   type unicode text at ~cps chars/sec
//   drive pos                 print current cursor position
import Foundation
import CoreGraphics

let src = CGEventSource(stateID: .hidSystemState)
func cur() -> CGPoint { CGEvent(source: nil)!.location }
func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }
func sleepMs(_ ms: Double) { usleep(useconds_t(ms * 1000)) }

func move(to p: CGPoint, ms: Double) {
    let a = cur()
    let dist = hypot(p.x - a.x, p.y - a.y)
    let dur = ms > 0 ? ms : min(900, max(250, 250 + dist * 0.55))
    let steps = max(2, Int(dur / 8))
    // slight arc: perpendicular offset that peaks mid-way
    let nx = -(p.y - a.y) / max(dist, 1), ny = (p.x - a.x) / max(dist, 1)
    let bow = min(40, dist * 0.08) * (Bool.random() ? 1 : -1)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let e = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2   // easeInOutCubic
        let arc = sin(Double.pi * t) * bow
        let q = CGPoint(x: a.x + (p.x - a.x) * e + nx * arc, y: a.y + (p.y - a.y) * e + ny * arc)
        post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: q, mouseButton: .left))
        sleepMs(dur / Double(steps))
    }
}
func click(_ p: CGPoint) {
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)); sleepMs(70)
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
}
func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
    let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true); d?.flags = flags; post(d); sleepMs(60)
    let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false); u?.flags = flags; post(u)
}
func type(_ s: String, cps: Double) {
    for ch in s {
        var u = Array(String(ch).utf16)
        let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true); d?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u); post(d)
        let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false); up?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u); post(up)
        sleepMs(1000 / cps * Double.random(in: 0.6...1.4))
    }
}
let a = CommandLine.arguments
guard a.count >= 2 else { print("usage: drive move|click|key|type|pos ..."); exit(2) }
switch a[1] {
case "pos": let p = cur(); print("\(Int(p.x)) \(Int(p.y))")
case "move": move(to: CGPoint(x: Double(a[2])!, y: Double(a[3])!), ms: a.count > 4 ? Double(a[4])! : 0)
case "click":
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    move(to: p, ms: a.count > 4 ? Double(a[4])! : 0); sleepMs(120); click(p)
case "key":
    let m: [String: (CGKeyCode, CGEventFlags)] = ["tab": (48, []), "esc": (53, []), "return": (36, []), "down": (125, []), "up": (126, []), "cmd-a": (0, .maskCommand), "delete": (51, []), "space": (49, [])]
    guard let k = m[a[2]] else { print("unknown key"); exit(2) }
    key(k.0, k.1)
case "type": type(a[2], cps: a.count > 3 ? Double(a[3])! : 12)
case "scroll": // drive scroll X Y DY (lines; negative = down)
    move(to: CGPoint(x: Double(a[2])!, y: Double(a[3])!), ms: 200)
    let n = Int32(a[4])!
    for _ in 0..<abs(n) { post(CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 1, wheel1: n > 0 ? 1 : -1, wheel2: 0, wheel3: 0)); sleepMs(12) }
default: print("unknown"); exit(2)
}
