# Session-driven Windows OLE lab

Independent MIT experiment in `GestureLab.cs`. This is the **receiver for the pre-staged-file experiment**, not a completed cross-device file product. It does not modify the old `NativeDrag.cs`.

Build with `powershell -File scripts/build-gesture-lab-windows.ps1 -Test` (.NET Framework 4, Windows Forms, System.Web.Extensions). Explicitly launch the result with `--stdio`; launching without a mode exits. No startup item is installed.

## Local JSONL protocol

The trusted local coordinator supplies only preconfigured fixture paths. The helper accepts local absolute existing paths, so it must never be wired directly to untrusted network path messages.

```json
{"command":"prepare","id":"d40b8076-4b9b-49d4-a852-c79587037cb6","generation":1,"seq":1,"paths":["C:/lab/fixture.txt"],"leaseMs":2000}
{"command":"activate","id":"d40b8076-4b9b-49d4-a852-c79587037cb6","generation":1,"seq":2}
{"command":"heartbeat","id":"d40b8076-4b9b-49d4-a852-c79587037cb6","generation":1,"seq":3}
{"command":"release","id":"d40b8076-4b9b-49d4-a852-c79587037cb6","generation":1,"seq":4}
```

- `prepare` validates the fixture and emits `prepared`. No drag starts. The source UUID and physical press generation must be retained end-to-end. A process remembers used UUIDs and rejects replay (up to 4096 sessions, then restart).
- Subsequent commands require the same UUID/generation and a strictly increasing, exact integer sequence. Duplicate activation, stale commands and unknown commands emit `rejected`.
- `activate` enters OLE on the STA thread. The coordinator must send it only after the authoritative router confirms source acceptance and target-screen entry.
- `heartbeat` renews the lease. Default is 2000 ms, allowed 250..5000 ms. The coordinator must continue heartbeats while waiting for a drop, even if the pointer is motionless.
- `release` is the authoritative physical release. `cancel` aborts. Release before entering the OLE loop cancels instead of starting a late drag.
- `shutdown` (no fields required), stdin EOF or lease expiry cancel. If OLE does not consume cancellation within another 1500 ms, the isolated helper process exits with code 9. Parents can additionally terminate only this helper if it becomes unresponsive. The lease is also a bound on orphan lifetime if inherited pipes remain open; there is no explicit parent-PID watcher.

Events: `ready`, `prepared`, `drag-loop-running`, `target-entered`, `target-left`, `feedback`, `ended`, `rejected`, `hard-stop`. Session events retain UUID/generation. `drag-loop-running` is emitted from the first real `IDropSource.QueryContinueDrag` invocation, never before calling `DoDragDrop`. Target entry comes from `IDropSourceNotify`; feedback is the OLE effect.

`ended.accepted` / `copied` are true only for `DRAGDROP_S_DROP` with copy effect and no cancellation. They mean the native target accepted the copy, **not** that a particular directory/file/hash has been independently verified. The coordinator must separately verify the actual chosen destination.

## Input ownership

A custom `IDropSource` uses authoritative session state, not `GetAsyncKeyState`. Only Deskflow moves the cursor. The destination path has no `SendInput`, `mouse_event`, global button presses/releases or cursor repositioning calls. The v7 reverse-source path adds the explicitly guarded edge target and local logical release described below.

To wake an idle OLE loop, the helper queues a mouse-move message with the current cursor coordinates and a local F24 key-up **to its own hidden HWND only**. No input is injected into the system input stream or another application's window. A watchdog repeats the wake until the initial callback or termination. OLE still sees actual target windows; Explorer acceptance, effects and final file placement require an interactive test.

## Verified on Windows host, 2026-11-16

- Framework C# compile: passed.
- `--self-test`: UUID, generation, sequence, fractional-sequence rejection, early release, EOF state and lease expiry passed; no drag/UI/input. The v6 check also creates the actual COM callable wrapper and requires `QueryInterface` to return S_OK for both `IDropSource` and `IDropSourceNotify`, releasing all acquired pointers.
- `--private-ole-test cancel/release/eof/lease`: each passed on a new private desktop that was **never switched onto the display**. A child is created on that desktop before STA initialization. The helper verifies the private desktop name before running its OLE test. No system cursor moves or real button actions are needed.
- With no mouse motion, the OLE loop remained alive with logical held state despite no local physical press, then returned after the scheduled terminal command (~200 ms into the test). Cancel, EOF and expiry returned `DRAGDROP_S_CANCEL`; release returned `DRAGDROP_S_DROP` with effect 0 because there was no target. Accordingly `copied=false`.
- This proves the session-controlled loop and stationary wake/cancel paths on this machine. It does **not** verify Explorer `DragEnter`, chosen-directory copy or seamless cross-screen dragging.

### v6 COM observation correction

In v5 the two interface declarations were internal. Explicit P/Invoke could still supply the source interface and run the drag loop, but OLE's later `QueryInterface(IDropSourceNotify)` returned `E_NOINTERFACE` (`0x80004002`), so target notifications were unavailable. A pure-COM reflection probe verified that result on Windows. Making both interfaces `public` makes the actual CCW return S_OK for both IIDs; `[ComVisible(true)]` alone cannot expose an internal interface. The nested implementation class need not be public.

