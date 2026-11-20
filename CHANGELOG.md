# Changelog

## 0.1.0 (unreleased)

First version, built against the Imagine API contract (blooms.ai
`documentation/imagine/api.md`).

### Features

* `Imagine` client: `status()`, `presets()`, `credentials`, `references`, `jobs`,
  `images`, `sessions`, `destinations`, `webhooks`, `manifests`
* job creates with rows or a recipe, and an automatic `Idempotency-Key`
* retries with backoff and jitter on network errors, `429` and `5xx`, honouring
  `Retry-After`
* `jobs.images()` async iterator over cursor pages, and `jobs.waitFor()`
* webhook verification (`Blooms-Signature`, HMAC-SHA256, constant-time compare,
  5-minute tolerance) with test vectors shared with imagine-java
* manifest parsing
* refuses to run in a browser
