// autodemo-capture: the native camera. Records exactly one window (or display) with
// ScreenCaptureKit at native Retina resolution. The real cursor is hidden by default,
// so whatever the human does with their mouse never shows up in the video.
//
//   autodemo-capture windows                       -> JSON list of on-screen windows
//   autodemo-capture shot --window ID --out f.png  -> one frame of that window
//   autodemo-capture record --window ID --out f.mp4 [--fps 60] [--cursor]
//       prints {"started":epochMs,...}; stops on "stop" / EOF on stdin, then prints {"stopped":epochMs}
//       "shot PATH" on stdin saves the latest frame (a second capture would kill the recording)
//   autodemo-capture act click X Y | type TEXT | key NAME [cmd,shift,alt,ctrl] | scroll DY
//       real mouse/keyboard input at screen points (needs Accessibility permission)
import Foundation
import ScreenCaptureKit
import CoreGraphics
import AppKit
import ImageIO
import UniformTypeIdentifiers
import CoreImage
import ApplicationServices

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
func fail(_ msg: String) -> Never {
  emit(["error": msg])
  exit(1)
}
func arg(_ name: String) -> String? {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
  return a[i + 1]
}
let nowMs = { Date().timeIntervalSince1970 * 1000 }

func content() async -> SCShareableContent {
  do { return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) }
  catch { fail("Screen Recording permission is needed. Allow it in System Settings > Privacy & Security > Screen & System Audio Recording for the app running your agent (e.g. Claude or Terminal), then retry. (\(error.localizedDescription))") }
}

func filter() async -> (SCContentFilter, CGRect) {
  let c = await content()
  if let w = arg("--window") {
    guard let id = UInt32(w), let win = c.windows.first(where: { $0.windowID == id }) else { fail("window \(w) not found") }
    // Window recording = that window's rectangle of the screen (bring it to the front first).
    // On current macOS the per-window filters return blank frames for many apps (Chrome) or fail
    // when the cursor is hidden; the screen stream is what reliably has real pixels.
    guard let d = c.displays.first(where: { $0.frame.intersects(win.frame) }) ?? c.displays.first else { fail("no display") }
    let local = win.frame.offsetBy(dx: -d.frame.minX, dy: -d.frame.minY).intersection(CGRect(origin: .zero, size: d.frame.size))
    return (SCContentFilter(display: d, excludingWindows: []), local)
  }
  let d = arg("--display").flatMap { UInt32($0) }.flatMap { id in c.displays.first { $0.displayID == id } } ?? c.displays.first
  guard let disp = d else { fail("no display") }
  // --crop x,y,w,h (display points): record just that area of the screen, e.g. one app's window.
  if let c = arg("--crop")?.split(separator: ",").compactMap({ Double($0) }), c.count == 4 {
    return (SCContentFilter(display: disp, excludingWindows: []), CGRect(x: c[0], y: c[1], width: c[2], height: c[3]))
  }
  return (SCContentFilter(display: disp, excludingWindows: []), disp.frame)
}

func config(_ f: SCContentFilter, _ frame: CGRect) -> SCStreamConfiguration {
  let cfg = SCStreamConfiguration()
  // --scale 1 records at point size (about 4x smaller files; plenty for 1080p output). Default: Retina.
  let scale = arg("--scale").flatMap { Double($0) }.map { CGFloat($0) } ?? max(CGFloat(f.pointPixelScale), NSScreen.main?.backingScaleFactor ?? 2)
  cfg.width = Int(frame.width * scale)
  cfg.height = Int(frame.height * scale)
  if arg("--crop") != nil || arg("--window") != nil { cfg.sourceRect = frame }
  cfg.showsCursor = CommandLine.arguments.contains("--cursor")
  cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(Int32(arg("--fps") ?? "60") ?? 60))
  cfg.queueDepth = 6
  cfg.capturesAudio = false
  cfg.ignoreShadowsSingleWindow = true
  return cfg
}

final class Sink: NSObject, SCStreamOutput, SCStreamDelegate, SCRecordingOutputDelegate {
  var started: (() -> Void)?
  var finished: (() -> Void)?
  let lock = NSLock()
  var latest: CVPixelBuffer?
  func stream(_ s: SCStream, didOutputSampleBuffer b: CMSampleBuffer, of t: SCStreamOutputType) {
    frames += 1
    guard let px = CMSampleBufferGetImageBuffer(b) else { return } // idle frames carry no image
    lock.lock(); latest = px; lock.unlock()
  }
  var frames = 0
  var dead = false
  // macOS can end a stream on its own (display change, capture service hiccup). Tell the parent,
  // which closes this segment and starts a new one, so a long take survives.
  func stream(_ s: SCStream, didStopWithError e: Error) { dead = true; emit(["dead": "\(e.localizedDescription) (\((e as NSError).code))"]) }
  func recordingOutputDidStartRecording(_ r: SCRecordingOutput) { started?() }
  func recordingOutputDidFinishRecording(_ r: SCRecordingOutput) { finished?() }
  func recordingOutput(_ r: SCRecordingOutput, didFailWithError e: Error) { fail("recording failed: \(e.localizedDescription)") }
}

