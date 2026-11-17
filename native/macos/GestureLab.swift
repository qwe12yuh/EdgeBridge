// SPDX-License-Identifier: MIT
// Source-only, explicitly enabled lab. Does not replace the ordinary desktop receiver.
import AppKit
import ApplicationServices

let arguments = Array(CommandLine.arguments.dropFirst())
let ipcDirectory = Bundle.main.object(forInfoDictionaryKey: "EdgeBridgeIPC") as? String
let runtimeIPC = ipcDirectory ?? ""
let marker: UInt64 = 0x45424745
struct HeartbeatLease {
    var lastGood: TimeInterval
    mutating func observe(_ text: String?, wallMs: Double, uptime: TimeInterval) {
        if let text, let time = Double(text), wallMs - time >= -1000, wallMs - time < 2000 { lastGood = uptime }
    }
    func alive(_ uptime: TimeInterval) -> Bool { uptime - lastGood < 2 }
    func expired(_ uptime: TimeInterval) -> Bool { uptime - lastGood > 5 }
}
func emit(_ value: [String: Any]) {
    var message = value
    message["monotonicNs"] = String(DispatchTime.now().uptimeNanoseconds)
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    if let directory = ipcDirectory {
        let file = directory + "/events.jsonl"
        if !FileManager.default.fileExists(atPath: file) { FileManager.default.createFile(atPath: file, contents: nil) }
        if let handle = FileHandle(forWritingAtPath: file) {
            handle.seekToEndOfFile(); handle.write(data); handle.write(Data([10])); try? handle.close()
        }
    } else { print(String(decoding: data, as: UTF8.self)); fflush(stdout) }
}
struct Commit {
    let id: String
    let generation: UInt32
    init?(_ message: [String: Any]) {
        guard message["command"] as? String == "commit",
              let id = message["id"] as? String, UUID(uuidString: id) != nil,
              let number = message["generation"] as? NSNumber,
              number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue > 0, number.doubleValue <= Double(UInt32.max) else { return nil }
        self.id = id; generation = number.uint32Value
    }
}
// A destination event is accepted only for this one permitted receiver/window.
struct NativeStartPermit {
    let eventNumber: Int
    let windowNumber: Int
    let tag: UInt64
    let deadline: TimeInterval
    var consumed = false
    func matches(event: Int, window: Int, tag: UInt64, now: TimeInterval) -> Bool {
        !consumed && event == eventNumber && window == windowNumber &&
            tag == self.tag && tag != 0 && now <= deadline
    }
    mutating func consume(event: Int, window: Int, tag: UInt64, now: TimeInterval) -> Bool {
        guard matches(event: event, window: window, tag: tag, now: now) else { return false }
        consumed = true
        return true
    }
}
if arguments == ["--self-test"] {
    let id = UUID().uuidString
    precondition(Commit(["command": "commit", "id": id, "generation": 1])?.generation == 1)
    precondition(Commit(["command": "commit", "id": id, "generation": -1]) == nil)
    precondition(Commit(["command": "commit", "id": id, "generation": 1.5]) == nil)
    precondition(Commit(["command": "commit", "id": "old", "generation": 1]) == nil)
    let tag = (UInt64(17) << 32) | marker
    precondition(UInt32(tag >> 32) == 17 && UInt32(tag & 0xffffffff) == UInt32(marker))
    var lease = HeartbeatLease(lastGood: 0)
    lease.observe("10000", wallMs: 10000, uptime: 10)
    lease.observe(nil, wallMs: 10020, uptime: 10.02)
    precondition(lease.alive(10.02) && !lease.expired(10.02))
    precondition(!lease.alive(12.1) && lease.expired(15.1))
    var permit = NativeStartPermit(eventNumber: 42, windowNumber: 8, tag: 123, deadline: 10)
    precondition(!permit.consume(event: 43, window: 8, tag: 123, now: 9))
    precondition(!permit.consume(event: 42, window: 9, tag: 123, now: 9))
    precondition(!permit.consume(event: 42, window: 8, tag: 124, now: 9))
    precondition(permit.consume(event: 42, window: 8, tag: 123, now: 9))
    precondition(!permit.consume(event: 42, window: 8, tag: 123, now: 9))
    var expired = NativeStartPermit(eventNumber: 42, windowNumber: 8, tag: 123, deadline: 10)
    precondition(!expired.consume(event: 42, window: 8, tag: 123, now: 11))
    print("PASS: gesture validation, generation marker, heartbeat and one-use local start permit; no UI/input")
    exit(0)
}
guard arguments.isEmpty, ipcDirectory != nil else {
    fputs("GestureLab requires a private EdgeBridgeIPC bundle configuration, or --self-test\n", stderr); exit(1)
}

