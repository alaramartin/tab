// --cover-selftest: when does another app's window count as covering the one Tab reads? Synthetic window lists shaped
// like a real one (Tab's full-screen overlay, the Dock, the menu bar, other apps' windows), checked offscreen.
import AppKit

func runCoverSelftest() -> Never {
    var failures = 0
    func check(_ ok: Bool, _ what: String) {
        print("\(ok ? "ok  " : "FAIL") \(what)")
        if !ok { failures += 1 }
    }
    typealias W = AXSensor.WindowInfo
    let me: pid_t = 1, calc: pid_t = 2, code: pid_t = 3, dock: pid_t = 4, block: pid_t = 5, other: pid_t = 6
    let calcFrame = Rect(x: 270, y: 409, w: 230, h: 408)
    let calcWin = W(pid: calc, layer: 0, alpha: 1, bounds: CGRect(x: 270, y: 409, width: 230, height: 408))
    let chrome = [
        W(pid: me, layer: 26, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 1440, height: 900)), // Tab's ghost overlay
        W(pid: 7, layer: 24, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 1440, height: 30)),   // the menu bar
        W(pid: dock, layer: 20, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 1440, height: 900)),
    ]
    let behind = W(pid: code, layer: 0, alpha: 1, bounds: CGRect(x: 0, y: 30, width: 1440, height: 792))
    func frac(_ ws: [W]) -> Double { AXSensor.coveredFraction(ws, pid: calc, frame: calcFrame, me: me) }

    check(frac(chrome + [calcWin, behind]) == 0, "nothing in front: the overlay, Dock and menu bar don't count, nor windows behind")
    let shield = W(pid: block, layer: 0, alpha: 1, bounds: CGRect(x: 250, y: 380, width: 300, height: 460))
    check(frac(chrome + [shield, calcWin, behind]) >= 0.99, "a block window over all of it covers it")
    let panel = W(pid: other, layer: 3, alpha: 1, bounds: CGRect(x: 270, y: 409, width: 100, height: 120))
    let f = frac(chrome + [panel, calcWin, behind])
    check(f > 0 && f < 0.5, "a small floating panel over a corner doesn't (\(String(format: "%.2f", f)))")
    let clear = W(pid: other, layer: 0, alpha: 0, bounds: CGRect(x: 250, y: 380, width: 300, height: 460))
    check(frac(chrome + [clear, calcWin]) == 0, "an invisible window doesn't")
    let half = [W(pid: other, layer: 0, alpha: 1, bounds: CGRect(x: 270, y: 409, width: 230, height: 150)),
                W(pid: block, layer: 8, alpha: 1, bounds: CGRect(x: 270, y: 559, width: 230, height: 120))]
    check(frac(chrome + half + [calcWin]) >= 0.5, "two windows that together cover most of it do")
    check(frac(chrome + [behind]) >= 0.99, "its window not on screen at all: covered, so nothing is offered")
    print(failures == 0 ? "cover selftest passed" : "cover selftest: \(failures) failed")
    exit(failures == 0 ? 0 : 1)
}
