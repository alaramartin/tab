// Vision fallback: for windows whose AX tree says little (canvas apps, games,
// CEF apps like Spotify), capture the window and read its text with Apple Vision, on device. Each line of text
// becomes a pseudo-element with a real screen rect (path "ocr:<text>"), so prediction, ghosts and clicks work the
// same as for AX elements. Needs Screen Recording permission; without it, nothing happens.
import AppKit
import ScreenCaptureKit
import Vision

enum VisionSensor {
    /// Paths of recent OCR elements → their screen rects, so the Actuator can click them.
    private static var rects: [String: Rect] = [:]
    private static let lock = NSLock()

    /// The last OCR elements per process, to resolve clicks on windows AX can't see into.
    private static var lastEls: [pid_t: [El]] = [:]

    /// The OCR element under a screen point (a little slack around the text, since buttons are bigger than labels).
    static func element(pid: pid_t, at p: CGPoint) -> El? {
        lock.lock(); defer { lock.unlock() }
        return lastEls[pid]?.filter { e in
            p.x >= e.rect.x - 12 && p.x <= e.rect.x + e.rect.w + 12 && p.y >= e.rect.y - 10 && p.y <= e.rect.y + e.rect.h + 10
        }.min { a, b in a.rect.w * a.rect.h < b.rect.w * b.rect.h }
    }

    static func rect(for path: String) -> Rect? {
        lock.lock(); defer { lock.unlock() }
        return rects[path]
    }

    static var permitted: Bool { CGPreflightScreenCaptureAccess() }
    static var lastTiming: (captureMs: Double, recogniseMs: Double)?

    /// A window's AX snapshot is "poor" when it has almost no labelled controls for its size.
    static func poor(_ st: ScreenState, window: Rect?) -> Bool {
        let labelled = st.elements.filter { $0.role != "text" && !$0.label.isEmpty }.count
        guard let w = window, w.w * w.h > 300 * 200 else { return false }
        return labelled < 6
    }

    /// Capture `pid`'s frontmost on-screen window and recognise its text. Blocking; call off the main thread.
    static func elements(pid: pid_t, maxEls: Int = 120) -> [El] {
        let t0 = CFAbsoluteTimeGetCurrent()
        guard permitted, let (image, frame) = capture(pid: pid) else { return [] }
        let capMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .fast // ~10–45 ms; .accurate was 5× slower and read UI labels no better
        req.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: image)
        let t1 = CFAbsoluteTimeGetCurrent()
        try? handler.perform([req])
        lastTiming = (captureMs: capMs, recogniseMs: (CFAbsoluteTimeGetCurrent() - t1) * 1000)
        var out: [El] = []
        var counts: [String: Int] = [:]
        var newRects: [String: Rect] = [:]
        for obs in (req.results ?? []).prefix(maxEls) {
            guard let cand = obs.topCandidates(1).first, cand.confidence >= 0.4 else { continue }
            let text = cand.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count >= 2 else { continue }
            // Vision's box is normalised with a bottom-left origin; screen points are top-left.
            let b = obs.boundingBox
            let r = Rect(x: frame.x + b.minX * frame.w, y: frame.y + (1 - b.maxY) * frame.h, w: b.width * frame.w, h: b.height * frame.h)
            let base = "ocr:" + String(text.prefix(60))
            let n = counts[base, default: 0]
            counts[base] = n + 1
            let path = n == 0 ? base : "\(base)#\(n)"
            newRects[path] = r
            // Short lines are usually controls (buttons, tabs, menu items); long ones are content.
            let words = text.split(separator: " ").count
            let role = words <= 4 && text.count <= 32 ? "button" : "text"
            out.append(El(id: path, role: role, label: String(text.prefix(80)), value: nil, options: nil, checked: nil, rect: r, enabled: true, path: path, list: nil))
        }
        lock.lock()
        lastEls[pid] = out
        rects.merge(newRects) { _, b in b }
        if rects.count > 2000 { rects = newRects }
        lock.unlock()
        return out
    }

    /// The window's image and frame (for icon crops).
    static func captureWindow(pid: pid_t) -> (CGImage, Rect)? { capture(pid: pid) }

    /// The largest on-screen window of `pid`, as an image plus its frame in screen points (top-left origin).
    /// Listing shareable windows costs ~150 ms: keep the window handle per app for a few seconds.
    nonisolated(unsafe) private static var winCache: (pid: pid_t, at: CFAbsoluteTime, win: SCWindow)?

    private static func capture(pid: pid_t) -> (CGImage, Rect)? {
        let sem = DispatchSemaphore(value: 0)
        var result: (CGImage, Rect)?
        Task.detached {
            defer { sem.signal() }
            var win: SCWindow? = nil
            if let c = winCache, c.pid == pid, CFAbsoluteTimeGetCurrent() - c.at < 5 { win = c.win }
            if win == nil {
                guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return }
                let wins = content.windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen && $0.windowLayer == 0 && $0.frame.width > 50 }
                win = wins.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
                if let w = win { winCache = (pid, CFAbsoluteTimeGetCurrent(), w) }
            }
            guard let win else { return }
            let cfg = SCStreamConfiguration()
            let scale = NSScreen.main?.backingScaleFactor ?? 2
            cfg.width = Int(win.frame.width * scale)
            cfg.height = Int(win.frame.height * scale)
            cfg.showsCursor = false
            let filter = SCContentFilter(desktopIndependentWindow: win)
            guard let img = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) else { return }
            // The cached handle's frame may be stale (window moved): take the live one from AX when it matches in size.
            var f = win.frame // SCWindow frames are in global points, top-left origin
            if let w = AX.focusedWindow(pid: pid), let r = AX.frame(w), abs(r.w - f.width) < 2, abs(r.h - f.height) < 2 { f = CGRect(x: r.x, y: r.y, width: r.w, height: r.h) }
            result = (img, Rect(x: f.origin.x, y: f.origin.y, w: f.width, h: f.height))
        }
        _ = sem.wait(timeout: .now() + 2)
        return result
    }
}

