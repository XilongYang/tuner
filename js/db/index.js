// The storage subsystem's surface. Everything above db/ imports this file and
// nothing else under db/.
//
// The modules inside export more than this -- `openDb`, `dbError`,
// `resetDbForTests` and the store names are all exported so the tests can reach
// them directly. That is deliberate and it is also why this file exists: a
// module's export list says what its *tests* may touch, and without a separate
// boundary that list doubles as the public API by accident. Then a helper
// exported for one assertion becomes something the rest of the app is free to
// call, and the seam stops being a seam.
//
// So: two lists. A module exports what it wants tested. This file exports what
// the app may use. tests/arch.test.mjs holds the second one to it.

export {
  getOne,
  listAll,
  listTombstones,
  snapshot,
  put,
  putMany,
  putRecord,
  remove,
  removeRecord,
  tombstoneSentences,
  clearAll,
  sweepContent,
  applyPlan,
  readContent,
  storedContentHashes,
  listContentPaths,
} from './entities.js';

export { isSupported } from './open.js';
