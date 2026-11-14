// The menu bar dropdown: click Tab's icon for the goal being worked on (with Stop), the user's rules (add one, turn one
// on or off, remove it; saved to the rules file, hub or no hub) and Tab's commands (Pause, Search Memory, Forget the
// Last Hour, Quit).
// A dark card under the icon. It takes the keyboard while open, gives it back to the app that was in front when it
// closes (a click outside, Esc, or a command), and Tab and Esc belong to it while it's open, not to a ghost.
import AppKit
import Combine
import SwiftUI

/// What the dropdown shows. Rules are read from and written to the rules file here (RuleFile), hub or no hub.
final class TabMenuModel: ObservableObject {
    @Published var rules: [TabRule] = []
    @Published var goal: String?
    @Published var paused = false
    @Published var connected = false
    /// Stop working toward the goal (the hub runs it).
    var stopGoal: (() -> Void)?
    /// Where rules are kept; tests and renders point it elsewhere.
    var ruleFile: URL? = RuleFile.url

    /// Read the rules file again (it may have been edited by hand).
    func reloadRules() {
        guard let f = ruleFile else { return }
        let r = RuleFile.load(from: f)
        if r != rules { rules = r }
    }

    private func saveRules(_ r: [TabRule]) {
        rules = r
        if let f = ruleFile { RuleFile.save(r, to: f) }
    }

    func addRule(_ text: String) {
        reloadRules()
        guard let t = RuleFile.cleaned(text, existing: rules) else { return }
        saveRules(rules + [TabRule(id: RuleFile.newId(), text: t, enabled: true, created: (Date().timeIntervalSince1970 * 1000).rounded())])
    }

    func removeRule(_ id: String) { reloadRules(); saveRules(rules.filter { $0.id != id }) }

    func toggleRule(_ id: String) {
        reloadRules()
        saveRules(rules.map { r in r.id == id ? TabRule(id: r.id, text: r.text, enabled: !r.enabled, created: r.created) : r })
    }
    var onPause: (() -> Void)?
    var onSearch: (() -> Void)?
    var onForget: (() -> Void)?
    var onQuit: (() -> Void)?
}

private enum Palette {
    static let card = Color(nsColor: hex(0x1C1C1E))
    static let primary = Color.white.opacity(0.92)
    static let secondary = Color.white.opacity(0.60)
    static let faint = Color.white.opacity(0.40)
    static let blue = Color(nsColor: hex(0x0A84FF))
    static let blueText = Color(nsColor: hex(0x409CFF))
    static let hover = Color.white.opacity(0.08)
    static let divider = Color.white.opacity(0.10)
}

struct TabMenuView: View {
    @ObservedObject var model: TabMenuModel
    @State private var draft = ""
    @FocusState private var fieldFocused: Bool
    /// Close the dropdown (after a command).
    var close: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let goal = model.goal {
                HStack(spacing: 8) {
                    Text("↳ " + goal)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Palette.blueText)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Stop") { model.stopGoal?() }
                        .buttonStyle(PillButton())
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                divider
            }

            TextField("Add a rule…", text: $draft)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundStyle(Palette.primary)
                .focused($fieldFocused)
                .onSubmit {
                    let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty { model.addRule(t) }
                    draft = ""
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            divider

            if !model.connected {
                Text("Tab's hub isn't running, so nothing is suggested. Start it with `npm start` in brain/, or `shell/scripts/setup.sh --agent` to start it at login.")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.faint)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.top, 10)
                    .padding(.bottom, model.rules.isEmpty ? 10 : 2)
            }
            if model.rules.isEmpty {
                if model.connected {
                    Text("No rules yet. Try “booking an event adds it to Calendar”: when you've just done the first part, Tab offers the rest.")
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.faint)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
            } else {
                VStack(spacing: 0) {
                    ForEach(model.rules) { r in RuleRow(rule: r, toggle: { model.toggleRule(r.id) }, remove: { model.removeRule(r.id) }) }
                }
                .padding(.vertical, 4)
            }

            divider
            VStack(spacing: 0) {
                CommandRow(title: model.paused ? "Resume Tab" : "Pause Tab") { model.onPause?() }
                CommandRow(title: "Search Memory…") { close(); model.onSearch?() }
                CommandRow(title: "Forget the Last Hour") { model.onForget?() }
                CommandRow(title: "Quit Tab", shortcut: "⌘Q") { model.onQuit?() }
            }
            .padding(.vertical, 4)
        }
        .frame(width: 300)
        .background(Palette.card)
        .environment(\.colorScheme, .dark)
        .onAppear { fieldFocused = true }
    }

    private var divider: some View { Palette.divider.frame(height: 1).padding(.horizontal, 14) }
}

/// One rule: a dot that turns it on or off, its text, and × to remove it (shown on hover).
private struct RuleRow: View {
    let rule: TabRule
    let toggle: () -> Void
    let remove: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Button(action: toggle) {
                Circle()
                    .strokeBorder(rule.enabled ? Color.clear : Palette.secondary, lineWidth: 1.5)
                    .background(Circle().fill(rule.enabled ? Palette.blue : Color.clear))
                    .frame(width: 9, height: 9)
                    .contentShape(Rectangle().inset(by: -6))
            }
            .buttonStyle(.plain)
            .help(rule.enabled ? "Turn this rule off" : "Turn this rule on")
            Text(rule.text)
                .font(.system(size: 13))
                .foregroundStyle(rule.enabled ? Palette.primary : Palette.faint)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: remove) {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.secondary)
            }
            .buttonStyle(.plain)
            .opacity(hovering ? 1 : 0)
            .help("Remove this rule")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(hovering ? Palette.hover : Color.clear)
        .onHover { hovering = $0 }
    }
}

