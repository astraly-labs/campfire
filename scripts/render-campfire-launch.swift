import AppKit
import AVFoundation
import CoreVideo

private let canvas = CGSize(width: 1600, height: 1000)
private let fps: Int32 = 30
private let duration = 15.0

private struct Palette {
    static let paper = NSColor(calibratedRed: 247 / 255, green: 248 / 255, blue: 252 / 255, alpha: 1)
    static let ink = NSColor(calibratedRed: 24 / 255, green: 25 / 255, blue: 29 / 255, alpha: 1)
    static let ember = NSColor(calibratedRed: 47 / 255, green: 92 / 255, blue: 216 / 255, alpha: 1)
    static let blue = ember
    static let line = NSColor(calibratedRed: 223 / 255, green: 226 / 255, blue: 234 / 255, alpha: 1)
    static let muted = NSColor(calibratedRed: 111 / 255, green: 114 / 255, blue: 128 / 255, alpha: 1)
}

private func clamp(_ value: Double, _ lower: Double = 0, _ upper: Double = 1) -> Double {
    min(max(value, lower), upper)
}

private func ease(_ value: Double) -> CGFloat {
    let t = clamp(value)
    return CGFloat(t * t * (3 - 2 * t))
}

private func window(_ time: Double, _ start: Double, _ end: Double, fade: Double = 0.35) -> CGFloat {
    let fadeIn = clamp((time - start) / fade)
    let fadeOut = clamp((end - time) / fade)
    return CGFloat(min(fadeIn, fadeOut))
}

private func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> NSRect {
    NSRect(x: x, y: y, width: width, height: height)
}

private func font(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    NSFont.systemFont(ofSize: size, weight: weight)
}

private func drawText(
    _ value: String,
    in target: NSRect,
    size: CGFloat,
    weight: NSFont.Weight = .regular,
    color: NSColor = Palette.ink,
    alignment: NSTextAlignment = .left,
    alpha: CGFloat = 1
) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = alignment
    paragraph.lineBreakMode = .byWordWrapping
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font(size, weight: weight),
        .foregroundColor: color.withAlphaComponent(alpha),
        .paragraphStyle: paragraph,
        .kern: size > 28 ? -0.8 : 0,
    ]
    value.draw(in: target, withAttributes: attributes)
}

private func roundedRect(
    _ target: NSRect,
    radius: CGFloat,
    fill: NSColor,
    stroke: NSColor? = nil,
    lineWidth: CGFloat = 1
) {
    let path = NSBezierPath(roundedRect: target, xRadius: radius, yRadius: radius)
    fill.setFill()
    path.fill()
    if let stroke {
        stroke.setStroke()
        path.lineWidth = lineWidth
        path.stroke()
    }
}

private func drawBrand(alpha: CGFloat = 1) {
    roundedRect(rect(72, 62, 38, 38), radius: 11, fill: Palette.ink.withAlphaComponent(alpha))
    drawText("C", in: rect(72, 67, 38, 28), size: 18, weight: .bold, color: .white, alignment: .center, alpha: alpha)
    drawText("CAMPFIRE", in: rect(125, 68, 190, 28), size: 19, weight: .semibold, alpha: alpha)
    drawText("A THIN FORK OF T3 CODE", in: rect(1310, 69, 220, 24), size: 12, weight: .medium, color: Palette.muted, alignment: .right, alpha: alpha)
}

private func drawScreenshot(_ image: NSImage, time: Double, focusX: CGFloat = 0.5, focusY: CGFloat = 0.5, zoom: CGFloat = 1) {
    let base = rect(70, 126, 1460, 812)
    let scale = 0.985 + 0.015 * ease((time - 1.55) / 1.2)
    let visibleZoom = max(1, zoom)
    let sourceSize = image.size
    let cropWidth = sourceSize.width / visibleZoom
    let cropHeight = sourceSize.height / visibleZoom
    let cropX = (sourceSize.width - cropWidth) * focusX
    let cropY = (sourceSize.height - cropHeight) * (1 - focusY)
    let source = rect(cropX, cropY, cropWidth, cropHeight)
    let targetWidth = base.width * scale
    let targetHeight = base.height * scale
    let target = rect(
        base.midX - targetWidth / 2,
        base.midY - targetHeight / 2,
        targetWidth,
        targetHeight
    )

    NSGraphicsContext.current?.cgContext.saveGState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.16)
    shadow.shadowBlurRadius = 40
    shadow.shadowOffset = NSSize(width: 0, height: -14)
    shadow.set()
    roundedRect(target, radius: 24, fill: .white)
    NSGraphicsContext.current?.cgContext.restoreGState()

    NSGraphicsContext.current?.cgContext.saveGState()
    NSBezierPath(roundedRect: target, xRadius: 24, yRadius: 24).addClip()
    image.draw(
        in: target,
        from: source,
        operation: .copy,
        fraction: 1,
        respectFlipped: true,
        hints: [.interpolation: NSImageInterpolation.high]
    )
    NSGraphicsContext.current?.cgContext.restoreGState()
    roundedRect(target, radius: 24, fill: .clear, stroke: Palette.line, lineWidth: 1.5)
}

