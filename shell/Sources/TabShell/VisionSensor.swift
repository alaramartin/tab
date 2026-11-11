// Vision fallback: for windows whose AX tree says little (canvas apps, games,
// CEF apps like Spotify), capture the window and read it on device:
//   text     Apple Vision OCR. Each line becomes a pseudo-element with a real screen rect (path "ocr:<text>").
//   objects  icon-sized shapes OCR didn't cover (Vision contours), named by the hub's small vision model through
//            IconLabeler's cache (path "vis:<image hash>", so the same icon keeps its identity across sessions).
//   shapes   larger things on a canvas (diagram boxes, images, game pieces): named by the text inside them, else by the
//            same vision model (path "vis:<image hash>" too).
// Prediction, ghosts and clicks treat both like AX elements. Needs Screen Recording permission; without it, nothing
// happens.
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
    static var lastTiming: (captureMs: Double, recogniseMs: Double, objectsMs: Double)?

    /// A path read from pixels, clicked at its last-seen rect.
    static func isPixelPath(_ p: String) -> Bool { p.hasPrefix("ocr:") || p.hasPrefix("vis:") }

    /// Crops of objects nobody has named yet, for the hub. Taken (and cleared) by the caller that forwards them.
    private static var iconRequests: [IconLabeler.Request] = []
    static func takeIconRequests() -> [IconLabeler.Request] {
        lock.lock(); defer { lock.unlock() }
        let r = iconRequests
        iconRequests = []
        return r
    }

    /// A window's AX snapshot is "poor" when it has almost no labelled controls for its size.
    static func poor(_ st: ScreenState, window: Rect?) -> Bool {
        let labelled = st.elements.filter { $0.role != "text" && !$0.label.isEmpty }.count
        guard let w = window, w.w * w.h > 300 * 200 else { return false }
        return labelled < 6
    }

    /// Capture `pid`'s frontmost on-screen window and read it. Blocking; call off the main thread.
    static func elements(pid: pid_t, maxEls: Int = 120) -> [El] {
        let t0 = CFAbsoluteTimeGetCurrent()
        guard permitted, let (image, frame) = capture(pid: pid) else { return [] }
        let capMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        let (out, reqs, timing) = read(image, frame: frame, maxEls: maxEls)
        lastTiming = (captureMs: capMs, recogniseMs: timing.textMs, objectsMs: timing.objectsMs)
        lock.lock()
        lastEls[pid] = out
        iconRequests += reqs
        lock.unlock()
        return out
    }

    /// Text lines and icon-sized objects in a window image whose frame (screen points) is `frame`.
    /// Returns the elements and crops of objects that need a name.
    static func read(_ image: CGImage, frame: Rect, maxEls: Int = 120) -> ([El], [IconLabeler.Request], (textMs: Double, objectsMs: Double)) {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .fast // ~10–45 ms; .accurate was 5× slower and read UI labels no better
        req.usesLanguageCorrection = false
        let t1 = CFAbsoluteTimeGetCurrent()
        try? VNImageRequestHandler(cgImage: image).perform([req])
        let textMs = (CFAbsoluteTimeGetCurrent() - t1) * 1000
        var out: [El] = []
        var counts: [String: Int] = [:]
        var newRects: [String: Rect] = [:]
        var textRects: [Rect] = []
        var lines: [(text: String, rect: Rect)] = []
        func add(_ base: String, role: String, label: String, rect r: Rect, help: String? = nil) {
            let n = counts[base, default: 0]
            counts[base] = n + 1
            let path = n == 0 ? base : "\(base)#\(n)"
            newRects[path] = r
            out.append(El(id: path, role: role, label: label, value: nil, options: nil, checked: nil, rect: r, enabled: true, path: path, list: nil, help: help))
        }
        // Vision's boxes are normalised with a bottom-left origin; screen points are top-left.
        func screen(_ b: CGRect) -> Rect { Rect(x: frame.x + b.minX * frame.w, y: frame.y + (1 - b.maxY) * frame.h, w: b.width * frame.w, h: b.height * frame.h) }
        for obs in (req.results ?? []).prefix(maxEls) {
            guard let cand = obs.topCandidates(1).first else { continue }
            // OCR reads a row of icons as "• q": only words of 2+ letters or digits are text (and are kept clear of icons).
            let str = cand.string
            var alnum = 0
            str.enumerateSubstrings(in: str.startIndex..., options: .byWords) { w, range, _, _ in
                let n = w?.filter { $0.isLetter || $0.isNumber }.count ?? 0
                alnum += n
                if n >= 2, let b = try? cand.boundingBox(for: range)?.boundingBox { textRects.append(screen(b)) }
            }
            guard cand.confidence >= 0.4, alnum >= 2 else { continue }
            let text = str.trimmingCharacters(in: .whitespacesAndNewlines)
            let r = screen(obs.boundingBox)
            // Short lines are usually controls (buttons, tabs, menu items); long ones are content.
            let words = text.split(separator: " ").count
            let role = words <= 4 && text.count <= 32 ? "button" : "text"
            add("ocr:" + String(text.prefix(60)), role: role, label: String(text.prefix(80)), rect: r)
            lines.append((text, r))
        }
        let t2 = CFAbsoluteTimeGetCurrent()
        var reqs: [IconLabeler.Request] = []
        let scale = Double(image.width) / frame.w
        let found = objects(in: image, frame: frame, avoid: textRects)
        func crop(_ r: Rect) -> CGImage? {
            image.cropping(to: CGRect(x: (r.x - frame.x) * scale, y: (r.y - frame.y) * scale, width: r.w * scale, height: r.h * scale).integral)
        }
        for r in found.icons.prefix(max(0, maxEls - out.count)) {
            guard let c = crop(r), let (hash, label, request) = IconLabeler.lookup(c) else { continue }
            if let request { reqs.append(request) }
            add("vis:" + hash, role: "button", label: label ?? "", rect: r, help: label == nil ? nil : "icon, named by vision")
        }
        // A shape with text in it is named by that text ("Login service"); one without is named like an icon.
        for r in found.shapes.prefix(max(0, maxEls - out.count)) {
            guard let c = crop(r) else { continue }
            let inside = lines.filter { l in l.rect.x >= r.x - 2 && l.rect.y >= r.y - 2 && l.rect.x + l.rect.w <= r.x + r.w + 2 && l.rect.y + l.rect.h <= r.y + r.h + 2 }
            let text = inside.map(\.text).joined(separator: " ")
            if !text.isEmpty {
                guard let hash = IconLabeler.dHash(c) else { continue }
                add("vis:" + hash, role: "button", label: String(text.prefix(80)), rect: r, help: "shape on the canvas")
            } else {
                guard let (hash, label, request) = IconLabeler.lookup(c) else { continue }
                if let request { reqs.append(request) }
                add("vis:" + hash, role: "button", label: label ?? "", rect: r, help: label == nil ? "shape on the canvas" : "shape on the canvas, named by vision")
            }
        }
        let objectsMs = (CFAbsoluteTimeGetCurrent() - t2) * 1000
        lock.lock()
        rects.merge(newRects) { _, b in b }
        if rects.count > 2000 { rects = newRects }
        lock.unlock()
        return (out, reqs, (textMs, objectsMs))
    }

    /// Top-level contours in screen points, sorted into icons (12–96 pt, not text; the parts of one icon merged) and
    /// shapes (bigger, at least 24 pt across, at most 60% of the window each way, not thin lines; text inside is fine).
    static func objects(in image: CGImage, frame: Rect, avoid: [Rect]) -> (icons: [Rect], shapes: [Rect]) {
        let req = VNDetectContoursRequest()
        req.maximumImageDimension = 512 // ~50 ms on an M2 for a full window
        req.detectsDarkOnLight = luminance(image) > 0.5 // light window: dark shapes; dark mode: light ones
        guard (try? VNImageRequestHandler(cgImage: image).perform([req])) != nil, let c = req.results?.first else { return ([], []) }
        func overlapsText(_ r: Rect) -> Bool {
            avoid.contains { t in r.x < t.x + t.w + 2 && t.x - 2 < r.x + r.w && r.y < t.y + t.h + 2 && t.y - 2 < r.y + r.h }
        }
        var boxes: [Rect] = []
        var shapes: [Rect] = []
        for k in c.topLevelContours.prefix(1500) {
            let b = k.normalizedPath.boundingBox // normalised, bottom-left origin
            let r = Rect(x: frame.x + b.minX * frame.w, y: frame.y + (1 - b.maxY) * frame.h, w: b.width * frame.w, h: b.height * frame.h)
            if r.w < 2 || r.h < 2 { continue }
            if r.w > 96 || r.h > 96 {
                if min(r.w, r.h) >= 24, r.w <= frame.w * 0.6, r.h <= frame.h * 0.6, max(r.w / r.h, r.h / r.w) <= 6 { shapes.append(r) }
                continue
            }
            if overlapsText(r) { continue }
            boxes.append(r)
        }
        // Parts of one icon (a magnifier's glass and handle) touch or nearly touch: merge boxes within 3 pt.
        var merged = true
        while merged {
            merged = false
            outer: for i in boxes.indices {
                for j in boxes.indices where j > i {
                    let a = boxes[i], b = boxes[j]
                    if a.x - 3 < b.x + b.w && b.x - 3 < a.x + a.w && a.y - 3 < b.y + b.h && b.y - 3 < a.y + a.h {
                        let x = min(a.x, b.x), y = min(a.y, b.y)
                        boxes[i] = Rect(x: x, y: y, w: max(a.x + a.w, b.x + b.w) - x, h: max(a.y + a.h, b.y + b.h) - y)
                        boxes.remove(at: j)
                        merged = true
                        break outer
                    }
                }
            }
        }
        let icons = boxes
            .filter { $0.w >= 12 && $0.h >= 12 && $0.w <= 96 && $0.h <= 96 && max($0.w / $0.h, $0.h / $0.w) <= 3 && !overlapsText($0) }
            .sorted { ($0.y, $0.x) < ($1.y, $1.x) }
            .prefix(24).map { $0 }
        // Biggest first when there are many (the board before its scraps), then in reading order.
        let big = shapes.sorted { $0.w * $0.h > $1.w * $1.h }.prefix(16).sorted { ($0.y, $0.x) < ($1.y, $1.x) }
        return (icons, Array(big))
    }

    /// Mean brightness, 0…1.
    private static func luminance(_ img: CGImage) -> Double {
        var px: UInt8 = 0
        guard let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 1, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return 1 }
        ctx.interpolationQuality = .medium
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return Double(px) / 255
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

    /// A crop's hash, its name if known, and a request for the hub if it was never asked about.
    static func lookup(_ crop: CGImage) -> (String, String?, Request?)? {
        // A flat crop (a solid block, blank space) hashes to all zeros or ones: nothing to tell it apart by.
        guard let h = dHash(crop), h != "0000000000000000", h != "ffffffffffffffff" else { return nil }
        lock.lock()
        let known = labels[h]
        let ask = known == nil && !pending.contains(h)
        if ask { pending.insert(h) }
        lock.unlock()
        if let l = known { return (h, l.isEmpty ? nil : l, nil) }
        guard ask, let png = NSBitmapImageRep(cgImage: crop).representation(using: .png, properties: [:]) else { return (h, nil, nil) }
        return (h, nil, Request(hash: h, png: png.base64EncodedString()))
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
            guard let crop = image.cropping(to: r.integral), let (h, label, request) = lookup(crop) else { continue }
            lock.lock()
            hashes[key(e)] = h
            lock.unlock()
            if let label { st.elements[i].label = label; st.elements[i].help = "icon, named by vision" }
            if let request { out.append(request) }
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
