// `TabShell --testbed`: a small native window to test perception, action capture and execution end to end without
// touching the user's own apps (TextEdit autosaves untitled documents to iCloud; Notes and Mail sync).
// A form (text fields, a popup, a checkbox, Submit) and an editable table (ID / Number) for repeated-row chores.
// The process identifies as "exe:TabShell" (no bundle id), so the main TabShell reads it like any other app.
import AppKit

final class Testbed: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let window: NSWindow
    var signup: NSWindow?
    var rows: [[String]] = (1...8).map { ["ENG-\(140 + $0)", ""] }
    let table = NSTableView()
    let status = NSTextField(labelWithString: "Nothing submitted yet")

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 560), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Tab Testbed"
        let v = NSView(frame: window.contentView!.bounds)
        window.contentView = v

        var y: CGFloat = 510
        func field(_ label: String, _ placeholder: String) -> NSTextField {
            let l = NSTextField(labelWithString: label)
            l.frame = NSRect(x: 20, y: y, width: 120, height: 22)
            v.addSubview(l)
            let f = NSTextField(frame: NSRect(x: 150, y: y, width: 360, height: 24))
            f.placeholderString = placeholder
            f.setAccessibilityLabel(label)
            v.addSubview(f)
            y -= 36
            return f
        }
        _ = field("Full name", "Jane Doe")
        _ = field("Email", "you@example.com")
        _ = field("Employer", "Company name")

        let cl = NSTextField(labelWithString: "Country")
        cl.frame = NSRect(x: 20, y: y, width: 120, height: 22)
        v.addSubview(cl)
        let pop = NSPopUpButton(frame: NSRect(x: 150, y: y - 2, width: 200, height: 26))
        pop.addItems(withTitles: ["Choose…", "Canada", "France", "Japan", "United States"])
        pop.setAccessibilityLabel("Country")
        v.addSubview(pop)
        y -= 36

        let cb = NSButton(checkboxWithTitle: "Subscribe to updates", target: nil, action: nil)
        cb.frame = NSRect(x: 150, y: y, width: 250, height: 22)
        v.addSubview(cb)
        y -= 40

        let submit = NSButton(title: "Submit", target: self, action: #selector(submitted))
        submit.frame = NSRect(x: 150, y: y, width: 100, height: 30)
        submit.bezelStyle = .rounded
        v.addSubview(submit)
        status.frame = NSRect(x: 270, y: y + 4, width: 270, height: 22)
        v.addSubview(status)
        y -= 20

        let scroll = NSScrollView(frame: NSRect(x: 20, y: 20, width: 520, height: y - 30))
        for (id, title) in [("id", "ID"), ("number", "Number")] {
            let c = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            c.title = title
            c.width = 240
            table.addTableColumn(c)
        }
        table.dataSource = self
        table.delegate = self
        table.setAccessibilityLabel("Tickets")
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        v.addSubview(scroll)

        // A standard Edit menu, so cmd+X/C/V/A work like in any real app (the Actuator pastes long text).
        let main = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        appItem.submenu!.addItem(withTitle: "Quit Testbed", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main

        window.center()
        window.makeKeyAndOrderFront(nil)
        if CommandLine.arguments.contains("--signup") { openSignup() }
        NSApp.activate(ignoringOtherApps: true)
    }

    /// A second form whose fields mean the same things under other names (field facts: forms are retrieval).
    func openSignup() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 220), styleMask: [.titled], backing: .buffered, defer: false)
        w.title = "Sign up"
        let v = NSView(frame: w.contentView!.bounds)
        w.contentView = v
        var y: CGFloat = 170
        for label in ["Your name", "Work email", "Current company", "Last name"] {
            let l = NSTextField(labelWithString: label)
            l.frame = NSRect(x: 20, y: y, width: 130, height: 22)
            v.addSubview(l)
            let f = NSTextField(frame: NSRect(x: 160, y: y, width: 250, height: 24))
            f.setAccessibilityLabel(label)
            v.addSubview(f)
            y -= 36
        }
        var o = window.frame.origin
        o.x += window.frame.width + 12
        w.setFrameOrigin(o)
        w.orderFront(nil)
        signup = w
    }

    @objc func submitted() { status.stringValue = "Submitted at \(DateFormatter.logStamp.string(from: Date()))" }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor col: NSTableColumn?, row: Int) -> NSView? {
        let c = col?.identifier.rawValue == "id" ? 0 : 1
        let f = NSTextField(string: rows[row][c])
        f.isBordered = false
        f.drawsBackground = false
        f.isEditable = c == 1
        f.tag = row
        f.target = self
        f.action = #selector(edited(_:))
        f.setAccessibilityLabel(c == 0 ? "ID" : "Number")
        return f
    }

    @objc func edited(_ f: NSTextField) {
        if f.tag < rows.count { rows[f.tag][1] = f.stringValue }
    }
}

/// `--canvas`: a window that draws its buttons as plain pixels and exposes nothing to Accessibility (like a game,
/// a canvas editor or a CEF app). Clicks are hit-tested by hand; the count of each button's clicks is drawn too.
final class CanvasView: NSView {
    let buttons = ["Open", "Archive", "Snooze", "Delete"]
    var clicks: [String: Int] = [:]
    override var isFlipped: Bool { true }
    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? { [] }

    func frame(of i: Int) -> NSRect { NSRect(x: 30 + CGFloat(i) * 120, y: 40, width: 100, height: 40) }

    override func draw(_ dirty: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        let font = NSFont.systemFont(ofSize: 16, weight: .medium)
        for (i, b) in buttons.enumerated() {
            let r = frame(of: i)
            NSColor(white: 0.9, alpha: 1).setFill()
            NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8).fill()
            let s = NSAttributedString(string: b, attributes: [.font: font, .foregroundColor: NSColor.black])
            s.draw(at: NSPoint(x: r.midX - s.size().width / 2, y: r.midY - s.size().height / 2))
        }
        let status = buttons.map { "\($0) \(clicks[$0, default: 0])" }.joined(separator: " · ")
        NSAttributedString(string: status, attributes: [.font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor.darkGray]).draw(at: NSPoint(x: 30, y: 110))
    }

    override func mouseDown(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        for (i, b) in buttons.enumerated() where frame(of: i).contains(p) {
            clicks[b, default: 0] += 1
            needsDisplay = true
            // Test hook: the e2e reads the counts here (the canvas has no AX to read them from).
            if let path = ProcessInfo.processInfo.environment["TAB_CANVAS_LOG"] {
                try? (buttons.map { "\($0)=\(clicks[$0, default: 0])" }.joined(separator: " ") + "\n").write(toFile: path, atomically: true, encoding: .utf8)
            }
        }
    }
}

final class CanvasTestbed {
    let window: NSWindow
    init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Canvas"
        window.contentView = CanvasView(frame: window.contentView!.bounds)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