private func drawCursor(at point: CGPoint, pressed: CGFloat = 0, alpha: CGFloat = 1) {
    let scale = 1 - 0.12 * pressed
    let cursorPath = NSBezierPath()
    cursorPath.move(to: point)
    cursorPath.line(to: CGPoint(x: point.x + 8 * scale, y: point.y + 28 * scale))
    cursorPath.line(to: CGPoint(x: point.x + 14 * scale, y: point.y + 18 * scale))
    cursorPath.line(to: CGPoint(x: point.x + 25 * scale, y: point.y + 29 * scale))
    cursorPath.line(to: CGPoint(x: point.x + 30 * scale, y: point.y + 24 * scale))
    cursorPath.line(to: CGPoint(x: point.x + 19 * scale, y: point.y + 13 * scale))
    cursorPath.line(to: CGPoint(x: point.x + 30 * scale, y: point.y + 8 * scale))
    cursorPath.close()
    NSColor.white.withAlphaComponent(alpha).setFill()
    cursorPath.fill()
    Palette.ink.withAlphaComponent(alpha).setStroke()
    cursorPath.lineWidth = 2.2
    cursorPath.stroke()

    if pressed > 0.05 {
        let ripple = 30 + 28 * pressed
        let ring = NSBezierPath(ovalIn: rect(point.x - ripple / 2, point.y - ripple / 2, ripple, ripple))
        Palette.ember.withAlphaComponent(alpha * (1 - pressed) * 0.7).setStroke()
        ring.lineWidth = 3
        ring.stroke()
    }
}

private func drawTakeALook(time: Double) {
    let alpha = window(time, 3.35, 6.3)
    guard alpha > 0 else { return }
    let y = 357 + 10 * (1 - ease((time - 3.35) / 0.45))
    roundedRect(rect(1042, y, 172, 50), radius: 25, fill: Palette.ink.withAlphaComponent(alpha))
    drawText("Take a Look", in: rect(1060, y + 13, 135, 25), size: 17, weight: .semibold, color: .white, alignment: .center, alpha: alpha)

    let clickProgress = CGFloat(clamp((time - 4.05) / 0.32))
    let cursorStart = CGPoint(x: 1280, y: 455)
    let cursorEnd = CGPoint(x: 1153, y: y + 21)
    let cursorEase = ease((time - 3.45) / 0.7)
    let cursor = CGPoint(
        x: cursorStart.x + (cursorEnd.x - cursorStart.x) * cursorEase,
        y: cursorStart.y + (cursorEnd.y - cursorStart.y) * cursorEase
    )
    let pressed = sin(.pi * min(max(clickProgress, 0), 1))
    drawCursor(at: cursor, pressed: pressed, alpha: alpha)

    let popoverAlpha = window(time, 4.35, 6.3, fade: 0.28)
    guard popoverAlpha > 0 else { return }
    roundedRect(rect(1010, 423, 282, 170), radius: 22, fill: .white.withAlphaComponent(popoverAlpha), stroke: Palette.line.withAlphaComponent(popoverAlpha))
    drawText("Bring a teammate in", in: rect(1034, 447, 230, 30), size: 18, weight: .semibold, alpha: popoverAlpha)
    roundedRect(rect(1034, 491, 42, 42), radius: 21, fill: NSColor(calibratedRed: 1, green: 0.82, blue: 0.85, alpha: popoverAlpha))
    drawText("BR", in: rect(1034, 503, 42, 20), size: 13, weight: .bold, alignment: .center, alpha: popoverAlpha)
    drawText("Ben Roy", in: rect(1090, 494, 105, 24), size: 17, weight: .medium, alpha: popoverAlpha)
    drawText("Frontend", in: rect(1090, 518, 105, 20), size: 13, color: Palette.muted, alpha: popoverAlpha)
    roundedRect(rect(1202, 496, 62, 34), radius: 17, fill: Palette.blue.withAlphaComponent(popoverAlpha))
    drawText("Ping", in: rect(1202, 504, 62, 22), size: 14, weight: .semibold, color: .white, alignment: .center, alpha: popoverAlpha)
}