/// Names for icon-only controls. An unlabeled button, checkbox or tab
/// of icon size is cropped from the window, keyed by a perceptual hash (dHash), and named once by the hub's small
/// vision model ("Trash can", "Gear"). Names are cached by hash in ~/.tab/icon-labels.json, so the same icon in any
/// app is named for free afterwards. Needs Screen Recording.
enum IconLabeler {
    struct Request: Codable { var hash: String; var png: String }
    private static let lock = NSLock()
    private static var labels: [String: String] = load() // hash → name ("" = tried, no usable name)
    private static var file: URL {
        ProcessInfo.processInfo.environment["TAB_ICON_CACHE"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tab/icon-labels.json")
    }
    private static var hashes: [String: String] = [:] // "app|path|w×h" → hash, for this session
    private static var pending = Set<String>()
    static let roles: Set<String> = ["button", "checkbox", "tab", "menuitem", "link", "select"]

    private static func load() -> [String: String] {
        guard let d = try? Data(contentsOf: file) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: d)) ?? [:]
    }

    static func store(_ items: [(hash: String, label: String)]) {
        lock.lock()
        for i in items { labels[i.hash] = i.label; pending.remove(i.hash) }
        let snapshot = labels
        lock.unlock()
        if let d = try? JSONEncoder().encode(snapshot) { try? d.write(to: file, options: .atomic) }
    }

    private static func isIcon(_ e: El) -> Bool {
        e.label.isEmpty && e.axId == nil && roles.contains(e.role) && e.rect.w >= 10 && e.rect.h >= 10 && e.rect.w <= 96 && e.rect.h <= 96
    }

    /// Put known names on the snapshot's icons; return crops of icons never seen, for the hub to name.
    static func apply(_ st: inout ScreenState, pid: pid_t) -> [Request] {
        let app = st.app
        func key(_ e: El) -> String { "\(app)|\(e.path ?? e.id)|\(Int(e.rect.w))×\(Int(e.rect.h))" }
        var unknown: [Int] = []
        lock.lock()
        for (i, e) in st.elements.enumerated() where isIcon(e) {
            if let h = hashes[key(e)] {
                if let l = labels[h], !l.isEmpty { st.elements[i].label = l; st.elements[i].help = "icon, named by vision" }
            } else { unknown.append(i) }
        }
        lock.unlock()
        guard !unknown.isEmpty, VisionSensor.permitted, let (image, frame) = VisionSensor.captureWindow(pid: pid) else { return [] }
        let scale = Double(image.width) / frame.w
        var out: [Request] = []
        for i in unknown.prefix(12) {
            let e = st.elements[i]
            let x: Double = (e.rect.x - frame.x) * scale
            let y: Double = (e.rect.y - frame.y) * scale
            let r = CGRect(x: x, y: y, width: e.rect.w * scale, height: e.rect.h * scale)
            guard let crop = image.cropping(to: r.integral), let h = dHash(crop) else { continue }
            lock.lock()
            hashes[key(e)] = h
            let known = labels[h]
            let asked = pending.contains(h)
            if known == nil && !asked { pending.insert(h) }
            lock.unlock()
            if let l = known, !l.isEmpty { st.elements[i].label = l; st.elements[i].help = "icon, named by vision"; continue }
            if known == nil, !asked, let png = NSBitmapImageRep(cgImage: crop).representation(using: .png, properties: [:]) {
                out.append(Request(hash: h, png: png.base64EncodedString()))
            }
        }
        return out
    }

    /// 64-bit difference hash: 9×8 grayscale, one bit per horizontal neighbour comparison. Same icon → same hash
    /// across sizes, apps and light/dark-ish backgrounds.
    static func dHash(_ img: CGImage) -> String? {
        let w = 9, h = 8
        var px = [UInt8](repeating: 0, count: w * h)
        guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        var bits: UInt64 = 0
        for y in 0..<h { for x in 0..<(w - 1) { bits = (bits << 1) | (px[y * w + x] > px[y * w + x + 1] ? 1 : 0) } }
        return String(format: "%016llx", bits)
    }
}
