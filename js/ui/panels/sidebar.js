// The one sidebar, and the tabs that say what is in it.
//
// There used to be two sidebars with a header button each, and the header was
// growing a button per list. What they hold is all the same kind of thing --
// what is stored, and how this device is set up -- and only one of them could
// be open at a time anyway, so the choice belongs inside the panel rather than
// in the masthead.
//
// This owns the tab row and which view is showing; a view owns its own
// contents and knows nothing about its siblings. Which one is open is the
// registry's (see ./registry.js) -- the same state machine as before, now
// driving tabs instead of two buttons.

import { button } from '../dom.js';
import { createPanelRegistry } from './registry.js';

/**
 * @param {object} spec
 * @param {Element} spec.container The sidebar itself, hidden when nothing is open.
 * @param {Element} spec.tabs Where the tab row is built.
 * @param {Array<{name: string, label: string, panel: {setOpen: Function}, tab?: string}>} spec.views
 *   `tab` is for views that share one panel: the library holds both the
 *   sessions list and the vocabulary list, so its two tabs name the same panel
 *   and differ only in what they ask it to show.
 * @param {(open: string|null) => void} [spec.onChange]
 */
export function createSidebar({ container, tabs, views, onChange = () => {} }) {
  const buttons = new Map();

  /**
   * Show the view that is open and hide the rest.
   *
   * Closing runs first and opening second, deliberately. Two views can name the
   * same panel -- the library's two lists do -- and a loop that opened one of
   * them before closing the other would leave the panel shut, depending on
   * nothing but the order the views happened to be listed in.
   */
  function applyViews(open) {
    const active = views.find((view) => view.name === open) ?? null;
    for (const view of views) {
      if (view.panel !== active?.panel) view.panel.setOpen(false);
    }
    active?.panel.setOpen(true, active.tab);
  }

  function show(open) {
    applyViews(open);
    container.hidden = open === null;
    for (const [name, btn] of buttons) {
      const isOpen = name === open;
      btn.classList.toggle('is-active', isOpen);
      btn.setAttribute('aria-selected', String(isOpen));
      // A closed sidebar's tabs are not reachable, and a tab nobody can reach
      // should not be in the tab order either.
      btn.tabIndex = open === null || isOpen ? 0 : -1;
    }
    onChange(open);
  }

  const registry = createPanelRegistry({ onChange: show });

  for (const view of views) {
    // Each name is its own entry even when two of them share a panel: "open the
    // vocabulary" has to be able to mean something different from "open the
    // sessions". The entry carries no behaviour -- applyViews decides what each
    // panel is told, because that decision has to see all the views at once.
    registry.register(view.name, { setOpen: () => {} });

    const btn = button({
      class: 'btn panel-tab',
      text: view.label,
      role: 'tab',
      onClick: () => registry.open(view.name),
    });
    btn.setAttribute('aria-selected', 'false');
    buttons.set(view.name, btn);
    tabs.append(btn);
  }

  // The closed state is applied rather than assumed: the markup says the
  // sidebar starts hidden, but nothing here should depend on the markup and the
  // code agreeing about it, and the header button needs to be told where it
  // stands before anyone presses it.
  show(null);

  return {
    /** Open the sidebar on `name`, or close it if that view is already showing. */
    toggle: (name) => registry.toggle(name),
    open: (name) => registry.open(name),
    close: () => registry.closeAll(),
    current: () => registry.current(),
    isOpen: (name) => registry.isOpen(name),
  };
}
