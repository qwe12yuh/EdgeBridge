# Changelog

## Unreleased

- Separate staging deadline (4500ms default, configurable below the router's 5s prepare limit).
- Hash gesture uploads while streaming, without a second file read; verify HTTP SHA-256 trailers.
- Map nonportable filenames and deduplicate selection names without changing source paths.

## 0.1.0-alpha.1 — 2026-11-17

First source preview.

- Independent MIT file transport, pinned TLS and SHA-256 validation.
- Correlated physical gestures, native AppKit/OLE handoff and separately licensed Deskflow route integration.
- Ordinary PPT cross-screen drag/drop manually verified in both directions on one Mac/Windows pair.
- 50 Node tests, native compilation/self-tests and separate adapter regressions.
- Developer documentation, private configuration templates and reproducible source packaging.

Known limits: full staging, 64MiB gesture batch, manual setup and a Windows late-result cancellation-reporting issue. No signed installers or automatic startup.
