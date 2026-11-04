# Changelog

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
