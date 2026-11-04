// Opt-in live test; uploads only the explicitly selected file to aistudio.
import fs from 'node:fs/promises';
import { createClient, MAX_UPLOAD_BYTES } from '../lib/paddle-rest.js';
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/live-ocr.mjs <image-or-pdf-path> [screen|document|raw]');
const stat = await fs.stat(file);
if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES) throw new Error('Select a regular file no larger than 25 MiB.');
const bytes = await fs.readFile(file);
const client = createClient();
const first = await client.run(bytes, { mode: process.argv[3] || 'document' });
const second = await client.run(bytes, { mode: process.argv[3] || 'document' });
console.log(JSON.stringify({ model: first.model, mode: first.mode, pages: first.pages,
  characters: first.text.length, firstElapsedMs: first.elapsedMs, firstCached: first.cached,
  secondElapsedMs: second.elapsedMs, secondCached: second.cached, identical: first.text === second.text }));
