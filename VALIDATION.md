# Validation — 2026-11-16–17

Independent MIT implementation. The modified Deskflow adapter retains its separate GPL license and is not included in this source package.

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | 50 passed, 0 failed | File transport, context revocation/races, TLS pinning, correlated native sessions, cancellation, stale events and reverse release verification |
| macOS Gesture Lab build/self-test | Passed | One-use local initiation permit, heartbeat and generation validation; no input during self-test |
| Windows Gesture Lab v9 | Passed | Framework build, UTF-8 framing, COM interface visibility and source-session guards |
| Windows OLE private desktop | 4 passed | Release, cancel, EOF and lease expiry return while the pointer is stationary; no-target release is not copy success |
| GPL route tests | 7 passed | Physical generations, leases, socket lifecycle, real-up/native-end clocks and upstream server regression |
| Bidirectional real-file upload probes | Passed | Fresh Unicode selections, pinned TLS, content verification, native prepare/cancel; no interactive drop |
| Mac → Windows fixed-file gesture | Passed twice | Human drag, actual desktop copy matches 66-byte fixture SHA-256; normal click confirmed. Content was pre-positioned in this phase |
| Windows → Mac ordinary TXT | Landed, user confirmed latest trial normal | Prior end lag ~1.1s; later scoped app-event trial ended ~267ms after physical up. First native move occurred after release, so continuous tracking is not established |
| Mac app-local event dispatch | Dispatch passed; tracking insufficient | AppKit copies the event. Corrected permit reaches mouseDown and willBegin, but PPTX/DOC repeatedly have zero native moves despite 100–256 real HID drags, then time out |
| Scoped system destination down | Windows → Mac PPTX passed | User confirmed smooth tracking and normal clicks. 68 AppKit moves before real release, up → native COPY end ~33ms. Final PID/window gate and physical-up verification both passed |
| Mac → Windows ordinary PPTX return | User-confirmed successful | Actual 202,615-byte file, target entered, OLE returned DROP+COPY. The current 2s finish deadline incorrectly reported cancellation before the late native result; telemetry/result-lifecycle issue remains |
| Bidirectional ordinary PPTX cross-screen drop | Passed by human test | User confirmed Windows → Mac was smooth, then separately confirmed the return to Windows succeeded |
| Broader interactive regression | Pending | More files, directories, final target changes, cancellation/recovery and fast release remain to be checked |
| GitHub Actions | All 3 jobs passed | [Release commit checks](https://github.com/qwe12yuh/EdgeBridge/actions/runs/44051648904): Ubuntu transport tests and macOS/Windows native compilation/self-tests; local results above are reported separately |

The receiver first stages a verified copy; staging is not a successful native drop. Transfers retain sources and never overwrite the receiver staging directory. Actual Finder/Explorer destination collision handling remains controlled by the OS.

The current development version uses a separate core/configuration and a manually started, limited-user Windows task. Its 30-minute automatic stop limit was removed after successful human acceptance; it has no startup trigger. Restore ordinary Deskflow whenever the lab is stopped for development. Logs and pairing keys remain outside the source archive.

See [GESTURE-LAB.md](GESTURE-LAB.md) for current protocol and acceptance limits; [FAILURE-ANALYSIS.md](FAILURE-ANALYSIS.md) records earlier prototype failures.
