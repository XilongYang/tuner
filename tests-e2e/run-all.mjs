// Runs every Playwright script in this folder against the app, served
// locally by server.mjs on 127.0.0.1:8934 (matching the URL hardcoded into
// each script). These are NOT assertion-based tests -- each script prints
// what it did/observed and relies on a human (or Claude) reading the output;
// a script "fails" here only in the sense of throwing/timing out (e.g. a
// selector never appearing), not a pass/fail assertion. Requires Playwright's
// Chromium to be installed once: `npx playwright install chromium`.
//
// Usage: node tests-e2e/run-all.mjs [pattern]
//   pattern (optional): only run scripts whose filename includes this substring.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const filterArg = process.argv[2];

const files = fs.readdirSync(DIR)
  .filter((f) => f.startsWith('test_') && f.endsWith('.mjs'))
  .filter((f) => !filterArg || f.includes(filterArg))
  .sort();

if (!files.length) {
  console.error('No matching test_*.mjs scripts found in tests-e2e/.');
  process.exit(1);
}

const server = await startServer(PORT);
console.log(`Serving app at http://127.0.0.1:${PORT}/ -- running ${files.length} script(s)\n`);

const results = [];
for (const file of files) {
  process.stdout.write(`=== ${file} ===\n`);
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIR, file)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  results.push({ file, exitCode });
  process.stdout.write(`--- exit ${exitCode} ---\n\n`);
}

server.close();

const failed = results.filter((r) => r.exitCode !== 0);
console.log(`${results.length - failed.length}/${results.length} scripts exited cleanly.`);
if (failed.length) {
  console.log('Non-zero exit:', failed.map((r) => r.file).join(', '));
}
process.exit(failed.length ? 1 : 0);
