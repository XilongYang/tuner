// Enforcement of docs/ARCHITECTURE.md. Not a unit test: this is what stops the
// architecture from being a document that slowly stops describing the code.
//
// The previous implementation had a module whose header read "no DOM, no store,
// no network ... Safe to unit-test directly in Node" while importing a module
// that ran ~60 `document.querySelector` calls at evaluation time. It could not
// be imported in Node at all, so the logic it held -- the most intricate in the
// app -- had no tests, and the comment is why nobody noticed. Both halves of
// that are checked here: the import graph, and that the modules claiming to be
// environment-free really do load in a bare Node process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsRoot = join(root, 'js');

/** Which layer a path belongs to. `main.js` is its own layer. */
function layerOf(relPath) {
  const [first] = relPath.split('/');
  return first.endsWith('.js') ? 'main' : first;
}

/**
 * What each layer is allowed to import. Reading down the list is reading the
 * dependency direction: every layer may only name layers below its own line.
 *
 * `model` is the base of the pyramid and every layer may depend on it -- it has
 * no dependencies of its own, so it cannot create a cycle, and the alternative
 * is duplicating domain constants into the layers forbidden to reach it.
 */
const ALLOWED = {
  model: ['model'],
  platform: ['platform', 'model'],
  db: ['db', 'model'],
  cloud: ['cloud', 'model'],
  app: ['app', 'model', 'db', 'cloud', 'platform'],
  ui: ['ui', 'model', 'app'],
  main: ['model', 'platform', 'db', 'cloud', 'app', 'ui', 'main'],
};

function jsFiles(dir = jsRoot) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Static and dynamic import specifiers, resolved to repo-relative js/ paths. */
function importsOf(file) {
  const source = readFileSync(file, 'utf8');
  const specifiers = [
    ...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);

  return specifiers
    .filter((s) => s.startsWith('.'))
    .map((s) => relative(jsRoot, join(dirname(file), s)).replaceAll('\\', '/'));
}

const files = jsFiles();

test('every js module is inside a known layer', () => {
  const known = new Set(Object.keys(ALLOWED));
  for (const file of files) {
    const rel = relative(jsRoot, file).replaceAll('\\', '/');
    assert.ok(known.has(layerOf(rel)), `${rel} is in no layer declared by ALLOWED`);
  }
});

test('imports only ever point down the layer list', () => {
  const violations = [];
  for (const file of files) {
    const rel = relative(jsRoot, file).replaceAll('\\', '/');
    const from = layerOf(rel);
    for (const target of importsOf(file)) {
      const to = layerOf(target);
      if (!ALLOWED[from].includes(to)) violations.push(`${rel} (${from}) imports ${target} (${to})`);
    }
  }
  assert.deepEqual(violations, [], `disallowed imports:\n${violations.join('\n')}`);
});

test('model/ imports nothing outside model/, so it stays pure by construction', () => {
  const leaks = [];
  for (const file of files.filter((f) => relative(jsRoot, f).startsWith('model'))) {
    for (const target of importsOf(file)) {
      if (layerOf(target) !== 'model') leaks.push(`${relative(jsRoot, file)} -> ${target}`);
    }
  }
  assert.deepEqual(leaks, []);
});

test('ui/ never reaches the database or the network directly', () => {
  // The rule that removes the need for a hook indirection layer: nothing in
  // cloud/ knows the UI exists, because the UI reacts to store changes rather
  // than being called back into.
  const violations = [];
  for (const file of files.filter((f) => relative(jsRoot, f).startsWith('ui'))) {
    for (const target of importsOf(file)) {
      if (layerOf(target) === 'db' || layerOf(target) === 'cloud') {
        violations.push(`${relative(jsRoot, file)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('panels never import each other', () => {
  // Mutual exclusion between sidebars belongs to the panel registry. Panels
  // importing each other's close functions is how a three-way tangle of
  // lateral edges grew last time.
  const violations = [];
  for (const file of files.filter((f) => relative(jsRoot, f).replaceAll('\\', '/').startsWith('ui/panels/'))) {
    const rel = relative(jsRoot, file).replaceAll('\\', '/');
    const ownPanel = rel.split('/')[2];
    for (const target of importsOf(file)) {
      const parts = target.split('/');
      if (parts[0] === 'ui' && parts[1] === 'panels' && parts[2] && parts[2] !== ownPanel && !parts[2].endsWith('.js')) {
        violations.push(`${rel} -> ${target}`);
      }
    }
  }
  assert.deepEqual(violations, [], `lateral panel imports:\n${violations.join('\n')}`);
});

test('every model/ and cloud/ module really does import in a bare Node process', async () => {
  // The claim "testable without a browser" is worthless as a comment and cheap
  // to verify. If one of these ever pulls in a DOM-touching module, this fails
  // here rather than silently leaving that module untested.
  //
  // cloud/ is included on purpose: it talks to Azure over fetch and is given
  // its container rather than constructing one, so nothing in it needs a
  // browser. Keeping that true is what lets the sync tests run against a plain
  // in-memory object instead of patching the module registry.
  const environmentFree = files
    .map((f) => relative(jsRoot, f).replaceAll('\\', '/'))
    .filter((rel) => rel.startsWith('model/') || rel.startsWith('cloud/'));

  assert.ok(environmentFree.length >= 6, `expected more environment-free modules, found ${environmentFree.length}`);
  for (const rel of environmentFree) {
    await assert.doesNotReject(
      () => import(new URL(`../js/${rel}`, import.meta.url).href),
      `${rel} cannot be imported without a browser environment`,
    );
  }
});

test('nothing outside ui/ mentions a DOM global', async () => {
  // The rule the check above enforces at import time, enforced here for code
  // that would only fail when called: a DOM reference anywhere but ui/ means a
  // module that cannot be tested or reused without a browser. platform/ is
  // exempt -- wrapping browser capabilities is precisely its job.
  const dom = /\b(document|window|DOMParser|localStorage|sessionStorage|navigator)\b/;
  const offenders = [];
  for (const file of files) {
    const rel = relative(jsRoot, file).replaceAll('\\', '/');
    if (rel.startsWith('ui/') || rel.startsWith('platform/') || rel === 'main.js') continue;
    const source = readFileSync(file, 'utf8')
      // Comments describe constraints and may name these freely.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '');
    if (dom.test(source)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('no module reaches outside js/ for source', () => {
  const violations = [];
  for (const file of files) {
    for (const target of importsOf(file)) {
      if (target.startsWith('..')) violations.push(`${relative(jsRoot, file)} -> ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});
