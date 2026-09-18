// DOM construction and list updating.
//
// `reconcile()` is the reason this module exists. The previous implementation
// repainted by emptying a container and rebuilding every row, which threw away
// anything living in those rows: an in-progress multi-sentence selection, the
// sidebar's scroll position, open word popovers and their object URLs, and the
// state of a recording in flight. A background sync could therefore undo work
// the user was in the middle of, and other modules grew workarounds to avoid
// repainting at all. Updating by key removes the whole class of problem: a row
// that is still present is updated in place, never replaced.

/**
 * @param {string} tag
 * @param {object} [props] `class`, `text`, `title`, `hidden`, `disabled`,
 *   `dataset`, `on` (event map), and any other property assigned directly.
 * @param {Array<Node|string|null|undefined|false>} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    // A hyphenated name (aria-label, data-x) is an attribute, not a property.
    // Assigning it as a property silently creates an expando that no CSS
    // selector, no screen reader and no getAttribute ever sees.
    else if (key.includes('-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

/**
 * A button. `type` defaults to 'button' because a bare <button> inside a form
 * submits it, which is never what any button in this app wants.
 */
export function button({ text, class: className = 'btn', title, hidden, disabled, onClick, ...rest }) {
  return el('button', {
    type: 'button', class: className, text, title, hidden, disabled,
    ...rest,
    on: onClick ? { click: onClick } : undefined,
  });
}

/**
 * Read a numeric `data-` attribute as `number | null`.
 *
 * The one boundary rule this module enforces: an absent or empty attribute is
 * null, never 0. `Number('')` is 0, and a missing timestamp arriving downstream
 * as a real one silently produced empty audio clips -- the arithmetic had no
 * way to tell "the start of the file" from "no value here".
 * @returns {number|null}
 */
export function readNumber(element, key) {
  const raw = element?.dataset?.[key];
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Write a `number | null` back without inventing a value for null. */
export function writeNumber(element, key, value) {
  element.dataset[key] = value == null ? '' : String(value);
}

const KEY_ATTR = 'reconcileKey';

/**
 * Bring `container`'s children into line with `items`, matching by key.
 *
 * Existing rows are updated in place and moved if the order changed; rows whose
 * key is gone are removed; new keys are created. Nothing else is touched, so
 * focus, scroll, selection, popovers and event listeners on surviving rows
 * survive.
 *
 * `update` is optional: a row type that renders everything from immutable data
 * needs no update pass. It receives the existing element so it can patch just
 * what changed.
 *
 * @template T
 * @param {Element} container
 * @param {T[]} items
 * @param {object} spec
 * @param {(item: T, index: number) => string} spec.key
 * @param {(item: T, index: number) => Element} spec.create
 * @param {(element: Element, item: T, index: number) => void} [spec.update]
 * @returns {{ created: string[], updated: string[], removed: string[] }}
 */
export function reconcile(container, items, { key, create, update }) {
  const existing = new Map();
  for (const child of [...container.children]) {
    const k = child.dataset?.[KEY_ATTR];
    if (k == null) child.remove(); // not ours; never leave unkeyed rows to drift
    else existing.set(k, child);
  }

  const created = [];
  const updated = [];
  const keys = items.map((item, i) => String(key(item, i)));

  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k)) throw new Error(`reconcile: duplicate key ${k}`);
    seen.add(k);
  }

  // Place each item in order. insertBefore on a node already in the right
  // place is a no-op in every engine, so this both creates and reorders.
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const k = keys[i];
    let node = existing.get(k);
    if (node) {
      if (update) update(node, items[i], i);
      updated.push(k);
      existing.delete(k);
    } else {
      node = create(items[i], i);
      node.dataset[KEY_ATTR] = k;
      created.push(k);
    }
    const atCursor = container.children[cursor];
    if (atCursor !== node) container.insertBefore(node, atCursor || null);
    cursor++;
  }

  const removed = [...existing.keys()];
  for (const node of existing.values()) node.remove();

  return { created, updated, removed };
}
