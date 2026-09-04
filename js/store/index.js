// Public API barrel for js/store -- re-exports exactly what the original
// single-file js/store.js exported, so every other module can keep doing
// `import * as store from './store/index.js'` and calling `store.xxx(...)`
// unchanged. The internal wiring between db/tombstones/hashing/sessions/
// folders/snapshot is private to this folder.

export { isSupported } from './db.js';
export {
  listTombstones,
  upsertTombstones,
  removeSessionRecord,
  removeFolderRecord,
} from './tombstones.js';
export {
  createSession,
  updateSession,
  renameSession,
  moveSessionToFolder,
  getSession,
  listSessions,
  deleteSession,
  migrateSessionIdsToUuid,
  backfillInputTextHashes,
  upsertSessions,
} from './sessions.js';
export {
  createFolder,
  renameFolder,
  moveFolder,
  listFolders,
  deleteFolder,
  clearAll,
  upsertFolders,
} from './folders.js';
export { exportAll, restoreSnapshot } from './snapshot.js';
export { buildBackupZip, parseBackupZip, freshenImportTimestamps } from './backup.js';
