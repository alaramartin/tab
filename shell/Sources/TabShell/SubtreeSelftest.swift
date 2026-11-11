// --subtree-selftest: a subtree re-walk gives the same snapshot as a full walk. Opens the testbed window off every
// screen in this process (never activated, no input), walks it through Accessibility, changes the table (edit a cell,
// remove a row), drops only the table from the walk cache, and compares the cached walk with a fresh full walk.
// Needs the Accessibility grant (the terminal's, when run from one).
import AppKit

func runSubtreeSelftest() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    guard AXIsProcessTrusted() else {
        print("FAIL Accessibility isn't granted to this process (or the terminal running it)")
        exit(1)
    }
    let bed = Testbed(offscreen: true)
    let pid = getpid()
    var failures = 0
    func check(_ ok: Bool, _ what: String) {
        print("\(ok ? "ok  " : "FAIL") \(what)")
        if !ok { failures += 1 }
    }
    func lines(_ s: ScreenState) -> [String] {
        s.elements.map { e in
            "\(e.id)|\(e.path ?? "")|\(e.role)|\(e.label)|\(e.value ?? "")|\(e.checked.map { "\($0)" } ?? "")|\(e.grid.map { "\($0.row),\($0.col ?? -1)" } ?? "")|\(e.list.map { "\($0.key)#\($0.index)" } ?? "")|\(e.section ?? "")|\(Int(e.rect.x)),\(Int(e.rect.y)),\(Int(e.rect.w)),\(Int(e.rect.h))"
        }
    }
    func same(_ a: ScreenState, _ b: ScreenState, _ what: String) {
        let la = lines(a), lb = lines(b)
        check(la == lb, "\(what) (\(la.count) elements)")
        if la != lb { for d in la.difference(from: lb) { print("     \(d)") } }
    }
    DispatchQueue.global(qos: .userInitiated).async {
        Thread.sleep(forTimeInterval: 0.5) // let the window lay out
        let tree = AXTreeCache()
        func walk(_ cache: AXTreeCache?) -> (ScreenState, Double) {
            let t0 = CFAbsoluteTimeGetCurrent()
            let s = AXSensor.stateAndRefs(pid: pid, bundleId: "selftest", seq: 1, limits: .init(budgetMs: 2000), cache: cache)!.0
            return (s, (CFAbsoluteTimeGetCurrent() - t0) * 1000)
        }
        let (full, fullMs) = walk(tree)
        check(full.elements.contains { $0.role == "cell" }, "the full walk sees the table's cells")
        let n0 = tree.fetched
        let (again, againMs) = walk(tree)
        check(tree.fetched == n0, "nothing changed: the walk reads nothing from the app (\(tree.fetched - n0) read)")
        same(again, full, "nothing changed: the cached walk equals the full walk")

        DispatchQueue.main.sync {
            bed.rows[1][1] = "42"
            bed.rows.remove(at: 3)
            bed.table.reloadData()
        }
        Thread.sleep(forTimeInterval: 0.3)
        // What an AXSelectedRowsChanged / AXLayoutChanged on the table would name.
        let tableEl = tableElement(pid: pid)
        check(tableEl != nil && tree.contains(tableEl!), "the table is in the walk cache")
        if let t = tableEl { tree.invalidate(t) }
        let n1 = tree.fetched
        let (sub, subMs) = walk(tree)
        let read = tree.fetched - n1
        let (fresh, freshMs) = walk(nil)
        same(sub, fresh, "after editing a cell and removing a row: the subtree walk equals a full walk")
        check(read > 0 && read < n1, "the subtree walk read only the table again (\(read) of \(tree.size) elements)")
        check(sub.elements.contains { $0.value == "42" }, "it sees the edited cell")
        print(String(format: "     full walk %.1f ms · unchanged %.1f ms · subtree %.1f ms · fresh full %.1f ms", fullMs, againMs, subMs, freshMs))
        print(failures == 0 ? "subtree selftest: all passed" : "subtree selftest: \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
    app.run()
    exit(1)
}

private func tableElement(pid: pid_t) -> AXUIElement? {
    guard let w = AX.focusedWindow(pid: pid) else { return nil }
    return AX.find(w, role: "AXTable", depth: 8)?.0
}
