# Hermes Webapp PR #93508 — Nous dark trailer

- PR: https://github.com/NousResearch/hermes-agent/pull/93508
- Video: `hermes-webapp-PR-93508-dark.mp4`, 40 seconds, 1920×1080, 30 fps, H.264/AAC.
- SHA-256: `6a9465fd1b1310071df8e511cda88ee04eec80dd6c7afc03bf6297ab491d1e8a`.
- UI source commit: `8b5da64ab107f90d88185ce01e61ee41bbae292c`.
- Capture: actual browser-hosted Hermes Desktop renderer in its built-in Nous dark theme, using disposable HOME, HERMES_HOME, and XDG roots. No recoloring filter or reconstructed UI.
- Demo scope: offline walkthrough with an explicitly seeded sample conversation, not live model inference. Theme switching, real files/Git, the host terminal, sandboxed local preview, and reload persistence were exercised.
- Limitations: no provider was configured. Provider-unavailable/failed-turn state and terminal locale warnings were observed outside the selected clean footage. This does not claim a successful model turn, a remote-authentication test, or a fresh full test-suite run.
- Test-count slide: PR-reported Linux validation at the UI source commit, not independently rerun for the trailer.
- Soundtrack: original instrumental audio synthesized from oscillators/noise for this trailer, with no sampled commercial recording. This dark edit does not use the earlier walkthrough's “Honey Bear” music.
- Technical validation: 1,200 decoded frames; no full-decode errors; measured −15.6 LUFS and −1.6 dBTP.

PR author: @BearHuddleston. Browser bridge/build lineage: @adybag14-cyber (#85604). Explicit `hermes webapp` product boundary: @seagpt (#61171). Hermes Agent is by Nous Research.

These are presentation assets on the dedicated `pr-assets-93508` branch. No asset is added to the feature branch or the PR code diff.