@main
struct Capture {
  static func main() async {
    _ = NSApplication.shared // connects to the window server (required for CLI capture)
    let cmd = CommandLine.arguments.dropFirst().first ?? ""
    switch cmd {
    case "windows":
      let c = await content()
      let list = c.windows
        .filter { $0.windowLayer == 0 && ($0.title ?? "") != "" && $0.frame.width > 120 && $0.frame.height > 120 && $0.owningApplication != nil }
        .map { w -> [String: Any] in
          ["id": w.windowID, "app": w.owningApplication?.applicationName ?? "", "bundle": w.owningApplication?.bundleIdentifier ?? "",
           "title": w.title ?? "", "onScreen": w.isOnScreen, "x": w.frame.minX, "y": w.frame.minY, "width": w.frame.width, "height": w.frame.height]
        }
      emit(["windows": list])

    case "shot":
      guard let out = arg("--out") else { fail("--out required") }
      let (f, frame) = await filter()
      do {
        let img: CGImage = try await SCScreenshotManager.captureImage(contentFilter: f, configuration: config(f, frame))
        let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, img, nil)
        CGImageDestinationFinalize(dest)
        emit(["file": out, "width": img.width, "height": img.height, "points": ["width": frame.width, "height": frame.height]])
      } catch { fail("screenshot failed: \(error.localizedDescription)") }

    case "record":
      guard let out = arg("--out") else { fail("--out required") }
      let (f, frame) = await filter()
      let cfg = config(f, frame)
      let sink = Sink()
      let stream = SCStream(filter: f, configuration: cfg, delegate: sink)
      let rc = SCRecordingOutputConfiguration()
      rc.outputURL = URL(fileURLWithPath: out)
      rc.outputFileType = .mp4
      rc.videoCodecType = .hevc
      let rec = SCRecordingOutput(configuration: rc, delegate: sink)
      do {
        try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
        try stream.addRecordingOutput(rec)
      } catch { fail("cannot set up recording: \(error.localizedDescription)") }
      await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
        sink.started = {
          emit(["started": nowMs(), "width": cfg.width, "height": cfg.height, "points": ["width": frame.width, "height": frame.height]])
          k.resume()
        }
        Task { do { try await stream.startCapture() } catch { fail("cannot start capture: \(error.localizedDescription)") } }
      }
      // Wait for "stop" or stdin EOF (parent died) before finishing the file.
      // stdin is read off the main thread so ScreenCaptureKit callbacks keep flowing.
      await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
        Thread.detachNewThread {
          let ci = CIContext()
          while let raw = readLine() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line == "stop" { break }
            guard line.hasPrefix("shot ") else { continue }
            let path = String(line.dropFirst(5))
            var px: CVPixelBuffer?
            for _ in 0..<40 { // up to 2s for the first frame
              sink.lock.lock(); px = sink.latest; sink.lock.unlock()
              if px != nil { break }
              Thread.sleep(forTimeInterval: 0.05)
            }
            guard let px = px, let img = ci.createCGImage(CIImage(cvPixelBuffer: px), from: CIImage(cvPixelBuffer: px).extent),
                  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
            else { emit(["error": "no frame yet"]); continue }
            CGImageDestinationAddImage(dest, img, nil)
            CGImageDestinationFinalize(dest)
            emit(["file": path, "width": img.width, "height": img.height, "points": ["width": frame.width, "height": frame.height]])
          }
          k.resume()
        }
      }
      let stoppedAt = nowMs()
      // Wait for the file to be finalized, but never forever (a dead stream may not report it).
      await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
        let once = NSLock(); var done = false
        let finish = { once.lock(); defer { once.unlock() }; if !done { done = true; k.resume() } }
        sink.finished = finish
        DispatchQueue.global().asyncAfter(deadline: .now() + 8, execute: finish)
        if !sink.dead { Task { try? await stream.stopCapture() } }
      }
      emit(["stopped": stoppedAt, "file": out])

    case "act":
      if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) {
        fail("Accessibility permission is needed for autodemo to click and type. Allow it in System Settings > Privacy & Security > Accessibility for the app running your agent (e.g. Claude or Terminal), then retry.")
      }
      let a = Array(CommandLine.arguments.dropFirst(2))
      let src = CGEventSource(stateID: .hidSystemState)
      func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap); usleep(12000) }
      switch a.first ?? "" {
      case "click":
        guard a.count >= 3, let x = Double(a[1]), let y = Double(a[2]) else { fail("act click X Y") }
        let p = CGPoint(x: x, y: y)
        post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left))
        post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
      case "type":
        for ch in a.dropFirst().joined(separator: " ") { // human-ish typing speed
          for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
            var u = Array(String(ch).utf16); e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
            post(e)
          }
          usleep(UInt32.random(in: 35000...90000))
        }
      case "key":
        let codes: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
          "left": 123, "right": 124, "down": 125, "up": 126, "pageup": 116, "pagedown": 121, "home": 115, "end": 119,
          "a": 0, "c": 8, "v": 9, "l": 37, "t": 17, "w": 13, "r": 15, "f": 3, "z": 6]
        guard a.count >= 2, let code = codes[a[1].lowercased()] else { fail("unknown key \(a.dropFirst().first ?? "")") }
        var flags = CGEventFlags()
        for m in (a.count > 2 ? a[2] : "").split(separator: ",") {
          switch m { case "cmd": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "alt": flags.insert(.maskAlternate); case "ctrl": flags.insert(.maskControl); default: break }
        }
        for down in [true, false] { let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down); e?.flags = flags; post(e) }
      case "scroll":
        guard a.count >= 2, let dy = Int32(a[1]) else { fail("act scroll DY") }
        for _ in 0..<10 { post(CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: -dy / 10, wheel2: 0, wheel3: 0)); usleep(16000) }
      default: fail("act click|type|key|scroll")
      }
      emit(["ok": true])

    default:
      print("usage: autodemo-capture windows | shot --window ID --out f.png | record --window ID --out f.mp4 [--fps 60] [--cursor]")
    }
  }
}