private func drawInboxMoment(time: Double) {
    let alpha = window(time, 6.1, 8.55, fade: 0.32)
    guard alpha > 0 else { return }
    roundedRect(rect(95, 205, 405, 210), radius: 24, fill: .white.withAlphaComponent(alpha), stroke: Palette.line.withAlphaComponent(alpha))
    drawText("INBOX", in: rect(123, 232, 100, 22), size: 12, weight: .bold, color: Palette.muted, alpha: alpha)
    roundedRect(rect(421, 226, 46, 28), radius: 14, fill: Palette.ember.withAlphaComponent(alpha))
    drawText("1", in: rect(421, 232, 46, 19), size: 13, weight: .bold, color: .white, alignment: .center, alpha: alpha)
    roundedRect(rect(121, 275, 350, 112), radius: 18, fill: Palette.paper.withAlphaComponent(alpha))
    roundedRect(rect(143, 297, 38, 38), radius: 19, fill: NSColor(calibratedRed: 1, green: 0.82, blue: 0.64, alpha: alpha))
    drawText("AO", in: rect(143, 307, 38, 18), size: 12, weight: .bold, alignment: .center, alpha: alpha)
    drawText("Ada mentioned you", in: rect(195, 294, 230, 24), size: 16, weight: .semibold, alpha: alpha)
    drawText("Ship the onboarding together", in: rect(195, 324, 240, 22), size: 15, color: Palette.muted, alpha: alpha)
    drawText("Open the exact thread  →", in: rect(195, 351, 240, 20), size: 13, weight: .medium, color: Palette.blue, alpha: alpha)

    let cursorEase = ease((time - 6.65) / 0.75)
    let cursor = CGPoint(x: 545 - 110 * cursorEase, y: 450 - 110 * cursorEase)
    let click = CGFloat(sin(.pi * clamp((time - 7.42) / 0.3)))
    drawCursor(at: cursor, pressed: click, alpha: alpha)
}

private func drawPresenceAndReply(time: Double) {
    let alpha = window(time, 8.25, 11.25, fade: 0.35)
    guard alpha > 0 else { return }
    roundedRect(rect(1010, 144, 255, 58), radius: 29, fill: .white.withAlphaComponent(alpha), stroke: Palette.line.withAlphaComponent(alpha))
    roundedRect(rect(1030, 156, 34, 34), radius: 17, fill: NSColor(calibratedRed: 1, green: 0.82, blue: 0.64, alpha: alpha))
    drawText("AO", in: rect(1030, 165, 34, 17), size: 10, weight: .bold, alignment: .center, alpha: alpha)
    roundedRect(rect(1057, 156, 34, 34), radius: 17, fill: NSColor(calibratedRed: 1, green: 0.82, blue: 0.85, alpha: alpha), stroke: .white.withAlphaComponent(alpha), lineWidth: 2)
    drawText("BR", in: rect(1057, 165, 34, 17), size: 10, weight: .bold, alignment: .center, alpha: alpha)
    drawText("Ben joined", in: rect(1108, 164, 132, 22), size: 15, weight: .medium, alpha: alpha)

    let replyAlpha = window(time, 8.95, 11.25, fade: 0.36)
    let replyY = 565 + 18 * (1 - ease((time - 8.95) / 0.5))
    roundedRect(rect(725, replyY, 590, 92), radius: 24, fill: Palette.ink.withAlphaComponent(replyAlpha))
    drawText("Tighten the mobile breakpoint, then rerun the checks.", in: rect(757, replyY + 23, 505, 29), size: 18, weight: .medium, color: .white, alpha: replyAlpha)
    drawText("BR", in: rect(1268, replyY + 58, 28, 17), size: 11, weight: .bold, color: .white, alignment: .center, alpha: replyAlpha * 0.75)
}

