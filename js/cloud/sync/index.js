// The sync subsystem's surface. Everything outside cloud/sync/ imports this
// file and nothing else under it.
//
// Same rule as db/index.js, and here it carries more weight: sync is the one
// concern this design most wants to be able to delete in one piece. That is
// only checkable if the rest of the app depends on a named surface rather than
// on whichever internal a call site happened to find -- `isLockStale`,
// `orphanPaths`, `tombstoneId` and the manifest helpers are exported for their
// own tests and are nobody else's business.
//
// The test of this file: with it and the modules beside it removed, nothing
// else in js/ should fail to resolve except the one command that runs a round.

export { planSync, emptyManifest, slotsFor } from './plan.js';
export { transferContent, publishManifest, readManifest, sweepOrphans, MANIFEST_PATH } from './run.js';
export { acquire, release, forceRelease } from './lock.js';
export { eraseContainer } from './erase.js';
