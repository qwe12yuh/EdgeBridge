# Contributing

EdgeBridge is MIT-licensed. Contributions must be independently written or come from a compatible, clearly attributed source. Do not submit code copied or mechanically translated from GPL reference projects.

Run `npm test` before submitting changes. Native adapter changes also need a successful build on their target platform and an interactive drag/drop test; the `--check` smoke test alone does not validate UI behavior.

Do not commit real pairing configurations, private keys, test payloads, machine-specific addresses, user file names, or generated binaries. Test fixtures must use temporary directories and must never move or delete source files.

Prioritize the end-to-end held-button handoff before adding unrelated KVM, screen sharing, clipboard history, or discovery features.
