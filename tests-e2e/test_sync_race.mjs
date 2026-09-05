import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[console:${msg.type()}] ${msg.text()}`); });

await page.goto('http://127.0.0.1:8934/index.html');
await page.waitForLoadState('networkidle');

const result = await page.evaluate(async () => {
  const syncMod = await import('/js/sync/azure-sync.js');
  const { findSessionsChangedSinceSnapshot } = syncMod;

  // --- Scenario A: exactly the user's report. A slow sync snapshots local
  // state at T0 (session.updatedAt = 100). While that sync is still in
  // flight (network round-trip), a local Split lands and bumps updatedAt to
  // 200. The slow sync finally finishes and is about to write its merge
  // (computed from the T0 snapshot) back -- the guard must catch this and
  // mark the session stale, so that write (and the screen refresh with it)
  // gets skipped instead of reverting the split.
  const localUpdatedAtAtStart = new Map([['session-1', 100]]);
  const currentLocalRecords = new Map([['session-1', { id: 'session-1', updatedAt: 200 }]]); // moved on since T0
  const getSessionFn = async (id) => currentLocalRecords.get(id) || null;
  const finalSessions = [{ id: 'session-1', sentences: [] }]; // this sync's (now-stale) merge result

  const staleA = await findSessionsChangedSinceSnapshot(finalSessions, localUpdatedAtAtStart, getSessionFn);

  // --- Scenario B: nothing changed locally while the sync was in flight --
  // must NOT be flagged stale (the common, non-racing case).
  const localUpdatedAtAtStartB = new Map([['session-1', 100]]);
  const currentLocalRecordsB = new Map([['session-1', { id: 'session-1', updatedAt: 100 }]]);
  const getSessionFnB = async (id) => currentLocalRecordsB.get(id) || null;
  const staleB = await findSessionsChangedSinceSnapshot([{ id: 'session-1' }], localUpdatedAtAtStartB, getSessionFnB);

  // --- Scenario C: a session brand new to local this sync round (pulled
  // fresh from remote, never in the starting snapshot) -- must NOT be
  // flagged stale, since there's nothing local it could have raced against.
  const staleC = await findSessionsChangedSinceSnapshot(
    [{ id: 'new-session' }], new Map(), async () => { throw new Error('should not be called'); },
  );

  return {
    staleA: Array.from(staleA),
    staleB: Array.from(staleB),
    staleC: Array.from(staleC),
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
console.log('LOGS:', logs);