Missing `target-entered` in v5 must be reported as an observation gap, rather than evidence that a successful native copy did not occur. Native copy completion and independent file/hash verification remain distinct evidence. v6 still requires controlled interactive confirmation of target notifications; compiling it does not modify or restart v5.

The v6 private-desktop tests observed `target-entered` with `hwnd:"0"` even though no accepting target existed. Treat the event as the raw OLE notification: a zero HWND is not evidence of a real target. Consumers must reject a zero handle when computing target observation, and a nonzero handle alone still does not prove copy acceptance or final file/hash correctness.

References: [QueryContinueDrag](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nf-oleidl-idropsource-querycontinuedrag), [IDropSourceNotify](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nn-oleidl-idropsourcenotify), [PostThreadMessage modal-loop caveat](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postthreadmessagew). Queued wake messages use a real hidden HWND, avoiding unassociated thread messages that modal loops may discard.


## v7 reverse source capture (Windows → Mac)

The same process retains the v6 receiver and adds a Windows source edge. This is still the pre-staged-file experiment: obtaining actual Explorer paths does not itself transfer their contents to Mac.

The new source edge is a 12px, no-activate, tool window on the primary display's left edge. It starts hidden and click-through. It can participate in hit testing only during a short authoritative candidate lease, and never while an incoming destination session is prepared/running. An active source capture likewise rejects destination preparation.

Additional stdin messages:

```json
{"command":"candidate","generation":23,"routeSeq":90,"source":"windows-peer","edge":"left","leaseMs":300,"observedUptimeMs":123456}
{"command":"candidate-ended","generation":23,"routeSeq":91}
{"command":"source-commit","id":"SOURCE-PREPARE-UUID","generation":23,"sourceSeq":1,"commitToken":"RANDOM-AT-LEAST-16-CHAR-TOKEN"}
{"command":"source-reset","id":"SOURCE-PREPARE-UUID","generation":23,"sourceSeq":2}
```

- `routeSeq` is the authoritative Mac router sequence, distinct from destination `seq` and source-session `sourceSeq`. Candidate leases are 50..500ms (normally 300). Delay in the Windows UI queue counts against the lease. `observedUptimeMs` is copied from the **Mac** event, never replaced with a Windows clock value.
- v8 accepts fractional millisecond `observedUptimeMs` as a finite positive JSON number and echoes its double value without integer truncation. Strings, booleans, NaN/infinity and nonpositive values are rejected. Windows `receivedAt` remains an integer local timestamp used only for the candidate lease; the two machines' clocks are never compared. The self-test covers a real fractional JSON value and its serialize/deserialize round trip.
- A live `DragEnter` with existing `CF_HDROP` paths and allowed copy allocates a new UUID and emits `source-entered`, then `source-prepare` containing paths, generation, observedGeneration, observedUptimeMs and routeSeq. Ordinary window/text drags are rejected.
- `DragOver` never schedules a release. `DragLeave`, expiry, a new generation or incoming-session occupancy immediately invalidates the captured context and emits `source-left`; stale source IDs cannot commit or reset a new context. `source-ignored` records rejected source commands or contexts.
- `source-commit` requires the same UUID/generation, increasing sourceSeq and printable commit token (16..128 characters). Immediately before acting on the UI thread it verifies the live candidate, same active DragEnter context, pointer in the edge rectangle and `WindowFromPoint` equal to its own edge HWND. Only this context can issue a local Windows `mouse_event(LEFTUP)` marked `0x45424745`. The physical button authority remains on Mac; this local release must not be treated as the real physical up.
- `source-accepted` is emitted via `BeginInvoke` **after** the managed copy `DragDrop` callback returns, then disarms/hides the edge and echoes the matching commitToken. A normal physical release over the edge without committed handoff is rejected. The coordinator must wait for this acceptance before instructing the core to switch to Mac.
- This logical release still uses a system event on Windows and is not equivalent to a platform-guaranteed targeted OLE cancellation API. The precise Explorer acceptance, no-bounce behavior and next-click recovery are an **interactive acceptance gate**; only state tests have passed for the new source path. No actual desktop source capture or release was run while building v7.

v7 `--self-test` adds state-only coverage of expired candidates, wrong generation, retreat from edge, duplicate commit and late reset. The v6 pure-COM QI checks and private-desktop stationary cancel/release/EOF/lease tests remain enabled and passed. Private tests do not construct the reverse source edge and cannot inject its logical release.

### v9 encoding and one-attempt-per-press protection

The process explicitly selects BOM-free UTF-8 for redirected stdin and stdout before parsing commands. `--encoding-probe` writes a constant Chinese PNG path without reading any user file; its redirected raw bytes were decoded and checked as UTF-8 over SSH. The pure self-test also checks a Chinese JSON path's UTF-8 byte round trip. This avoids locale-dependent CP936 output being decoded as UTF-8 by Node.

Reset, retreat and completed source capture block that physical generation. Further candidate renewals in the same held press cannot rearm it; the user must release and press again to create a new generation. A delayed accepted callback also cannot reset a different, newer source context. These changes prevent repeated source UUID preparation after rejection or transfer failure. The state self-test covers blocked-generation renewal and rearming with a new generation; no desktop drag was performed for this build.
