# mfm-js (Misskey fork)

This is the MFM parser from [misskey-dev/mfm.js](https://github.com/misskey-dev/mfm.js), vendored from upstream commit `356ba3e8446f86d76c35fe1a931edef90ba2b975` (mfm-js 0.26.0). It remains MIT-licensed; see `LICENSE` for the upstream copyright notice.

The workspace keeps the published package name, so Misskey's backend and frontend packages resolve `mfm-js` without import-site changes. Upstream synchronization is intentionally manual so parser behavior can be optimized and extended in this repository.
