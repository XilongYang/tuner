// Azure Blob Storage over a container-level SAS URL.
//
// No backend: requests go straight from the browser to Azure with a credential
// the user pastes in. The storage account's CORS rules must allow this origin
// for GET, PUT, DELETE and OPTIONS, and the SAS token needs Read, Write, List
// and Delete permissions (List and Delete are used by the orphan sweep).
//
// `container(sasUrl)` returns the operations already bound to that URL. Callers
// therefore never pass a SAS URL around, and anything built on top of this --
// the lock, the plan runner, a sync command -- can be tested against a plain
// in-memory object implementing the same six methods. That is the entire reason
// the new test suite needs no module mocking and no experimental Node flag.

const API_VERSION = '2021-08-06';

// A recording on a slow connection can legitimately take a while; list and
// delete calls are small and should fail fast. fetch() has no default timeout
// at all, so without these a stalled connection hangs with no error ever.
const TRANSFER_TIMEOUT_MS = 60_000;
const METADATA_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const timedOut = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      timedOut.timedOut = true;
      throw timedOut;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function networkError(action, err) {
  if (err?.timedOut) return new Error(`${action} failed: ${err.message}. Check your network connection and the SAS URL.`);
  return new Error(`${action} failed: network request failed. Check the SAS URL and that CORS is enabled on the storage account.`);
}

/**
 * Failures callers branch on are tagged, because the distinction is not
 * cosmetic: `notFound` is the normal answer to "is there a manifest yet", and
 * `conflict` is the normal answer to "did I win the race for the lock".
 * Everything else is a real fault and carries a message aimed at the most
 * common cause -- a 403 here is nearly always the SAS token's permissions,
 * expiry, or missing CORS, none of which the status code alone suggests.
 */