final class ReverseView: NSView, NSDraggingSource {
    weak var owner: ReverseIncoming?
    init(owner: ReverseIncoming) { self.owner = owner; super.init(frame: NSRect(x: 0, y: 0, width: 48, height: 48)) }
    required init?(coder: NSCoder) { fatalError() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        guard let event, let owner, !owner.cancelled, !owner.completed else { return false }
        return owner.startPermit?.matches(event: event.eventNumber, window: event.windowNumber,
                                          tag: UInt64(bitPattern: event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0),
                                          now: ProcessInfo.processInfo.systemUptime) == true
    }
    override func mouseDown(with event: NSEvent) { owner?.begin(from: event, in: self) }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func draggingSession(_ session: NSDraggingSession, willBeginAt point: NSPoint) {
        guard let owner else { return }
        owner.started = true
        if owner.cancelled || owner.completed || reverseIncoming !== owner { owner.postEscape(); return }
        emit(["event": "drag-loop-running", "id": owner.id, "generation": owner.generation,
              "dragSequence": session.draggingSequenceNumber, "mouseButtons": NSEvent.pressedMouseButtons])
    }
    func draggingSession(_ session: NSDraggingSession, movedTo point: NSPoint) {
        guard let owner else { return }
        owner.moves += 1
        if owner.moves == 1 {
            emit(["event": "drag-first-moved", "id": owner.id, "generation": owner.generation,
                  "x": point.x, "y": point.y, "nativeUptimeMs": ProcessInfo.processInfo.systemUptime * 1000])
        }
        let window = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
        if window > 0 && window != owner.lastWindow {
            owner.lastWindow = window
            emit(["event": "target-window", "id": owner.id, "generation": owner.generation, "window": window,
                  "observation": "window-under-cursor"])
        }
    }
    func draggingSession(_ session: NSDraggingSession, endedAt point: NSPoint, operation: NSDragOperation) {
        owner?.finish(operation.contains(.copy), point: point)
    }
}
final class ReverseIncoming {
    let id: String
    let generation: UInt32
    let paths: [String]
    var panel: NSPanel?
    var view: ReverseView?
    var started = false, cancelled = false, completed = false, activating = false
    var lastWindow = 0
    var moves = 0
    var startPermit: NativeStartPermit?
    var startDeadline: TimeInterval = 0
    var physicalEventNumber = 0
    var downPosted = false
    var eventSource: CGEventSource?
    init(id: String, generation: UInt32, paths: [String]) { self.id = id; self.generation = generation; self.paths = paths }
    func activate(physicalDownEventNumber: Int) {
        guard !activating && !cancelled else { return }
        activating = true
        emit(["event": "activate-requested", "id": id, "generation": generation, "mouseButtons": NSEvent.pressedMouseButtons])
        let point = NSEvent.mouseLocation
        let panel = NSPanel(contentRect: NSRect(x: point.x - 24, y: point.y - 24, width: 48, height: 48),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .popUpMenu; panel.isOpaque = false; panel.isReleasedWhenClosed = false
        panel.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.03)
        panel.ignoresMouseEvents = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let view = ReverseView(owner: self); panel.contentView = view
        self.panel = panel; self.view = view; panel.orderFrontRegardless()
        physicalEventNumber = physicalDownEventNumber
        startDeadline = ProcessInfo.processInfo.systemUptime + 0.5
        guard let position = CGEvent(source: nil)?.location else { finish(false); return }
        emit(["event": "destination-start-request", "id": id, "generation": generation,
              "pid": ProcessInfo.processInfo.processIdentifier, "window": panel.windowNumber,
              "x": position.x, "y": position.y, "physicalDownEventNumber": physicalEventNumber])
    }
    func startPermitted(_ message: [String: Any]) {
        guard activating, !started, !cancelled, !completed, !downPosted, reverseIncoming === self,
              ProcessInfo.processInfo.systemUptime < startDeadline,
              let panel, panel.isVisible, message["window"] as? Int == panel.windowNumber,
              message["pid"] as? Int == Int(ProcessInfo.processInfo.processIdentifier),
              message["physicalDownEventNumber"] as? Int == physicalEventNumber,
              let text = message["nonce"] as? String, text.count == 16, text.hasPrefix("45424453"),
              let tag = UInt64(text, radix: 16),
              let expires = message["expiresUptimeMs"] as? Double,
              expires > ProcessInfo.processInfo.systemUptime * 1000,
              expires - ProcessInfo.processInfo.systemUptime * 1000 <= 300,
              let position = CGEvent(source: nil)?.location,
              let source = CGEventSource(stateID: .combinedSessionState) else { cancel(); return }
        let point = NSEvent.mouseLocation
        panel.setFrameOrigin(NSPoint(x: point.x - 24, y: point.y - 24))
        let all: CGEventFilterMask = [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents]
        source.setLocalEventsFilterDuringSuppressionState(all, state: .eventSuppressionStateRemoteMouseDrag)
        source.setLocalEventsFilterDuringSuppressionState(all, state: .eventSuppressionStateSuppressionInterval)
        source.localEventsSuppressionInterval = 0
        guard let event = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
                                  mouseCursorPosition: position, mouseButton: .left) else { cancel(); return }
        event.setIntegerValueField(.eventSourceUserData, value: Int64(bitPattern: tag))
        event.setIntegerValueField(.mouseEventNumber, value: Int64(physicalEventNumber))
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        startPermit = NativeStartPermit(eventNumber: physicalEventNumber, windowNumber: panel.windowNumber,
                                        tag: tag, deadline: min(startDeadline, expires / 1000))
        eventSource = source; downPosted = true
        emit(["event": "destination-start-posted", "id": id, "generation": generation,
              "window": panel.windowNumber, "x": position.x, "y": position.y])
        // The isolated router admits this single nonce only for the current held generation.
        // Its final event tap verifies the actual target; it also owns release balancing.
        event.post(tap: .cghidEventTap)
    }
    func begin(from event: NSEvent, in view: ReverseView) {
        emit(["event": "destination-down-observed", "id": id, "generation": generation,
              "eventNumber": event.eventNumber, "window": event.windowNumber,
              "currentEvent": NSApp.currentEvent === event, "downPosted": downPosted,
              "nonceMatches": UInt64(bitPattern: event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0) == startPermit?.tag,
              "expectedNumber": physicalEventNumber, "expectedWindow": panel?.windowNumber ?? 0])
        guard activating, !started, !cancelled, !completed, reverseIncoming === self,
              view === self.view, NSApp.currentEvent === event, event.type == .leftMouseDown,
              startPermit?.consume(event: event.eventNumber, window: event.windowNumber,
                                   tag: UInt64(bitPattern: event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0),
                                   now: ProcessInfo.processInfo.systemUptime) == true else {
            emit(["event": "destination-start-refused", "id": id, "generation": generation,
                  "reason": "Actual destination down did not match the one-use window permit"])
            cancel(); return
        }
        emit(["event": "local-start-received", "id": id, "generation": generation,
              "currentEvent": NSApp.currentEvent === event, "mouseButtons": NSEvent.pressedMouseButtons,
              "eventNumber": event.eventNumber,
              "quartzEventNumber": event.cgEvent?.getIntegerValueField(.mouseEventNumber) ?? -1])
        let items = paths.map { file -> NSDraggingItem in
            let item = NSDraggingItem(pasteboardWriter: NSURL(fileURLWithPath: file))
            item.setDraggingFrame(NSRect(x: 8, y: 8, width: 32, height: 32), contents: NSWorkspace.shared.icon(forFile: file))
            return item
        }
        view.beginDraggingSession(with: items, event: event, source: view)
        emit(["event": "begin-returned", "id": id, "generation": generation])
    }
    func finish(_ copied: Bool, point: NSPoint = .zero) {
        guard !completed else { return }; completed = true
        panel?.ignoresMouseEvents = true; panel?.orderOut(nil)
        emit(["event": "ended", "id": id, "generation": generation, "copied": copied && !cancelled,
              "accepted": copied && !cancelled, "dropX": point.x, "dropY": point.y,
              "nativeEndedUptimeMs": ProcessInfo.processInfo.systemUptime * 1000,
              "nativeMovedCallbacks": moves,
              "error": cancelled ? "Native AppKit drag cancelled" : ""])
        if reverseIncoming === self { reverseIncoming = nil }
    }
    func cancel() {
        guard !completed, !cancelled else { return }; cancelled = true
        let neverDispatched = startPermit?.consumed != true
        panel?.ignoresMouseEvents = true
        startPermit = nil
        if !started && (!activating || neverDispatched) { finish(false); return }
        postEscape()
        // A failed local cancellation must not leave an invisible system drag alive.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, !self.completed else { return }
            emit(["event": "source-exiting", "reason": "AppKit did not acknowledge cancellation"])
            NSApp.terminate(nil)
        }
    }
    func postEscape() {
        if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel?.windowNumber ?? 0,
            context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
            NSApp.postEvent(event, atStart: true)
        }
    }
}
var reverseIncoming: ReverseIncoming?