private func drawFeatureRail(time: Double) {
    let alpha = window(time, 11.35, 13.4, fade: 0.3)
    guard alpha > 0 else { return }
    let items = ["SHARED THREADS", "REVIEW CHATS", "PRIVATE BRIEFINGS"]
    let widths: [CGFloat] = [205, 190, 220]
    var x: CGFloat = 470
    for (index, item) in items.enumerated() {
        roundedRect(rect(x, 843, widths[index], 52), radius: 26, fill: Palette.ink.withAlphaComponent(alpha * 0.94))
        if index == 0 {
            roundedRect(rect(x + 18, 862, 13, 13), radius: 6.5, fill: Palette.ember.withAlphaComponent(alpha))
        }
        drawText(item, in: rect(x + (index == 0 ? 40 : 16), 859, widths[index] - (index == 0 ? 52 : 32), 22), size: 13, weight: .bold, color: .white, alignment: .center, alpha: alpha)
        x += widths[index] + 16
    }
}

private func drawOpening(time: Double) {
    let alpha = window(time, 0, 2.35, fade: 0.55)
    guard alpha > 0 else { return }
    drawText("The agent workspace", in: rect(180, 325, 1240, 92), size: 76, weight: .medium, alignment: .center, alpha: alpha)
    drawText("was already here.", in: rect(180, 408, 1240, 92), size: 76, weight: .medium, color: Palette.ember, alignment: .center, alpha: alpha)
    drawText("So we brought the team into it.", in: rect(400, 548, 800, 44), size: 24, weight: .regular, color: Palette.muted, alignment: .center, alpha: alpha)
}

private func drawCaption(_ value: String, time: Double, start: Double, end: Double) {
    let alpha = window(time, start, end, fade: 0.3)
    guard alpha > 0 else { return }
    roundedRect(rect(430, 57, 740, 54), radius: 27, fill: Palette.ink.withAlphaComponent(alpha * 0.96))
    drawText(value, in: rect(454, 71, 692, 28), size: 18, weight: .medium, color: .white, alignment: .center, alpha: alpha)
}

private func drawEndCard(time: Double) {
    let alpha = ease((time - 13.15) / 0.55)
    guard alpha > 0 else { return }
    Palette.paper.withAlphaComponent(alpha).setFill()
    NSBezierPath(rect: rect(0, 0, canvas.width, canvas.height)).fill()
    drawBrand(alpha: alpha)
    drawText("Bring teammates into", in: rect(170, 286, 1260, 92), size: 74, weight: .medium, alignment: .center, alpha: alpha)
    drawText("the agent workspace.", in: rect(170, 372, 1260, 92), size: 74, weight: .medium, color: Palette.ember, alignment: .center, alpha: alpha)
    drawText("CAMPFIRE", in: rect(450, 550, 700, 70), size: 42, weight: .bold, alignment: .center, alpha: alpha)
    drawText("Multiplayer T3 Code for trusted teams.", in: rect(400, 625, 800, 38), size: 22, color: Palette.muted, alignment: .center, alpha: alpha)
    drawText("Built as a thin fork of T3 Code by Julius Marminge, Theo Browne & contributors.", in: rect(300, 830, 1000, 28), size: 14, color: Palette.muted, alignment: .center, alpha: alpha * 0.8)
}

private func renderFrame(time: Double, thread: NSImage, discussion: NSImage, into pixelBuffer: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
    guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer),
          let context = CGContext(
              data: baseAddress,
              width: Int(canvas.width),
              height: Int(canvas.height),
              bitsPerComponent: 8,
              bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
          ) else { return }

    context.translateBy(x: 0, y: canvas.height)
    context.scaleBy(x: 1, y: -1)
    let graphics = NSGraphicsContext(cgContext: context, flipped: true)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    Palette.paper.setFill()
    NSBezierPath(rect: rect(0, 0, canvas.width, canvas.height)).fill()
    drawBrand()

    if time < 2.35 {
        drawOpening(time: time)
    }

    let productAlpha = ease((time - 1.55) / 0.65) * (1 - ease((time - 13.0) / 0.45))
    if productAlpha > 0 {
        NSGraphicsContext.current?.cgContext.saveGState()
        NSGraphicsContext.current?.cgContext.setAlpha(productAlpha)
        if time < 10.75 {
            let zoom = 1 + 0.045 * ease((time - 3.0) / 7.0)
            drawScreenshot(thread, time: time, focusX: 0.62, focusY: 0.44, zoom: zoom)
        } else {
            let crossfade = ease((time - 10.75) / 0.55)
            NSGraphicsContext.current?.cgContext.setAlpha(productAlpha * (1 - crossfade))
            drawScreenshot(thread, time: time, focusX: 0.62, focusY: 0.44, zoom: 1.04)
            NSGraphicsContext.current?.cgContext.setAlpha(productAlpha * crossfade)
            drawScreenshot(discussion, time: time, focusX: 0.78, focusY: 0.45, zoom: 1.05)
        }
        NSGraphicsContext.current?.cgContext.restoreGState()
    }

    drawTakeALook(time: time)
    drawInboxMoment(time: time)
    drawPresenceAndReply(time: time)
    drawFeatureRail(time: time)
    drawCaption("Every teammate’s agent threads, one sidebar.", time: time, start: 2.0, end: 3.1)
    drawCaption("Ping the person who can unblock the work.", time: time, start: 3.1, end: 6.2)
    drawCaption("They land in the exact agent thread.", time: time, start: 6.2, end: 8.6)
    drawCaption("They can now steer the same agent.", time: time, start: 8.6, end: 10.95)
    drawCaption("Human context stays beside the work.", time: time, start: 10.9, end: 13.25)
    drawEndCard(time: time)
    NSGraphicsContext.restoreGraphicsState()
}

