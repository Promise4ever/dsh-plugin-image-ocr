import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Guard every test, including npm pack's prepack check, against using the user's OCR cache.
const home = mkdtempSync(join(tmpdir(), 'dsh-ocr-tests-'));
try {
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), 'test/*.test.js'], {
    env: { ...process.env, DSH_HOME: home }, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { force: true, recursive: true });
}