final class Capture: NSView {
    struct Session {
        let id: String
        let sequence: Int
        let observedGeneration: UInt32
        let paths: [String]
        var generation: UInt32?
        var accepted = false
    }
    var session: Session?
    var tracking = false
    var candidateGeneration: UInt32?
    var blockedGeneration: UInt32?
    var candidateDeadline: TimeInterval = 0
    override init(frame: NSRect) { super.init(frame: frame); registerForDraggedTypes([.fileURL]) }
    required init?(coder: NSCoder) { fatalError() }
    override func wantsPeriodicDraggingUpdates() -> Bool { true }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        emit(["event": "source-entered", "hasSession": session != nil, "trusted": AXIsProcessTrusted(),
              "mask": sender.draggingSourceOperationMask.rawValue,
              "types": sender.draggingPasteboard.types?.map(\.rawValue) ?? []])
        guard reverseIncoming == nil, let generation = candidateGeneration, generation != blockedGeneration else { emit(["event": "source-ignored", "reason": "No physical drag candidate, retired generation or receiver busy"]); return [] }
        guard session == nil, AXIsProcessTrusted(), sender.draggingSourceOperationMask.contains(.copy),
              let files = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
              !files.isEmpty else { emit(["event": "source-ignored", "reason": "Busy, untrusted, copy disallowed or no file URLs"]); return [] }
        let value = Session(id: UUID().uuidString, sequence: sender.draggingSequenceNumber, observedGeneration: generation, paths: files.map(\.path))
        session = value; tracking = true
        emit(["event": "source-prepare", "id": value.id, "paths": value.paths, "dragSequence": value.sequence,
              "observedUptimeMs": ProcessInfo.processInfo.systemUptime * 1000, "observedGeneration": generation])
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard let session, sender.draggingSequenceNumber == session.sequence else { return [] }
        tracking = true
        return .copy
    }
    override func draggingExited(_ sender: NSDraggingInfo?) {
        tracking = false
        if let session, !session.accepted {
            emit(["event": "source-left", "id": session.id]); self.session = nil
        }
        window?.ignoresMouseEvents = true
    }
    func commit(_ command: Commit) {
        guard var value = session, value.id == command.id, value.generation == nil, value.observedGeneration == command.generation,
              ProcessInfo.processInfo.systemUptime < candidateDeadline, tracking,
              let window, window.isVisible, window.frame.contains(NSEvent.mouseLocation), AXIsProcessTrusted(),
              let position = CGEvent(source: nil)?.location,
              let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: position, mouseButton: .left) else {
            emit(["event": "source-refused", "id": command.id, "reason": "Original drag no longer targets this edge"]); return
        }
        value.generation = command.generation; session = value
        let tag = (UInt64(command.generation) << 32) | marker
        event.setIntegerValueField(.eventSourceUserData, value: Int64(bitPattern: tag))
        emit(["event": "source-logical-release", "id": value.id, "generation": command.generation])
        // A participating test router must authorize this one tagged event first.
        event.post(tap: .cghidEventTap)
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let session else { return false }
        return tracking && session.sequence == sender.draggingSequenceNumber && session.generation != nil
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard var value = session, tracking, value.sequence == sender.draggingSequenceNumber,
              value.generation != nil else { return false }
        value.accepted = true; session = value
        return true // copy-only capture; never move or delete the original files
    }
    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        guard let value = session, value.accepted, let generation = value.generation else { return }
        emit(["event": "source-accepted", "id": value.id, "generation": generation])
        reset()
    }
    func reset() { if let session { blockedGeneration = session.observedGeneration }; session = nil; tracking = false; window?.ignoresMouseEvents = true }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    var capture: Capture!
    var timer: Timer?
    var consumed: UInt64 = 0
    var pending = Data()
    var heartbeat = HeartbeatLease(lastGood: ProcessInfo.processInfo.systemUptime)
    var candidateUntil: TimeInterval = 0
    var candidateSeq: Double = 0
    var wasArmed = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.screens.first else { NSApp.terminate(nil); return }
        let frame = screen.frame
        let rect = NSRect(x: frame.maxX - 12, y: frame.minY, width: 12, height: frame.height)
        panel = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .popUpMenu; panel.isOpaque = false
        panel.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.04)
        panel.isReleasedWhenClosed = false; panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        capture = Capture(frame: NSRect(origin: .zero, size: rect.size)); panel.contentView = capture
        panel.orderFrontRegardless()
        if let attrs = try? FileManager.default.attributesOfItem(atPath: runtimeIPC + "/commands.jsonl") {
            consumed = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
        }
        emit(["event": "source-ready", "accessibility": AXIsProcessTrusted(), "pid": ProcessInfo.processInfo.processIdentifier,
              "mode": "gesture-lab-only", "frame": NSStringFromRect(rect)])
        let timer = Timer(timeInterval: 0.02, repeats: true) { [weak self] _ in self?.tick() }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common) // includes drag tracking, not only default mode
    }
    func tick() {
        let now = Date().timeIntervalSince1970 * 1000
        let uptime = ProcessInfo.processInfo.systemUptime
        heartbeat.observe(try? String(contentsOfFile: runtimeIPC + "/heartbeat", encoding: .utf8), wallMs: now, uptime: uptime)
        if !heartbeat.alive(uptime) {
            panel.ignoresMouseEvents = true
            if heartbeat.expired(uptime) { emit(["event": "source-exiting", "reason": "Heartbeat lease expired"]); capture.reset(); NSApp.terminate(nil) }
            return
        }
        readCommands()
        if let receiver = reverseIncoming, receiver.activating, !receiver.started, uptime > receiver.startDeadline { receiver.cancel() }
        let armed = uptime < candidateUntil && capture.candidateGeneration != nil && capture.candidateGeneration != capture.blockedGeneration && AXIsProcessTrusted()
        panel.ignoresMouseEvents = !armed
        if armed != wasArmed {
            wasArmed = armed
            emit(["event": armed ? "candidate-open" : "candidate-closed", "generation": Int(capture.candidateGeneration ?? 0)])
        }
    }
    func readCommands() {
        guard let handle = FileHandle(forReadingAtPath: runtimeIPC + "/commands.jsonl") else { return }
        defer { try? handle.close() }
        let length = handle.seekToEndOfFile()
        if length < consumed { consumed = 0; pending.removeAll() }
        handle.seek(toFileOffset: consumed)
        let bytes = handle.readData(ofLength: 65536); consumed += UInt64(bytes.count); pending.append(bytes)
        if pending.count > 131072 { capture.reset(); NSApp.terminate(nil); return }
        var messages: [[String: Any]] = []
        while let end = pending.firstIndex(of: 10) {
            let line = pending.prefix(upTo: end); pending.removeSubrange(...end)
            guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
            messages.append(message)
        }
        if messages.contains(where: { $0["command"] as? String == "shutdown" }) {
            reverseIncoming?.cancel(); capture.reset(); NSApp.terminate(nil); return
        }
        let cancelledIncoming = Set(messages.filter { $0["command"] as? String == "incoming-cancel" }.compactMap { $0["id"] as? String })
        let resetSources = Set(messages.filter { $0["command"] as? String == "reset" }.compactMap { $0["id"] as? String })
        if let id = capture.session?.id, resetSources.contains(id) { capture.reset() }
        if let receiver = reverseIncoming, cancelledIncoming.contains(receiver.id) { receiver.cancel() }
        var reportedCancellation = Set<String>()
        for message in messages {
            if let id = message["id"] as? String, cancelledIncoming.contains(id),
               let kind = message["command"] as? String, ["incoming-prepare", "incoming-activate"].contains(kind) {
                if reportedCancellation.insert(id).inserted {
                    emit(["event": "ended", "id": id, "generation": message["generation"] ?? 0,
                          "copied": false, "accepted": false, "error": "Cancelled before activation"])
                }
                continue
            }
            if let id = message["id"] as? String, resetSources.contains(id), message["command"] as? String == "commit" { continue }
            if message["command"] as? String == "shutdown" { reverseIncoming?.cancel(); capture.reset(); NSApp.terminate(nil); return }
            if let kind = message["command"] as? String, kind.hasPrefix("incoming-"),
               let id = message["id"] as? String, UUID(uuidString: id) != nil,
               let generation = message["generation"] as? UInt32, generation > 0 {
                if kind == "incoming-prepare" {
                    guard reverseIncoming == nil, capture.session == nil,
                          let paths = message["paths"] as? [String], !paths.isEmpty,
                          paths.allSatisfy({ $0.hasPrefix("/") && FileManager.default.fileExists(atPath: $0) }) else {
                        emit(["event": "ended", "id": id, "generation": generation, "copied": false, "accepted": false,
                              "error": "Mac receiver busy or pre-positioned path missing"]); continue
                    }
                    reverseIncoming = ReverseIncoming(id: id, generation: generation, paths: paths)
                    emit(["event": "prepared", "id": id, "generation": generation])
                } else if let receiver = reverseIncoming, receiver.id == id, receiver.generation == generation {
                    if kind == "incoming-activate" {
                        if let number = message["physicalDownEventNumber"] as? Int, number >= Int(Int32.min), number <= Int(Int32.max) {
                            receiver.activate(physicalDownEventNumber: number)
                        } else { receiver.cancel() }
                    }
                    if kind == "incoming-start-permitted" { receiver.startPermitted(message) }
                    if kind == "incoming-cancel" { receiver.cancel() }
                    // If release wins the startup race, retire the click-catching window now.
                    // An active AppKit drag still ends only on the matching real HID up.
                    if kind == "incoming-release" && !receiver.started { receiver.cancel() }
                }
            }
            if message["command"] as? String == "candidate", let generation = message["generation"] as? UInt32,
               let seq = message["seq"] as? Double, seq > candidateSeq,
               let time = message["time"] as? Double, abs(Date().timeIntervalSince1970 * 1000 - time) < 500,
               let leaseMs = message["leaseMs"] as? Double, leaseMs > 0, leaseMs <= 500 {
                candidateSeq = seq; capture.candidateGeneration = generation
                candidateUntil = ProcessInfo.processInfo.systemUptime + leaseMs / 1000
                capture.candidateDeadline = candidateUntil
            }
            if message["command"] as? String == "candidate-ended", let seq = message["seq"] as? Double, seq > candidateSeq {
                candidateSeq = seq; candidateUntil = 0; capture.candidateDeadline = 0; capture.candidateGeneration = nil
            }
            if message["command"] as? String == "reset", message["id"] as? String == capture.session?.id { capture.reset() }
            if let command = Commit(message) { capture.commit(command) }
        }
    }
    func applicationWillTerminate(_ notification: Notification) { emit(["event": "source-stopped"]); timer?.invalidate(); reverseIncoming?.panel?.orderOut(nil); capture?.reset() }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate; app.setActivationPolicy(.accessory); app.run()
