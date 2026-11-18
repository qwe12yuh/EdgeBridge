// SPDX-License-Identifier: MIT
// Development launcher only. The external Deskflow build retains its own license.
import AppKit
import ApplicationServices
if Array(CommandLine.arguments.dropFirst()) == ["--request-accessibility"] {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    print(AXIsProcessTrustedWithOptions([key: true] as CFDictionary) ? "Accessibility: authorized" : "Accessibility: pending")
    exit(0)
}
final class Launcher: NSObject, NSApplicationDelegate {
    var child: Process?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let executable = info["EdgeBridgeCore"] as? String,
              let settings = info["EdgeBridgeSettings"] as? String,
              let socket = info["EdgeBridgeRouteSocket"] as? String,
              let log = info["EdgeBridgeLog"] as? String else { NSApp.terminate(nil); return }
        if !FileManager.default.fileExists(atPath: log) { FileManager.default.createFile(atPath: log, contents: nil) }
        guard let output = FileHandle(forWritingAtPath: log) else { NSApp.terminate(nil); return }
        output.seekToEndOfFile()
        let directory = URL(fileURLWithPath: settings).deletingLastPathComponent()
        let mode = (try? String(contentsOf: directory.appendingPathComponent("launch-mode"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        let probe = mode == "probe"
        guard probe || AXIsProcessTrusted() else {
            output.write(Data("Router launcher requires macOS Accessibility authorization\n".utf8))
            try? output.close(); NSApp.terminate(nil); return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = probe ? ["--version"] : ["server", "--settings", settings]
        process.currentDirectoryURL = directory
        var environment = ProcessInfo.processInfo.environment
        environment["EDGEBRIDGE_ROUTE_SOCKET"] = socket
        environment["XDG_CONFIG_HOME"] = directory.appendingPathComponent("xdg-config").path
        environment["XDG_STATE_HOME"] = directory.appendingPathComponent("state").path
        process.environment = environment
        process.standardOutput = output; process.standardError = output
        process.terminationHandler = { _ in DispatchQueue.main.async { NSApp.terminate(nil) } }
        do { try process.run(); child = process }
        catch { output.write(Data("Router launch failed: \(error)\n".utf8)); NSApp.terminate(nil) }
    }
    func applicationWillTerminate(_ notification: Notification) {
        if let child, child.isRunning { child.terminate() }
    }
}
let app = NSApplication.shared
let launcher = Launcher()
app.delegate = launcher; app.setActivationPolicy(.accessory); app.run()
