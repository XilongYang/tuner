// Installs a real (pure-JS) IndexedDB implementation as the global `indexedDB`,
// so js/store/* -- which only ever calls the standard IndexedDB API, no DOM --
// can be exercised in plain Node. Import this FIRST, before importing any
// js/store/* module, in any test file that touches the store.
//
// fake-indexeddb is a genuine IndexedDB implementation (not a mock/stub) --
// transactions, indexes, key ranges, and auto-increment keys all behave the
// same as a real browser's, so these tests exercise the actual store code
// paths, not a hand-rolled approximation of them.
import 'fake-indexeddb/auto';
