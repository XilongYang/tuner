// Small helpers for the per-row Export button: naming and triggering the ZIP download.

/** Make a filename-safe slug from the sentence text. */
export function slugify(text) {
  const s = text.trim().slice(0, 24).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return s || 'sentence';
}

/** Trigger a download of a Blob under the given filename. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
