// The REST layer, driven by a stubbed global fetch: URL shape, headers,
// conditional requests, error classification, pagination.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { container, parseBlobNames } from '../../js/cloud/blob.js';

const SAS = 'https://acct.blob.core.windows.net/tuner?sv=2021&sig=abc';

let calls;
const realFetch = globalThis.fetch;

/** Queue of responses; each fetch takes the next one. */
function stubFetch(responses) {
  calls = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses[Math.min(i++, responses.length - 1)];
    return typeof next === 'function' ? next(url, opts) : next;
  };
}

const response = ({ status = 200, body = '', etag, headers = {} } = {}) => {
  const headerMap = { ...(etag ? { ETag: etag } : {}), ...headers };
  // The WHATWG Response constructor rejects the null-body statuses (204/205/
  // 304) outright, even though a real fetch returns them happily -- so those
  // are duck-typed instead. Only the fields the module actually reads.
  if ([204, 205, 304].includes(status)) {
    return {
      status,
      ok: false,
      headers: { get: (name) => headerMap[name] ?? null },
      text: async () => '',
    };
  }
  return new Response(body, { status, headers: headerMap });
};

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test('uploadBytes: PUTs to the container path with the SAS query preserved', async () => {
  stubFetch([response({ etag: '"v1"' })]);
  const etag = await container(SAS).uploadBytes('recordings/s1/x.wav', new Uint8Array([1]), 'audio/wav');

  assert.equal(calls[0].url, 'https://acct.blob.core.windows.net/tuner/recordings/s1/x.wav?sv=2021&sig=abc');
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(calls[0].opts.headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(calls[0].opts.headers['Content-Type'], 'audio/wav');
  assert.equal(etag, '"v1"');
});

test('uploadBytes: a container URL with no query still builds a valid path', async () => {
  stubFetch([response()]);
  await container('https://acct.blob.core.windows.net/tuner/').uploadBytes('a/b.txt', new Uint8Array());
  assert.equal(calls[0].url, 'https://acct.blob.core.windows.net/tuner/a/b.txt');
});

test('uploadBytes: returns null when the response exposes no ETag, rather than inventing one', async () => {
  stubFetch([response()]);
  assert.equal(await container(SAS).uploadBytes('a.txt', new Uint8Array()), null);
});

test('uploadBytes: ifNoneMatch and ifMatch become the matching precondition headers', async () => {
  stubFetch([response(), response()]);
  const c = container(SAS);
  await c.uploadBytes('lock', new Uint8Array(), 'application/json', { ifNoneMatch: '*' });
  await c.uploadBytes('lock', new Uint8Array(), 'application/json', { ifMatch: '"v1"' });

  assert.equal(calls[0].opts.headers['If-None-Match'], '*');
  assert.equal(calls[1].opts.headers['If-Match'], '"v1"');
});

test('a 404 is tagged notFound, because "no manifest yet" is a normal answer', async () => {
  stubFetch([response({ status: 404 })]);
  await assert.rejects(() => container(SAS).downloadBytes('manifest.json'), (err) => {
    assert.equal(err.notFound, true);
    assert.match(err.message, /not found/);
    return true;
  });
});

test('409 and 412 are both tagged conflict, because both mean "someone got there first"', async () => {
  for (const status of [409, 412]) {
    stubFetch([response({ status })]);
    await assert.rejects(() => container(SAS).uploadBytes('lock', new Uint8Array(), 'application/json', { ifNoneMatch: '*' }), (err) => {
      assert.equal(err.conflict, true, `status ${status}`);
      return true;
    });
  }
});

test('a 403 explains the likely cause instead of just reporting the status', async () => {
  stubFetch([response({ status: 403 })]);
  await assert.rejects(() => container(SAS).downloadBytes('a.txt'), /permissions and expiry.*CORS/s);
});

test('another failure carries the status and a trimmed slice of the body', async () => {
  stubFetch([response({ status: 500, body: 'InternalError: something broke' })]);
  await assert.rejects(() => container(SAS).downloadBytes('a.txt'), /HTTP 500 — InternalError: something broke/);
});

test('a network failure is reported as one, pointing at the SAS URL and CORS', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => container(SAS).downloadBytes('a.txt'), /network request failed.*CORS/s);
});

