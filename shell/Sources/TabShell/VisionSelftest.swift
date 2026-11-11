// --vision-selftest: the vision fallback on a drawn window image, offscreen. A toolbar of text and four icons
// (circle, square frame, triangle, a two-part magnifier), one icon-sized shape on the canvas, a labelled diagram box and
// a bigger unlabelled game piece go through VisionSensor.read. Checks: the text is read, each icon gets one box (the
// magnifier's parts merged) and none covers text, the diagram box is named by its text, unknown icons and shapes are
// sent for naming, and once named they come back with their names. Uses a throwaway icon cache.
import AppKit

func runVisionSelftest() -> Never {
    let cache = NSTemporaryDirectory() + "tab-vision-selftest-\(getpid()).json"
    setenv("TAB_ICON_CACHE", cache, 1)
    defer { try? FileManager.default.removeItem(atPath: cache) }
    var failures = 0
    func check(_ ok: Bool, _ what: String) {
        print("\(ok ? "ok  " : "FAIL") \(what)")
        if !ok { failures += 1 }
    }

    let W = 800, H = 500, scale = 2 // a Retina capture: pixels are twice the points
    let ctx = CGContext(data: nil, width: W * scale, height: H * scale, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    // Draw in top-left points: y = H - top - height.
    func box(_ x: Double, _ top: Double, _ w: Double, _ h: Double) -> CGRect { CGRect(x: x, y: Double(H) - top - h, width: w, height: h) }
    ctx.setFillColor(CGColor(gray: 0.97, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    ("Layers   Brush   Export" as NSString).draw(at: CGPoint(x: 20, y: Double(H) - 34), withAttributes: [.font: NSFont.systemFont(ofSize: 16)])
    ctx.setFillColor(CGColor(red: 0.1, green: 0.3, blue: 0.8, alpha: 1))
    let icons: [(String, CGRect)] = [("circle", box(40, 84, 36, 36)), ("square", box(140, 84, 36, 36)), ("triangle", box(240, 84, 36, 36)), ("magnifier", box(340, 84, 36, 36))]
    ctx.fillEllipse(in: icons[0].1)
    ctx.fill(icons[1].1)
    ctx.setFillColor(CGColor(gray: 0.97, alpha: 1)); ctx.fill(icons[1].1.insetBy(dx: 8, dy: 8)) // a frame: a solid block has no features
    ctx.setFillColor(CGColor(red: 0.1, green: 0.3, blue: 0.8, alpha: 1))
    let t = icons[2].1
    ctx.move(to: CGPoint(x: t.minX, y: t.minY)); ctx.addLine(to: CGPoint(x: t.maxX, y: t.minY)); ctx.addLine(to: CGPoint(x: t.midX, y: t.maxY)); ctx.fillPath()
    ctx.setStrokeColor(CGColor(red: 0.1, green: 0.3, blue: 0.8, alpha: 1)); ctx.setLineWidth(4)
    ctx.strokeEllipse(in: box(342, 86, 22, 22)) // glass
    ctx.move(to: CGPoint(x: 362, y: Double(H) - 108)); ctx.addLine(to: CGPoint(x: 374, y: Double(H) - 118)); ctx.strokePath() // handle, 1.5 pt apart
    ctx.setFillColor(CGColor(red: 0.8, green: 0.2, blue: 0.1, alpha: 1)); ctx.fillEllipse(in: box(600, 360, 40, 40))
    // Bigger canvas content: a diagram box with a label in it, and a game piece with none.
    ctx.setStrokeColor(CGColor(gray: 0.2, alpha: 1)); ctx.setLineWidth(2)
    ctx.stroke(box(60, 300, 200, 80))
    ("Login service" as NSString).draw(at: CGPoint(x: 100, y: Double(H) - 352), withAttributes: [.font: NSFont.systemFont(ofSize: 18)])
    ctx.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 1))
    let piece = box(380, 260, 140, 140)
    ctx.fillEllipse(in: piece)
    ctx.setFillColor(CGColor(gray: 0.97, alpha: 1)); ctx.fillEllipse(in: piece.insetBy(dx: 40, dy: 40)) // a ring: features for the hash
    let image = ctx.makeImage()!
    let frame = Rect(x: 100, y: 50, w: Double(W), h: Double(H)) // the window's place on screen

    let (els, reqs, ms) = VisionSensor.read(image, frame: frame)
    print(String(format: "read %d elements: text %.0f ms, icons %.0f ms", els.count, ms.textMs, ms.objectsMs))
    for e in els { print("  \(e.path ?? "") \(Int(e.rect.x)),\(Int(e.rect.y)) \(Int(e.rect.w))×\(Int(e.rect.h)) \(e.label)") }
    let text = els.filter { $0.path?.hasPrefix("ocr:") == true }
    let isShape = { (e: El) in e.help?.hasPrefix("shape") == true }
    let objs = els.filter { $0.path?.hasPrefix("vis:") == true && !isShape($0) }
    let shapes = els.filter(isShape)
    let near = { (e: El, x: Double, y: Double, w: Double, h: Double) in abs(e.rect.x - (frame.x + x)) <= 4 && abs(e.rect.y - (frame.y + y)) <= 4 && abs(e.rect.w - w) <= 4 && abs(e.rect.h - h) <= 4 }
    check(shapes.count == 2, "two canvas shapes (\(shapes.count))")
    check(shapes.contains { near($0, 60, 300, 200, 80) && $0.label == "Login service" }, "the diagram box is named by its text")
    let pieceEl = shapes.first { near($0, 380, 260, 140, 140) }
    check(pieceEl != nil && pieceEl!.label.isEmpty, "the game piece is found, unnamed until the vision model names it")
    check(text.contains { $0.label.contains("Layers") } && text.contains { $0.label.contains("Export") }, "toolbar text read")
    // Expected boxes in screen points (window origin + top-left box), within 4 pt.
    var expected = icons.map { ($0.0, Rect(x: frame.x + $0.1.minX, y: frame.y + Double(H) - $0.1.maxY, w: $0.1.width, h: $0.1.height)) }
    expected.append(("canvas circle", Rect(x: frame.x + 600, y: frame.y + 360, w: 40, h: 40)))
    for (name, r) in expected {
        let hit = objs.filter { abs($0.rect.x - r.x) <= 4 && abs($0.rect.y - r.y) <= 4 && abs($0.rect.w - r.w) <= 4 && abs($0.rect.h - r.h) <= 4 }
        check(hit.count == 1, "one box for the \(name)")
    }
    check(objs.count == expected.count, "no other boxes (\(objs.count))")
    check(!objs.contains { o in text.contains { t in o.rect.x < t.rect.x + t.rect.w && t.rect.x < o.rect.x + o.rect.w && o.rect.y < t.rect.y + t.rect.h && t.rect.y < o.rect.y + o.rect.h } }, "no box covers text")
    check(reqs.count == Set(objs.map { $0.path! }).count + 1 && objs.allSatisfy { $0.label.isEmpty }, "unknown icons and the unnamed shape sent for naming (\(reqs.count))")

    // The hub names them; the next read carries the names and asks for nothing.
    IconLabeler.store(reqs.enumerated().map { (hash: $0.element.hash, label: "Icon \($0.offset)") })
    let (again, reqs2, _) = VisionSensor.read(image, frame: frame)
    let named = again.filter { $0.path?.hasPrefix("vis:") == true && !isShape($0) }
    check(named.count == objs.count && named.allSatisfy { $0.label.hasPrefix("Icon ") && $0.help == "icon, named by vision" }, "named icons come back with their names")
    check(again.contains { $0.path == pieceEl?.path && $0.label.hasPrefix("Icon ") && $0.help == "shape on the canvas, named by vision" }, "the named shape comes back with its name")
    check(reqs2.isEmpty, "nothing asked twice")
    check(VisionSensor.rect(for: named.first?.path ?? "") != nil, "a named icon can be clicked (its rect is known)")

    print(failures == 0 ? "vision selftest passed" : "vision selftest: \(failures) failed")
    exit(failures == 0 ? 0 : 1)
}
