# Changelog

## 2.8.0

CrossStar fork release preparation; no tag or npm publication is implied.

- Add the native execution backend contract and backend discovery.
- Add durable local task execution with a persistent daemon and supervisor, recovery after Pi process restarts, and monitoring that detaches without cancelling running tasks.
- Add SSH provider persistence, endpoint-bound task discovery, cancellation, resumable remote output caching and persistent runtime bundle delivery.
- Expand persistence, restart, backend and integration coverage and document runtime contracts.
- Point repository metadata at CrossStar and disable accidental upstream npm publication with `private: true`.

Host reboot recovery (`restartOnReboot`) is not implemented or included. Persistence across a Pi process restart does not promise survival across an operating-system reboot.

Release validation and Git installation follow `docs/PUBLISHING.md`. Verify the final release tag before advertising a version-pinned Git install.