private func makeSilentVideo(thread: NSImage, discussion: NSImage, output: URL) throws {
    try? FileManager.default.removeItem(at: output)
    let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Int(canvas.width),
        AVVideoHeightKey: Int(canvas.height),
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: 9_000_000,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoMaxKeyFrameIntervalKey: 60,
        ],
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(canvas.width),
            kCVPixelBufferHeightKey as String: Int(canvas.height),
        ]
    )
    guard writer.canAdd(input) else { throw RenderError("Cannot add video input") }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? RenderError("Cannot start writer") }
    writer.startSession(atSourceTime: .zero)

    let frameCount = Int(duration * Double(fps))
    for frame in 0..<frameCount {
        while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
        guard let pool = adaptor.pixelBufferPool else { throw RenderError("Missing pixel buffer pool") }
        var optionalBuffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &optionalBuffer)
        guard let pixelBuffer = optionalBuffer else { throw RenderError("Cannot create pixel buffer") }
        let time = Double(frame) / Double(fps)
        renderFrame(time: time, thread: thread, discussion: discussion, into: pixelBuffer)
        let presentationTime = CMTime(value: CMTimeValue(frame), timescale: fps)
        guard adaptor.append(pixelBuffer, withPresentationTime: presentationTime) else {
            throw writer.error ?? RenderError("Cannot append frame \(frame)")
        }
    }
    input.markAsFinished()
    let semaphore = DispatchSemaphore(value: 0)
    writer.finishWriting { semaphore.signal() }
    semaphore.wait()
    guard writer.status == .completed else { throw writer.error ?? RenderError("Video writer failed") }
}

private func midiFrequency(_ note: Double) -> Double {
    440 * pow(2, (note - 69) / 12)
}