test('an aborted request is reported as a timeout, not a generic failure', async () => {
  globalThis.fetch = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(() => container(SAS).downloadBytes('a.txt'), (err) => {
    assert.match(err.message, /timed out after \d+s/);
    return true;
  });
});

// A stub that rejects the way a dead connection does, counting attempts.
function failingFetch(times, { name = 'TypeError', after = response() } = {}) {
  const state = { calls: 0 };
  globalThis.fetch = async () => {
    state.calls += 1;
    if (state.calls > times) return after;
    const err = new Error(name === 'AbortError' ? 'aborted' : 'Failed to fetch');
    err.name = name;
    throw err;
  };
  return state;
}

test("an upload's deadline allows for the body's size: a stall detector, not a bandwidth floor", async () => {
  failingFetch(2, { name: 'AbortError' });
  const big = new Uint8Array(10 * 1024 * 1024);

  await assert.rejects(() => container(SAS).uploadBytes('sourceaudio/s1.audio', big), (err) => {
    // 60s base plus 10 MB at 25 KB/s, rather than the flat 60s that timed out
    // every time a source-audio file met a slow uplink.
    assert.match(err.message, /timed out after 479s/);
    return true;
  });
});

test('a large upload that fails says how large it was: a slow link and a broken one read differently', async () => {
  failingFetch(2);
  await assert.rejects(
    () => container(SAS).uploadBytes('sourceaudio/s1.audio', new Uint8Array(3 * 1024 * 1024)),
    /Upload of "sourceaudio\/s1\.audio" \(3\.0 MB\) failed/,
  );
});

test('a dropped connection is retried once, so one lost packet does not lose the round', async () => {
  const state = failingFetch(1, { after: response({ etag: '"v2"' }) });

  const etag = await container(SAS).uploadBytes('references/s1/a.audio', new Uint8Array([1]));

  assert.equal(etag, '"v2"');
  assert.equal(state.calls, 2);
});

test('a conditional write is not retried: its second attempt would fail its own precondition', async () => {
  const state = failingFetch(1, { after: response({ etag: '"v2"' }) });

  await assert.rejects(() => container(SAS).uploadJson('sync.lock', { deviceId: 'a' }, { ifNoneMatch: '*' }), /network request failed/);
  assert.equal(state.calls, 1, 'a retry of a write that may already have landed reads as another device holding the lock');
});

test('a conditional delete is not retried either, for the same reason', async () => {
  const state = failingFetch(1, { after: response({ status: 202 }) });

  await assert.rejects(() => container(SAS).deleteBlob('sync.lock', { ifMatch: '"v1"' }), /network request failed/);
  assert.equal(state.calls, 1);
});

test('reads and unconditional deletes are retried: repeating them asks the same question', async () => {
  const list = failingFetch(1, { after: response({ body: '<Blobs><Blob><Name>a.txt</Name></Blob></Blobs>' }) });
  assert.deepEqual(await container(SAS).listBlobs(''), ['a.txt']);
  assert.equal(list.calls, 2);

  const del = failingFetch(1, { after: response({ status: 202 }) });
  await container(SAS).deleteBlob('manifest.json');
  assert.equal(del.calls, 2);

  const get = failingFetch(1, { after: response({ body: '{"version":6}' }) });
  assert.deepEqual(await container(SAS).downloadJson('manifest.json'), { version: 6 });
  assert.equal(get.calls, 2);
});

test('a bad status is the server answering, and is not retried', async () => {
  stubFetch([response({ status: 403 }), response({ etag: '"v1"' })]);
  await assert.rejects(() => container(SAS).uploadBytes('a.txt', new Uint8Array([1])), /HTTP 403/);
  assert.equal(calls.length, 1);
});

