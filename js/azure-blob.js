// Azure Blob Storage backup/restore, via a container-level SAS URL.
// Same principle as the Speech key elsewhere in this app: zero backend,
// requests go straight from this browser to Azure using a credential the
// user pastes in and that is stored only in localStorage. Requires the
// storage account's CORS settings to allow this origin (GET, PUT, OPTIONS).

const API_VERSION = '2021-08-06';

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
    response = await fetch(blobUrl(sasUrl, path), {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': API_VERSION,
        'Content-Type': contentType,
      },
      body: data,
    });
  } catch (err) {
    throw new Error(`Upload of "${path}" failed: network request failed. Check the SAS URL and that CORS is enabled on the storage account.`);
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
    response = await fetch(blobUrl(sasUrl, path), {
      method: 'GET',
      headers: { 'x-ms-version': API_VERSION },
    });
  } catch (err) {
    throw new Error(`Download of "${path}" failed: network request failed. Check the SAS URL and that CORS is enabled on the storage account.`);
  }
  await checkResponse(response, `Download of "${path}"`);
  return response.blob();
}

/** Download and JSON-parse a blob. Throws with `.notFound = true` if it doesn't exist. */
export async function downloadJson(sasUrl, path) {
  const blob = await downloadBytes(sasUrl, path);
  return JSON.parse(await blob.text());
}