async function check(response, action) {
  if (response.ok) return response;
  if (response.status === 404) {
    const err = new Error(`${action}: not found`);
    err.notFound = true;
    throw err;
  }
  // 412 is the standard precondition failure; Azure's Put Blob answers 409 for
  // the "If-None-Match: * but it already exists" case. Both mean "someone else
  // got there first" to every caller here.
  if (response.status === 412 || response.status === 409) {
    const err = new Error(`${action}: conflict (changed since last read)`);
    err.conflict = true;
    throw err;
  }
  if (response.status === 403) {
    throw new Error(`${action} failed: HTTP 403. Check the SAS URL's permissions and expiry, and that the storage account's CORS settings allow this origin.`);
  }
  let detail = '';
  try { detail = (await response.text()).trim(); } catch { /* body is optional context */ }
  throw new Error(`${action} failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
}

function splitSasUrl(sasUrl) {
  const q = sasUrl.indexOf('?');
  const base = q === -1 ? sasUrl : sasUrl.slice(0, q);
  return {
    root: base.endsWith('/') ? base.slice(0, -1) : base,
    query: q === -1 ? '' : sasUrl.slice(q + 1),
  };
}

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

/**
 * Blob names out of a List Blobs response.
 *
 * Extracted with a scan rather than DOMParser so nothing outside ui/ depends on
 * a browser: this module is then usable and testable anywhere. The response
 * shape being relied on is narrow and stable -- `<Blobs>` containing `<Blob>`
 * elements whose first `<Name>` is the blob's name. `<BlobPrefix>` entries only
 * appear when a request passes a delimiter, which this module never does.
 */
export function parseBlobNames(xml) {
  const blobsSection = /<Blobs>([\s\S]*?)<\/Blobs>/.exec(xml);
  if (!blobsSection) return [];
  const names = [];
  for (const blob of blobsSection[1].matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(blob[1]);
    if (name) names.push(name[1].replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]));
  }
  return names;
}

/** The continuation marker of a paginated listing, or '' when it is the last page. */
function parseNextMarker(xml) {
  const marker = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml);
  return marker ? marker[1] : '';
}

/**
 * @typedef {object} Container
 * @property {(path: string, data: BlobPart, contentType?: string, opts?: {ifMatch?: string, ifNoneMatch?: string}) => Promise<string|null>} uploadBytes
 * @property {(path: string, value: unknown, opts?: object) => Promise<string|null>} uploadJson
 * @property {(path: string) => Promise<Blob>} downloadBytes
 * @property {(path: string) => Promise<unknown>} downloadJson
 * @property {(path: string, knownEtag: string|null) => Promise<{notModified: true} | {notModified: false, value: unknown, etag: string|null}>} downloadJsonConditional
 * @property {(prefix?: string) => Promise<string[]>} listBlobs
 * @property {(path: string, opts?: {ifMatch?: string}) => Promise<void>} deleteBlob
 */

/**
 * Bind every operation to one container SAS URL.
 * @param {string} sasUrl
 * @returns {Container}
 */
export function container(sasUrl) {
  const { root, query } = splitSasUrl(sasUrl);
  const suffix = query ? `?${query}` : '';
  const blobUrl = (path) => `${root}/${path.split('/').map(encodeURIComponent).join('/')}${suffix}`;

  const listUrl = (prefix, marker) => {
    const params = new URLSearchParams({ restype: 'container', comp: 'list' });
    if (prefix) params.set('prefix', prefix);
    if (marker) params.set('marker', marker);
    return `${root}?${params}${query ? `&${query}` : ''}`;
  };

  /**
   * Returns the new ETag, or null when the response carries none (some proxies
   * strip it, and a CORS rule that does not expose ETag reads back as absent).
   * A caller that wanted it for a conditional follow-up must then treat the
   * blob as unknown rather than assume it is unchanged.
   */
  async function uploadBytes(path, data, contentType = 'application/octet-stream', opts = {}) {
    const headers = {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': API_VERSION,
      'Content-Type': contentType,
    };
    if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;

    let response;
    try {
      response = await fetchWithTimeout(blobUrl(path), { method: 'PUT', headers, body: data }, TRANSFER_TIMEOUT_MS);
    } catch (err) {
      throw networkError(`Upload of "${path}"`, err);
    }
    await check(response, `Upload of "${path}"`);
    return response.headers.get('ETag') || null;
  }

  async function downloadBytes(path) {
    let response;
    try {
      response = await fetchWithTimeout(blobUrl(path), { method: 'GET', headers: { 'x-ms-version': API_VERSION } }, TRANSFER_TIMEOUT_MS);
    } catch (err) {
      throw networkError(`Download of "${path}"`, err);
    }
    await check(response, `Download of "${path}"`);
    return response.blob();
  }

  /**
   * Conditional GET: pass the ETag from a previous read and Azure answers 304
   * instead of resending an unchanged body. Used by sync, which reads the same
   * manifest on every round.
   *
   * With `knownEtag` null this is an ordinary GET. A missing ETag on the
   * response degrades to "always changed", which is correct but unoptimized.
   */
  async function downloadJsonConditional(path, knownEtag) {
    const headers = { 'x-ms-version': API_VERSION };
    if (knownEtag) headers['If-None-Match'] = knownEtag;

    let response;
    try {
      response = await fetchWithTimeout(blobUrl(path), { method: 'GET', headers }, TRANSFER_TIMEOUT_MS);
    } catch (err) {
      throw networkError(`Download of "${path}"`, err);
    }
    if (response.status === 304) return { notModified: true };
    await check(response, `Download of "${path}"`);
    return { notModified: false, value: JSON.parse(await response.text()), etag: response.headers.get('ETag') || null };
  }

  /** Every blob name under `prefix`, following pagination to the end. */
  async function listBlobs(prefix = '') {
    const names = [];
    let marker = '';
    do {
      let response;
      try {
        response = await fetchWithTimeout(listUrl(prefix, marker), { method: 'GET', headers: { 'x-ms-version': API_VERSION } }, METADATA_TIMEOUT_MS);
      } catch (err) {
        throw networkError(`Listing blobs under "${prefix}"`, err);
      }
      await check(response, `Listing blobs under "${prefix}"`);
      const xml = await response.text();
      names.push(...parseBlobNames(xml));
      marker = parseNextMarker(xml);
    } while (marker);
    return names;
  }

  /**
   * Delete one blob, treating "already gone" as success.
   *
   * `opts.ifMatch` makes it conditional, which is what stops a device whose
   * lock was stolen after overrunning the staleness window from deleting the
   * new owner's lock.
   */
  async function deleteBlob(path, opts = {}) {
    const headers = { 'x-ms-version': API_VERSION };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;

    let response;
    try {
      response = await fetchWithTimeout(blobUrl(path), { method: 'DELETE', headers }, METADATA_TIMEOUT_MS);
    } catch (err) {
      throw networkError(`Delete of "${path}"`, err);
    }
    if (response.status === 404) return;
    await check(response, `Delete of "${path}"`);
  }

  return {
    uploadBytes,
    uploadJson: (path, value, opts) => uploadBytes(path, new TextEncoder().encode(JSON.stringify(value)), 'application/json', opts),
    downloadBytes,
    downloadJson: async (path) => JSON.parse(await (await downloadBytes(path)).text()),
    downloadJsonConditional,
    listBlobs,
    deleteBlob,
  };
}
