// Seeding the database the way the app does.
//
// A test that writes a record with content has to put the bytes where the app
// puts them -- the content store -- or it is testing a state the app cannot
// produce. `saveRecord` is that path, so tests use it rather than a fixture
// that reaches into the stores directly.

import { saveRecord } from '../../js/app/persist.js';
import * as db from '../../js/db/entities.js';
import { hashBlob, hashString, hashJson, materializeBlob } from '../../js/platform/hash.js';

export const hash = { hashBlob, hashString, hashJson, materializeBlob };

/** @returns {Promise<object>} the record as stored, hashes stamped. */
export const seed = (name, record) => saveRecord(name, record, { db, hash });
