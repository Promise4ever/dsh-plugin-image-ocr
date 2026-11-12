# Changelog

## 0.4.0

- Add the automatic scene preset (`mode: auto`, now the default): PDFs use the document
  preset and images use the screenshot preset, resolved locally from the sniffed media type.
  An explicit `mode` argument (tools) or setting always overrides it; `raw` still sends no
  preset. Cache version bumped so earlier entries are ignored.
- Fix settings-page save races: edits made while a save is in flight stay dirty instead of
  being reported as saved, and external updates rebase only the fields the user did not edit,
  so the next save can no longer write back stale values. `恢复默认` no longer marks an
  already-default draft as unsaved.
- Fix cancellation and deadline handling during preparation: credential resolution, cache
  lookup and checkpoint reads now honor the configured timeout and external abort, and a
  cancelled call can no longer return a cached result.
- Cache retention is enforced: expired entries are deleted when read or written, and
  `cacheTtlDays: 0` removes cached entries it touches; resumable job checkpoints expire after
  24 hours.
- Clarify that the token lives in the local credential store and is shared across profiles of
  the same DSH installation, while recognition settings stay per profile.
- Tests: regression coverage for the page state machine (real bundle evaluated in a vm), the
  auto scene resolution, preparation-time cancellation and cache retention.

## 0.3.0

- Add a browser-half settings page registered into the DSH settings panel ("图片文字识别"):
  aistudio access-token acquisition steps and a write-only token input, model choice,
  recognition-format switches, result format, cache/timeout and hint options.
- Store the token in the harness credential store (`PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`)
  through `remote.credentials`; the token never enters profile config or the describe wire,
  and stored values outrank the launch environment.
- Add a schemastery `Config` export with volatile fields for every setting, so saves apply to
  the next OCR call without a host restart; adopt `settings.configure({ auto: false })` so the
  generated form does not duplicate the dedicated page.
- Built-in model choice: `PaddleOCR-VL-1.6` (default, layout/Markdown parsing) and
  `PP-OCRv6` (lightweight 50-language OCR pipeline, first-class small model). PP-OCR
  `ocrResults` payloads are parsed into text pages; VL `layoutParsingResults` keep working.
- Recognition-format settings: default mode, output format (markdown/text), and tri-state
  document-orientation, unwarping, layout, chart, seal and text-line-orientation switches
  (`auto` follows the mode preset; model-inapplicable switches are never sent).
- Cache keys isolate model, result format and format switches; cache version bumped.
- Read live config on every run (volatile references are unwrapped), including the deadline,
  polling interval, cache TTL and hint options; tool timeout itself is now a host ceiling.

## 0.2.1

- Local cache/checkpoint failures are now advisory: a read-only or full cache no longer fails an OCR that already succeeded, and a failed checkpoint write no longer forces a duplicate cloud submission.
- Saved jobs rejected with HTTP 404/410 are discarded and submitted once more instead of wedging every later retry.
- A call cancelled while waiting in the queue releases its upload buffer immediately and never submits.
- Cache hits no longer wait behind a running job: validation, credential lookup and cache lookup run before the submission queue.
- Response streams that error or close early are normalized to a retriable `NETWORK_ERROR`, so mid-body drops are retried like connection failures.
- `timeoutMs`, `pollIntervalMs` and `hintCooldownMs` must be whole milliseconds; fractional values are rejected instead of failing at `AbortSignal.timeout`.
- `npm run test:host` finds the desktop app's vendored DSH installation without `DSH_IMPLEMENTATION_ROOT`.
- Document cache TTL semantics (reuse window, not retention) and the absence of a per-file upload confirmation.

## 0.2.0

- Rebuild the standalone PaddleOCR-VL-1.6 REST plugin as a distributable DSH bundle.
- Fix V4 context corruption: emit identified, immutable `UserMessage` objects with a producer-owned `image-ocr` source instead of strings or legacy `plugin` sources.
- Add producer shape assertions and a real-host `strict + current` session-catalog round trip, including negative tests for the previous failure.
- Preserve post-execute decisions and existing contexts; skip blocked, cancelled and failed calls, with per-agent cooldown.
- Read credentials from local configuration/environment/an independent token file, never from an MCP entry.
- Read selected files through the DSH filesystem capability; enforce MIME and upload size limits.
- Add cooperative request cancellation, bounded rate-limit retries, persistent job checkpoints, private atomic caches and account-separated cache keys.
- Fetch text JSONL only; restrict storage URLs and never forward the API authorization to them.
- Ship ready-to-run JavaScript and a release `.tgz` suitable for DSH's URL installer. No MCP, Python, model download or install-time build required.

This release prevents new malformed contexts. It does not repair historical logs or guarantee the remote OCR service's latency or accuracy.