private func makeOriginalScore(output: URL) throws {
    try? FileManager.default.removeItem(at: output)
    let sampleRate = 48_000.0
    let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2)!
    let file = try AVAudioFile(forWriting: output, settings: format.settings)
    let frameCount = AVAudioFrameCount(duration * sampleRate)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)!
    buffer.frameLength = frameCount

    // Entirely synthesized here: a compact D-major groove at 126 BPM, with no samples.
    let bpm = 126.0
    let beat = 60.0 / bpm
    let bassNotes = [38.0, 38.0, 35.0, 35.0, 31.0, 31.0, 33.0, 33.0]
    let arpeggios = [
        [62.0, 66.0, 69.0, 71.0],
        [59.0, 62.0, 66.0, 69.0],
        [55.0, 59.0, 62.0, 66.0],
        [57.0, 62.0, 64.0, 69.0],
    ]
    let clickTimes = [4.12, 7.52, 10.82, 13.18]

    for channel in 0..<2 {
        guard let samples = buffer.floatChannelData?[channel] else { continue }
        for index in 0..<Int(frameCount) {
            let time = Double(index) / sampleRate
            var value = 0.0

            let beatPosition = time / beat
            let beatIndex = Int(beatPosition)
            let localBeat = beatPosition - floor(beatPosition)
            let bar = (beatIndex / 4) % arpeggios.count

            let kickLocal = localBeat * beat
            value += sin(2 * .pi * (76 - 45 * min(1, kickLocal / 0.12)) * kickLocal)
                * exp(-kickLocal * 22) * 0.34

            let snareBeat = beatIndex % 4
            if snareBeat == 1 || snareBeat == 3 {
                let noise = sin(Double(index * 43 + channel * 71))
                value += noise * exp(-kickLocal * 18) * 0.12
                value += sin(2 * .pi * 185 * kickLocal) * exp(-kickLocal * 24) * 0.06
            }

            let eighthPosition = beatPosition * 2
            let hatLocal = (eighthPosition - floor(eighthPosition)) * beat / 2
            let hatNoise = sin(Double(index * 97 + channel * 53))
            value += hatNoise * exp(-hatLocal * 90) * (beatIndex < 4 ? 0.025 : 0.045)

            let bassLocal = localBeat * beat
            let bassFrequency = midiFrequency(bassNotes[(beatIndex / 2) % bassNotes.count])
            let bassEnvelope = min(1, bassLocal / 0.012) * exp(-bassLocal * 5.5)
            value += sin(2 * .pi * bassFrequency * bassLocal) * bassEnvelope * 0.13

            let eighthIndex = Int(eighthPosition)
            let arpLocal = (eighthPosition - floor(eighthPosition)) * beat / 2
            let arpNote = arpeggios[bar][eighthIndex % 4]
            let arpFrequency = midiFrequency(arpNote + (eighthIndex % 8 == 7 ? 12 : 0))
            let arpEnvelope = min(1, arpLocal / 0.008) * exp(-arpLocal * 12)
            let stereo = channel == eighthIndex % 2 ? 1.0 : 0.72
            value += sin(2 * .pi * arpFrequency * arpLocal) * arpEnvelope * stereo * 0.075
            value += sin(2 * .pi * arpFrequency * 2 * arpLocal) * arpEnvelope * stereo * 0.018

            for clickTime in clickTimes {
                let local = time - clickTime
                guard local >= 0, local < 0.09 else { continue }
                let deterministicNoise = sin(Double(index * 17 + channel * 31))
                value += deterministicNoise * exp(-local * 55) * 0.055
                value += sin(2 * .pi * 920 * local) * exp(-local * 42) * 0.035
            }
            let fadeIn = min(1, time / 0.35)
            let fadeOut = min(1, (duration - time) / 0.65)
            samples[index] = Float(tanh(value * fadeIn * fadeOut * 1.55) * 0.74)
        }
    }
    try file.write(from: buffer)
}

private func mux(video: URL, audio: URL, output: URL) throws {
    try? FileManager.default.removeItem(at: output)
    let composition = AVMutableComposition()
    let videoAsset = AVURLAsset(url: video)
    let audioAsset = AVURLAsset(url: audio)
    guard let sourceVideo = videoAsset.tracks(withMediaType: .video).first,
          let sourceAudio = audioAsset.tracks(withMediaType: .audio).first,
          let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
          let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw RenderError("Cannot create composition tracks")
    }
    let range = CMTimeRange(start: .zero, duration: CMTime(seconds: duration, preferredTimescale: 600))
    try videoTrack.insertTimeRange(range, of: sourceVideo, at: .zero)
    try audioTrack.insertTimeRange(range, of: sourceAudio, at: .zero)
    videoTrack.preferredTransform = sourceVideo.preferredTransform

    guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
        throw RenderError("Cannot create export session")
    }
    exporter.outputURL = output
    exporter.outputFileType = .mp4
    exporter.shouldOptimizeForNetworkUse = true
    let semaphore = DispatchSemaphore(value: 0)
    exporter.exportAsynchronously { semaphore.signal() }
    semaphore.wait()
    guard exporter.status == .completed else { throw exporter.error ?? RenderError("Export failed") }
}

private struct RenderError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let threadURL = root.appendingPathComponent("docs/assets/campfire-app-thread.png")
let discussionURL = root.appendingPathComponent("docs/assets/campfire-app-team-discussion.png")
let outputURL = root.appendingPathComponent("apps/marketing/public/campfire-feature-reveal.mp4")
guard let thread = NSImage(contentsOf: threadURL), let discussion = NSImage(contentsOf: discussionURL) else {
    throw RenderError("Run from the Campfire repository root; launch screenshots are missing")
}

let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("campfire-launch-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }
let silentVideo = temporary.appendingPathComponent("picture.mov")
let score = temporary.appendingPathComponent("score.wav")

print("Rendering 15 seconds of product motion…")
try makeSilentVideo(thread: thread, discussion: discussion, output: silentVideo)
print("Synthesizing original score…")
try makeOriginalScore(output: score)
print("Muxing final web video…")
try mux(video: silentVideo, audio: score, output: outputURL)
print("Wrote \(outputURL.path)")
