// Azure Blob Storage backup/restore, via a container-level SAS URL.
// Same principle as the Speech key elsewhere in this app: zero backend,
// requests go straight from this browser to Azure using a credential the
// user pastes in and that is stored only in localStorage. Requires the
// storage account's CORS settings to allow this origin (GET, PUT, DELETE, OPTIONS).
// Listing and deleting (used to clean up orphaned recordings) need the SAS token's
// List ("l") and Delete ("d") permissions in addition to Read/Write.

const API_VERSION = '2021-08-06';

// Large recordings can legitimately take a while to upload/download on a slow
// connection, so those get a longer budget than the small metadata calls
// (list/delete). Without any timeout, a stalled connection would otherwise
// hang the UI forever with no error at all -- fetch() has no default one.
const TRANSFER_TIMEOUT_MS = 60000;
const METADATA_TIMEOUT_MS = 20000;

/** fetch() with a hard timeout: aborts and rejects with a clear, `.timedOut = true` error. */
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      timeoutErr.timedOut = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Build a friendly message for a failed fetch, distinguishing a timeout from any other network failure. */
function networkErrorMessage(action, err) {
  if (err?.timedOut) {
    return `${action} failed: ${err.message}. Check your network connection and the SAS URL.`;
  }
  return `${action} failed: network request failed. Check the SAS URL and that CORS is enabled on the storage account.`;
}

/** Split a container SAS URL into its container root and its SAS query string. */
function splitSasUrl(sasUrl) {
  const qIndex = sasUrl.indexOf('?');
  const base = qIndex === -1 ? sasUrl : sasUrl.slice(0, qIndex);
  const query = qIndex === -1 ? '' : sasUrl.slice(qIndex + 1);
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  return { root, query };
}

/** Build the URL for one blob inside the SAS-scoped container. `path` may contain '/'. */
function blobUrl(sasUrl, path) {
  const { root, query } = splitSasUrl(sasUrl);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${root}/${encodedPath}${query ? '?' + query : ''}`;
}

/** Build the URL for a "List Blobs" call against the container root, optionally paginated. */
function listUrl(sasUrl, prefix, marker) {
  const { root, query } = splitSasUrl(sasUrl);
  const params = new URLSearchParams();
  params.set('restype', 'container');
  params.set('comp', 'list');
  if (prefix) params.set('prefix', prefix);
  if (marker) params.set('marker', marker);
  return `${root}?${params.toString()}${query ? '&' + query : ''}`;
}

async function checkResponse(response, action) {
  if (response.ok) return response;
  if (response.status === 404) {
    const err = new Error(`${action}: not found`);
    err.notFound = true;
    throw err;
  }
  let detail = '';
  try { detail = (await response.text()).trim(); } catch { /* ignore */ }
  if (response.status === 403) {
    throw new Error(`${action} failed: HTTP 403. Check the SAS URL's permissions/expiry, and that the storage account's CORS settings allow this origin.`);
  }
  throw new Error(`${action} failed: HTTP ${response.status}${detail ? ' — ' + detail.slice(0, 300) : ''}`);
}

/** Upload raw bytes (Uint8Array / ArrayBuffer / Blob) as a block blob, creating or overwriting it. */
export async function uploadBytes(sasUrl, path, data, contentType = 'application/octet-stream') {
  let response;
  try {
    response = await fetchWithTimeout(blobUrl(sasUrl, path), {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': API_VERSION,
        'Content-Type': contentType,
      },
      body: data,
    }, TRANSFER_TIMEOUT_MS);
  } catch (err) {
    throw new Error(networkErrorMessage(`Upload of "${path}"`, err));
  }
  await checkResponse(response, `Upload of "${path}"`);
}

/** Upload a JSON-serializable value as a block blob. */
export function uploadJson(sasUrl, path, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return uploadBytes(sasUrl, path, bytes, 'application/json');
}

/** Download a blob's raw bytes as a Blob. Throws with `.notFound = true` if it doesn't exist. */
export async function downloadBytes(sasUrl, path) {
  let response;
  try {
    response = await fetchWithTimeout(blobUrl(sasUrl, path), {
      method: 'GET',
      headers: { 'x-ms-version': API_VERSION },
    }, TRANSFER_TIMEOUT_MS);
  } catch (err) {
    throw new Error(networkErrorMessage(`Download of "${path}"`, err));
  }
  await checkResponse(response, `Download of "${path}"`);
  return response.blob();
}

/** Download and JSON-parse a blob. Throws with `.notFound = true` if it doesn't exist. */
export async function downloadJson(sasUrl, path) {
  const blob = await downloadBytes(sasUrl, path);
  return JSON.parse(await blob.text());
}

/**
 * List every blob name under `prefix` in the container (handles pagination
 * transparently). Requires the SAS token's List ("l") permission.
 */
export async function listBlobs(sasUrl, prefix) {
  const names = [];
  let marker = '';
  do {
    let response;
    try {
      response = await fetchWithTimeout(listUrl(sasUrl, prefix, marker), {
        method: 'GET',
        headers: { 'x-ms-version': API_VERSION },
      }, METADATA_TIMEOUT_MS);
    } catch (err) {
      throw new Error(networkErrorMessage(`Listing blobs under "${prefix}"`, err));
    }
    await checkResponse(response, `Listing blobs under "${prefix}"`);
    const xmlText = await response.text();
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error(`Listing blobs under "${prefix}" failed: could not parse the response from Azure.`);
    }
    for (const nameEl of doc.querySelectorAll('Blobs > Blob > Name')) {
      names.push(nameEl.textContent);
    }
    marker = doc.querySelector('NextMarker')?.textContent || '';
  } while (marker);
  return names;
}

/** Delete one blob. Treats "already gone" (404) as success. Requires the SAS token's Delete ("d") permission. */
export async function deleteBlob(sasUrl, path) {
  let response;
  try {
    response = await fetchWithTimeout(blobUrl(sasUrl, path), {
      method: 'DELETE',
      headers: { 'x-ms-version': API_VERSION },
    }, METADATA_TIMEOUT_MS);
  } catch (err) {
    throw new Error(networkErrorMessage(`Delete of "${path}"`, err));
  }
  if (response.status === 404) return;
  await checkResponse(response, `Delete of "${path}"`);
}
