// SPDX-License-Identifier: MIT
import AppKit
import ApplicationServices

let ipc = Bundle.main.object(forInfoDictionaryKey: "EdgeBridgeIPC") as? String
func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
        if let ipc = ipc {
            let file = ipc + "/events.jsonl"
            if !FileManager.default.fileExists(atPath: file) { FileManager.default.createFile(atPath: file, contents: nil) }
            if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Data((line + "\n").utf8)); try? handle.close() }
        } else { print(line); fflush(stdout) }
    }
}
func mouse(_ kind: CGEventType) {
    guard let point = CGEvent(source: nil)?.location,
          let event = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: point, mouseButton: .left) else { return }
    event.setIntegerValueField(.eventSourceUserData, value: 0x45424745)
    event.post(tap: .cghidEventTap)
}
var incoming: Incoming?
var lastHeartbeat = Date()
final class Source: NSView, NSDraggingSource {
    let files: [String]
    let id: String
    init(files: [String], id: String) { self.files = files; self.id = id; super.init(frame: NSRect(x: 0, y: 0, width: 48, height: 48)) }
    required init?(coder: NSCoder) { fatalError() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        incoming?.started = true
        let items = files.map { file -> NSDraggingItem in
            let item = NSDraggingItem(pasteboardWriter: NSURL(fileURLWithPath: file))
            item.setDraggingFrame(NSRect(x: 0, y: 0, width: 32, height: 32), contents: NSWorkspace.shared.icon(forFile: file))
            return item
        }
        beginDraggingSession(with: items, event: event, source: self)
        window?.setFrameOrigin(NSPoint(x: -32000, y: -32000))
        output(["event": "native-drag-started", "id": id])
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func draggingSession(_ session: NSDraggingSession, endedAt point: NSPoint, operation: NSDragOperation) {
        output(["event": "native-drag-ended", "id": id, "copied": operation.contains(.copy) && incoming?.cancelled != true])
        incoming?.timer?.invalidate(); incoming?.panel.orderOut(nil); incoming = nil
        if !edgeMode { NSApp.terminate(nil) }
    }
}
final class Incoming {
    let id: String
    let panel: NSPanel
    var cancelled = false
    var started = false
    var timer: Timer?
    init(files: [String], id: String, automatic: Bool) {
        self.id = id
        let point = NSEvent.mouseLocation
        panel = NSPanel(contentRect: NSRect(x: point.x - 24, y: point.y - 24, width: 48, height: 48),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .popUpMenu; panel.isOpaque = false
        panel.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.15)
        let source = Source(files: files, id: id)
        panel.contentView = source
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = automatic
        panel.orderFrontRegardless()
        if automatic {
            // Construct AppKit's initiating event locally. Never post a global mouse-down.
            DispatchQueue.main.async {
                guard incoming?.id == id, !self.cancelled else { return }
                guard NSEvent.pressedMouseButtons & 1 != 0,
                      let event = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 24, y: 24),
                          modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                          windowNumber: self.panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else {
                    output(["event": "native-drag-ended", "id": id, "copied": false, "error": "Mouse button released before native drag was ready"])
                    self.timer?.invalidate(); self.panel.orderOut(nil); incoming = nil; return
                }
                source.mouseDown(with: event)
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in self?.cancel() }
    }
    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        panel.orderOut(nil)
        if !started {
            timer?.invalidate()
            output(["event": "native-drag-ended", "id": id, "copied": false, "error": "Native drag cancelled before start"])
            incoming = nil; return
        }
        // Escape goes only to this application's drag loop, never through Deskflow/HID.
        if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber,
            context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
            NSApp.postEvent(event, atStart: true)
        }
    }
}
struct Command {
    let kind: String
    let id: String
    let files: [String]
    init?(_ line: String) {
        guard line.utf8.count <= 65536,
              let message = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let kind = message["command"] as? String else { return nil }
        if kind == "shutdown" { self.kind = kind; id = ""; files = []; return }
        guard let id = message["id"] as? String, UUID(uuidString: id) != nil else { return nil }
        if kind == "cancel" { self.kind = kind; self.id = id; files = []; return }
        guard kind == "incoming", let files = message["paths"] as? [String], !files.isEmpty, files.count <= 1000,
              files.allSatisfy({ !$0.isEmpty }), let time = message["time"] as? Double else { return nil }
        let age = Date().timeIntervalSince1970 * 1000 - time
        guard age >= -1000 && age <= 10000 else { return nil }
        self.kind = kind; self.id = id; self.files = files
    }
}
func dispatch(_ command: Command) {
    if command.kind == "shutdown" { incoming?.cancel(); NSApp.terminate(nil); return }
    if command.kind == "cancel" { if incoming?.id == command.id { incoming?.cancel() }; return }
    guard incoming == nil, command.files.allSatisfy({ FileManager.default.fileExists(atPath: $0) }) else {
        output(["event": "native-drag-ended", "id": command.id, "copied": false, "error": "Native helper busy or staged path missing"]); return
    }
    guard NSEvent.pressedMouseButtons & 1 != 0 else {
        output(["event": "native-drag-ended", "id": command.id, "copied": false, "error": "Mouse button released before native drag was ready"]); return
    }
    incoming = Incoming(files: command.files, id: command.id, automatic: true)
}
final class EdgeView: NSView {
    var handing = false
    var paths: [String] = []
    override init(frame: NSRect) { super.init(frame: frame); registerForDraggedTypes([.fileURL]) }
    required init?(coder: NSCoder) { fatalError() }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard incoming == nil, !handing, sender.draggingSourceOperationMask.contains(.copy), AXIsProcessTrusted(),
              let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty else { return [] }
        paths = urls.map(\.path)
        output(["event": "drag-entered", "count": paths.count, "accessibility": AXIsProcessTrusted()])
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard !paths.isEmpty, incoming == nil else { return [] }
        if !handing {
            handing = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { if self.handing { mouse(.leftMouseUp) } }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                self.handing = false; self.paths = []; self.window?.ignoresMouseEvents = true
            }
        }
        return .copy
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { !paths.isEmpty }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let selected = paths; paths = []
        output(["event": "outgoing", "paths": selected])
        window?.orderOut(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.handing = false; self.window?.orderFrontRegardless() }
        return true
    }
    override func draggingExited(_ sender: NSDraggingInfo?) { if !handing { paths = [] } }
}
let args = Array(CommandLine.arguments.dropFirst())
let edgeMode = args.isEmpty || args.first == "--edge"
let side = edgeMode && args.count > 1 ? args[1] : "right"
if args.first == "--self-test" {
    let id = UUID().uuidString
    let message: [String: Any] = ["command": "incoming", "id": id, "paths": ["/example.txt"], "time": Date().timeIntervalSince1970 * 1000]
    let line = String(data: try! JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
    guard Command(line)?.files == ["/example.txt"],
          Command("{\"command\":\"incoming\",\"paths\":[\"x\"],\"id\":\"\(id)\",\"time\":1}") == nil,
          Command("{\"command\":\"cancel\",\"id\":\"\(id)\"}")?.kind == "cancel",
          Command("{\"command\":\"incoming\",\"id\":\"bad\"}") == nil else { exit(2) }
    print("PASS: native command IDs, JSON arrays, expiry and cancellation (no UI/input events)"); exit(0)
}
if args.first == "--check" {
    let files = Array(args.dropFirst())
    guard !files.isEmpty, files.allSatisfy({ FileManager.default.fileExists(atPath: $0) }) else { exit(1) }
    print("Native paths valid: \(files.count)"); exit(0)
}
final class Delegate: NSObject, NSApplicationDelegate {
    var edge: NSPanel?
    var commandTimer: Timer?
    var edgeTimer: Timer?
    var lastDragCount = NSPasteboard(name: .drag).changeCount
    var fileDragging = false
    var consumed = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        if edgeMode {
            guard side == "left" || side == "right", let screen = NSScreen.screens.first else { exit(1) }
            let frame = screen.frame
            let rect = NSRect(x: side == "right" ? frame.maxX - 12 : frame.minX, y: frame.minY, width: 12, height: frame.height)
            let w = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            w.level = .popUpMenu; w.isOpaque = false; w.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.08)
            w.ignoresMouseEvents = true
            w.contentView = EdgeView(frame: NSRect(origin: .zero, size: rect.size)); w.isReleasedWhenClosed = false
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; w.orderFrontRegardless(); edge = w
            output(["event": "edge-ready", "side": side, "accessibility": AXIsProcessTrusted()])
            edgeTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
                let board = NSPasteboard(name: .drag)
                let held = NSEvent.pressedMouseButtons & 1 != 0
                if !held { self.fileDragging = false }
                if board.changeCount != self.lastDragCount {
                    self.lastDragCount = board.changeCount
                    if held && board.types?.contains(.fileURL) == true { self.fileDragging = true }
                }
                let enable = self.fileDragging && incoming == nil && AXIsProcessTrusted() && (ipc == nil || Date().timeIntervalSince(lastHeartbeat) < 2)
                w.ignoresMouseEvents = !enable
                let width: CGFloat = enable ? 96 : 12
                w.setFrame(NSRect(x: side == "right" ? frame.maxX - width : frame.minX, y: frame.minY, width: width, height: frame.height), display: false)
            }
            if let ipc = ipc {
                // Old commands belong to a previous launch and must never be replayed.
                consumed = ((try? String(contentsOfFile: ipc + "/commands.jsonl", encoding: .utf8)) ?? "").split(separator: "\n").count
                commandTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
                    if let text = try? String(contentsOfFile: ipc + "/heartbeat", encoding: .utf8), let time = Double(text),
                       abs(Date().timeIntervalSince1970 * 1000 - time) < 2000 { lastHeartbeat = Date() }
                    if Date().timeIntervalSince(lastHeartbeat) > 5 { incoming?.cancel(); w.ignoresMouseEvents = true; NSApp.terminate(nil); return }
                    guard let text = try? String(contentsOfFile: ipc + "/commands.jsonl", encoding: .utf8) else { return }
                    let lines = text.split(separator: "\n")
                    if self.consumed > lines.count { self.consumed = 0 }
                    for line in lines.dropFirst(self.consumed) {
                        if let command = Command(String(line)) { dispatch(command) }
                    }
                    self.consumed = lines.count
                }
                return
            }
            DispatchQueue.global().async {
                while let line = readLine() {
                    guard let command = Command(line) else { continue }
                    DispatchQueue.main.async { dispatch(command) }
                }
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        } else {
            let files = args.first == "--auto" ? Array(args.dropFirst()) : args
            guard !files.isEmpty, files.allSatisfy({ FileManager.default.fileExists(atPath: $0) }) else { exit(1) }
            incoming = Incoming(files: files, id: UUID().uuidString, automatic: args.first == "--auto")
        }
    }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate; app.setActivationPolicy(.accessory); app.run()
