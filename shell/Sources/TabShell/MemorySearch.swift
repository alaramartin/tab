// Menu bar → Search Memory…: a small panel that finds past tasks by meaning ("the form I filled for the landlord").
// The hub searches the one-line episode summaries (brain/src/memory/episodes.ts) and answers with memory_results.
// Clicking a result brings its app to the front.
import AppKit

struct MemoryHit: Decodable {
    var ts: Double
    var app: String
    var summary: String
    var steps: Int
}

final class MemorySearchPanel: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    let panel: NSPanel
    private let field = NSSearchField()
    private let table = NSTableView()
    private let status = NSTextField(labelWithString: "")
    private var hits: [MemoryHit] = []
    private var asked = ""
    /// Sends a query to the hub; nil when the hub isn't connected.
    var search: ((String) -> Bool)?

    override init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 360), styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: true)
        super.init()
        panel.title = "Search Memory"
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 360, height: 220)
        panel.delegate = self

        let v = NSView()
        panel.contentView = v
        field.placeholderString = "What did you do? e.g. pharmacy refill"
        field.sendsSearchStringImmediately = false
        field.sendsWholeSearchString = false
        field.delegate = self
        field.target = self
        field.action = #selector(queryChanged)
        status.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)

        let col = NSTableColumn(identifier: .init("hit"))
        table.addTableColumn(col)
        table.headerView = nil
        table.rowHeight = 40
        table.style = .inset
        table.usesAutomaticRowHeights = false
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(openSelected)
        table.action = #selector(openSelected)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false

        for s in [field, scroll, status] as [NSView] {
            s.translatesAutoresizingMaskIntoConstraints = false
            v.addSubview(s)
        }
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: v.topAnchor, constant: 12),
            field.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 12),
            field.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            status.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 6),
            status.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 14),
            status.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -14),
            status.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -8),
        ])
        setStatus()
    }

    /// `TabShell --render-memory-search out.png`: the panel with sample results, drawn offscreen.
    static func render(to out: String) {
        let p = MemorySearchPanel()
        p.field.stringValue = "pharmacy refill"
        p.asked = "pharmacy refill"
        let now = Date().timeIntervalSince1970 * 1000
        p.show(results: [
            MemoryHit(ts: now - 3_600_000, app: "com.google.Chrome", summary: "Refilled a prescription on the pharmacy site", steps: 14),
            MemoryHit(ts: now - 86_400_000 * 3, app: "com.apple.mail", summary: "Emailed the pharmacy about a missing refill", steps: 6),
            MemoryHit(ts: now - 86_400_000 * 20, app: "com.apple.iCal", summary: "Added a refill reminder to Calendar for Friday at 9 am, repeating monthly", steps: 1),
        ], for: "pharmacy refill")
        let v = p.panel.contentView!
        v.frame = NSRect(x: 0, y: 0, width: 520, height: 300)
        let look = NSAppearance(named: args.contains("--dark") ? .darkAqua : .aqua)!
        v.appearance = look
        v.wantsLayer = true
        look.performAsCurrentDrawingAppearance { v.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }
        v.layoutSubtreeIfNeeded()
        p.table.layoutSubtreeIfNeeded()
        guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { fatalError("no bitmap") }
        v.cacheDisplay(in: v.bounds, to: rep)
        try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
        print("wrote \(out)")
    }

    func show() {
        if !panel.isVisible { panel.center() }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    @objc private func queryChanged() {
        let q = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        asked = q
        if q.isEmpty {
            hits = []
            table.reloadData()
            return setStatus()
        }
        if search?(q) == true { status.stringValue = "Searching…" } else { status.stringValue = "Tab's hub isn't running, so memory can't be searched." }
    }

    /// The hub's answer. Answers to an older query (typing moved on) are dropped.
    func show(results: [MemoryHit], for query: String) {
        guard query == asked else { return }
        hits = results
        table.reloadData()
        setStatus()
    }

    private func setStatus() {
        if asked.isEmpty { status.stringValue = "Searches the one-line summaries Tab writes of finished tasks." }
        else if hits.isEmpty { status.stringValue = "Nothing found for “\(asked)”." }
        else { status.stringValue = hits.count == 1 ? "1 task. Click it to open its app." : "\(hits.count) tasks. Click one to open its app." }
    }

    @objc private func openSelected() {
        let i = table.clickedRow >= 0 ? table.clickedRow : table.selectedRow
        guard hits.indices.contains(i) else { return }
        let app = hits[i].app
        if let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == app }) {
            running.activate()
        } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: app) {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { hits.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let h = hits[row]
        let cell = NSTableCellView()
        let title = NSTextField(labelWithString: h.summary)
        title.lineBreakMode = .byTruncatingTail
        let when = Date(timeIntervalSince1970: h.ts / 1000)
        let detail = NSTextField(labelWithString: "\(MemorySearchPanel.dates.string(from: when)) · \(appName(h.app)) · \(h.steps) step\(h.steps == 1 ? "" : "s")")
        detail.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        detail.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [title, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 1
        stack.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -4),
            stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        cell.setAccessibilityLabel("\(h.summary), \(detail.stringValue)")
        return cell
    }

    private func appName(_ bundleId: String) -> String {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        }
        return bundleId
    }

    static let dates: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        f.doesRelativeDateFormatting = true
        return f
    }()
}