test('downloadJson: parses the body', async () => {
  stubFetch([response({ body: JSON.stringify({ version: 6 }) })]);
  assert.deepEqual(await container(SAS).downloadJson('manifest.json'), { version: 6 });
});

test('downloadJsonConditional: sends If-None-Match and reports 304 as notModified', async () => {
  stubFetch([response({ status: 304 })]);
  const result = await container(SAS).downloadJsonConditional('manifest.json', '"v1"');

  assert.equal(calls[0].opts.headers['If-None-Match'], '"v1"');
  assert.deepEqual(result, { notModified: true });
});

test('downloadJsonConditional: with no known ETag it is a plain GET', async () => {
  stubFetch([response({ body: '{"a":1}', etag: '"v2"' })]);
  const result = await container(SAS).downloadJsonConditional('manifest.json', null);

  assert.equal('If-None-Match' in calls[0].opts.headers, false);
  assert.deepEqual(result, { notModified: false, value: { a: 1 }, etag: '"v2"' });
});

test('downloadJsonConditional: a 404 still surfaces as notFound, not as notModified', async () => {
  stubFetch([response({ status: 404 })]);
  await assert.rejects(() => container(SAS).downloadJsonConditional('manifest.json', '"v1"'), (err) => err.notFound === true);
});

test('deleteBlob: treats an already-deleted blob as success', async () => {
  stubFetch([response({ status: 404 })]);
  await container(SAS).deleteBlob('gone.wav');
  assert.equal(calls[0].opts.method, 'DELETE');
});

test('deleteBlob: ifMatch makes it conditional, and losing that race is a conflict', async () => {
  stubFetch([response({ status: 412 })]);
  await assert.rejects(() => container(SAS).deleteBlob('lock', { ifMatch: '"mine"' }), (err) => err.conflict === true);
  assert.equal(calls[0].opts.headers['If-Match'], '"mine"');
});

const listXml = (names, nextMarker = '') => `<?xml version="1.0"?>
<EnumerationResults>
  <Blobs>
    ${names.map((n) => `<Blob><Name>${n}</Name><Properties><Content-Length>1</Content-Length></Properties></Blob>`).join('\n    ')}
  </Blobs>
  <NextMarker>${nextMarker}</NextMarker>
</EnumerationResults>`;

test('listBlobs: sends the container list query with the prefix', async () => {
  stubFetch([response({ body: listXml(['recordings/a.wav']) })]);
  const names = await container(SAS).listBlobs('recordings/');

  assert.match(calls[0].url, /restype=container/);
  assert.match(calls[0].url, /comp=list/);
  assert.match(calls[0].url, /prefix=recordings%2F/);
  assert.match(calls[0].url, /&sv=2021&sig=abc$/);
  assert.deepEqual(names, ['recordings/a.wav']);
});

test('listBlobs: follows pagination to the end', async () => {
  stubFetch([
    response({ body: listXml(['a.wav', 'b.wav'], 'MARK') }),
    response({ body: listXml(['c.wav']) }),
  ]);
  assert.deepEqual(await container(SAS).listBlobs(''), ['a.wav', 'b.wav', 'c.wav']);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /marker=MARK/);
});

test('parseBlobNames: unescapes XML entities in names', () => {
  assert.deepEqual(parseBlobNames(listXml(['a&amp;b.wav', 'x&lt;y&gt;.wav'])), ['a&b.wav', 'x<y>.wav']);
});

test('parseBlobNames: an empty listing gives an empty list', () => {
  assert.deepEqual(parseBlobNames(listXml([])), []);
  assert.deepEqual(parseBlobNames('<EnumerationResults></EnumerationResults>'), []);
});

test('parseBlobNames: ignores Name elements outside the Blobs section', () => {
  const xml = `<EnumerationResults><Prefix><Name>not-a-blob</Name></Prefix><Blobs><Blob><Name>real.wav</Name></Blob></Blobs></EnumerationResults>`;
  assert.deepEqual(parseBlobNames(xml), ['real.wav']);
});