/// A command, styled like a menu item: the whole row is the button.
private struct CommandRow: View {
    let title: String
    var shortcut: String?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).font(.system(size: 13)).foregroundStyle(Palette.primary)
                Spacer()
                if let shortcut { Text(shortcut).font(.system(size: 12)).foregroundStyle(Palette.faint) }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 5).fill(hovering ? Palette.hover : Color.clear).padding(.horizontal, 5))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

private struct PillButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Palette.primary)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.white.opacity(configuration.isPressed ? 0.20 : 0.12)))
    }
}

/// The dropdown's window: a borderless panel under the icon that closes on a click outside, Esc, or losing focus.
final class TabMenuPanel: NSPanel {
    private let hosting: NSHostingView<TabMenuView>
    private var anchor: NSRect = .zero
    private var clickMonitor: Any?
    private var keyMonitor: Any?
    private var previousApp: NSRunningApplication?
    private var resize: AnyCancellable?
    var onOpenChange: ((Bool) -> Void)?

    init(model: TabMenuModel) {
        var view = TabMenuView(model: model)
        hosting = NSHostingView(rootView: view)
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        view.close = { [weak self] in self?.close() }
        hosting.rootView = view
        level = .popUpMenu
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

        let container = NSView()
        container.wantsLayer = true
        container.layer?.cornerRadius = 10
        container.layer?.masksToBounds = true
        container.layer?.borderWidth = 1
        container.layer?.borderColor = NSColor.white.withAlphaComponent(0.10).cgColor
        hosting.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(hosting)
        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            hosting.topAnchor.constraint(equalTo: container.topAnchor),
            hosting.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        contentView = container
        // Grow and shrink with the rules (and the goal line) while open.
        resize = model.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { if self?.isVisible == true { self?.layoutToFit() } }
        }
    }

    override var canBecomeKey: Bool { true }

    // An accessory app has no Edit menu: route the editing shortcuts to the field ourselves.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let action: Selector? = switch (mods, event.charactersIgnoringModifiers?.lowercased()) {
        case ([.command], "x"): #selector(NSText.cut(_:))
        case ([.command], "c"): #selector(NSText.copy(_:))
        case ([.command], "v"): #selector(NSText.paste(_:))
        case ([.command], "a"): #selector(NSText.selectAll(_:))
        case ([.command], "q"): #selector(NSApplication.terminate(_:))
        default: nil
        }
        if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        return super.performKeyEquivalent(with: event)
    }

    func show(below anchor: NSRect) {
        self.anchor = anchor
        let front = NSWorkspace.shared.frontmostApplication
        previousApp = front?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : front
        layoutToFit()
        NSApp.activate(ignoringOtherApps: true)
        makeKeyAndOrderFront(nil)
        onOpenChange?(true)
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in self?.close() }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53 { self?.close(); return nil } // Esc
            return e
        }
    }

    /// Resize to the content (the rules list grows and shrinks), keeping it under the icon and on screen.
    func layoutToFit() {
        let size = hosting.fittingSize
        let screen = NSScreen.screens.first { $0.frame.intersects(anchor) } ?? NSScreen.main
        var x = anchor.midX - size.width / 2
        if let vf = screen?.visibleFrame { x = min(max(x, vf.minX + 6), vf.maxX - size.width - 6) }
        setFrame(NSRect(x: x, y: anchor.minY - 6 - size.height, width: size.width, height: size.height), display: true)
        invalidateShadow()
    }

    override func close() {
        guard isVisible else { return }
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        makeFirstResponder(nil)
        super.close()
        onOpenChange?(false)
        // Give the keyboard back to the app that was in front.
        previousApp?.activate()
        previousApp = nil
    }

    override func resignKey() {
        super.resignKey()
        close()
    }

    /// `TabShell --render-menu out.png`: the dropdown in a few states, drawn offscreen.
    static func render(to out: String) {
        let rules = [TabRule(id: "a", text: "booking an event adds it to Calendar", enabled: true, created: 0),
                     TabRule(id: "b", text: "after merging a PR, post the link in the team channel on Slack", enabled: true, created: 0),
                     TabRule(id: "c", text: "saving a receipt files it in Finder", enabled: false, created: 0)]
        func model(_ f: (TabMenuModel) -> Void) -> TabMenuModel { let m = TabMenuModel(); m.ruleFile = nil; f(m); return m }
        let states: [TabMenuModel] = [
            model { $0.connected = true },
            model { $0.connected = true; $0.rules = rules },
            model { $0.connected = true; $0.rules = rules; $0.goal = "Add Night Owls · Fri 9pm to Calendar"; $0.paused = true },
            model { $0.connected = false; $0.rules = rules },
        ]
        let views = states.map { m -> NSView in
            let h = NSHostingView(rootView: TabMenuView(model: m))
            h.frame = CGRect(origin: .zero, size: h.fittingSize)
            return h
        }
        let gap: CGFloat = 32
        let w = views.reduce(gap) { $0 + $1.frame.width + gap }, hgt = (views.map(\.frame.height).max() ?? 0) + 2 * gap
        let root = NSView(frame: CGRect(x: 0, y: 0, width: w, height: hgt))
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor(white: 0.85, alpha: 1).cgColor
        var x = gap
        for v in views {
            v.frame.origin = CGPoint(x: x, y: hgt - gap - v.frame.height)
            v.wantsLayer = true
            v.layer?.cornerRadius = 10
            v.layer?.masksToBounds = true
            root.addSubview(v)
            x += v.frame.width + gap
        }
        root.layoutSubtreeIfNeeded()
        guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { fatalError("no bitmap") }
        root.cacheDisplay(in: root.bounds, to: rep)
        try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
        print("wrote \(out)")
    }
}
