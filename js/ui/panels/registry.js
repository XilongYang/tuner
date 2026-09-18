// Which sidebar is open.
//
// Only one at a time, and a panel does not know which others exist. The
// previous implementation gave each panel an import of its sibling's close
// function, which meant every new panel added an edge to every existing one and
// left a three-way tangle of lateral dependencies that tests/arch.test.mjs now
// forbids outright.
//
// A panel registers itself with a name and how to show and hide itself. The
// registry decides what is open.

export function createPanelRegistry({ onChange = () => {} } = {}) {
  const panels = new Map();
  let openName = null;

  const apply = () => {
    for (const [name, panel] of panels) panel.setOpen(name === openName);
    onChange(openName);
  };

  return {
    /** @param {{setOpen: (open: boolean) => void}} panel */
    register(name, panel) {
      panels.set(name, panel);
      panel.setOpen(name === openName);
      return () => panels.delete(name);
    },

    open(name) {
      if (!panels.has(name)) return false;
      openName = name;
      apply();
      return true;
    },

    close(name) {
      // Closing a panel that is not the open one is a no-op rather than an
      // error: a close arriving late, after something else opened, must not
      // shut whatever is now showing.
      if (openName !== name) return false;
      openName = null;
      apply();
      return true;
    },

    toggle(name) {
      return openName === name ? this.close(name) : this.open(name);
    },

    closeAll() {
      if (openName === null) return false;
      openName = null;
      apply();
      return true;
    },

    current: () => openName,
    isOpen: (name) => openName === name,
  };
}
