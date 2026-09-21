// The settings sidebar: the credentials the speech services need, the container
// cloud sync uses, and the sync controls.
//
// Credentials are shown as configured-or-not rather than displayed back. A key
// that is echoed into a field is a key that ends up in a screenshot, and there
// is nothing to do with a stored key except replace it.

import { el, button } from '../../dom.js';
import { confirmModal } from '../../modal.js';
import { describeSync, syncProgress } from '../../sync-text.js';
import { LANGS, LANG_NAMES, LOCALES } from '../../../model/lang.js';
import { voiceOptions } from '../../../model/voices.js';

/**
 * @param {object} args
 * @param {() => void} [args.onContainerChange] Told when the sync container is
 *   set or forgotten here, because what the header shows about syncing depends
 *   on whether there is anything to sync with.
 */
export function createSettingsPanel({ container, actions, settings, onContainerChange = () => {} }) {
  const status = el('p', { class: 'panel-status', hidden: true });
  const say = (message, kind = 'info') => {
    status.hidden = !message;
    status.textContent = message || '';
    status.dataset.kind = kind;
  };

  // ---- Speech credentials ----
  const keyInput = el('input', { class: 'settings-input', type: 'password', placeholder: 'Subscription key', 'aria-label': 'Azure subscription key' });
  const regionInput = el('input', { class: 'settings-input', type: 'text', placeholder: 'Region (e.g. japaneast)', 'aria-label': 'Azure region' });
  const resourceInput = el('input', { class: 'settings-input', type: 'text', placeholder: 'Resource name (for audio import)', 'aria-label': 'Azure resource name' });
  const credentialState = el('p', { class: 'settings-state' });

  const saveCredentials = button({
    class: 'btn primary', text: 'Save',
    onClick: () => {
      const key = keyInput.value.trim();
      const region = regionInput.value.trim();
      if (!key || !region) {
        say('A key and a region are both needed.', 'error');
        return;
      }
      const saved = settings.saveCredentials({ key, region, resourceName: resourceInput.value.trim() });
      // Cleared immediately whether or not the write succeeded: the field has
      // done its job, and a key left in the DOM is a key in the next screenshot.
      keyInput.value = '';
      say(saved ? 'Credentials saved.' : 'Could not save: this browser is refusing to store settings.', saved ? 'info' : 'error');
      refresh();
    },
  });

  const clearCredentials = button({
    class: 'btn danger', text: 'Clear',
    onClick: async () => {
      if (!await confirmModal({ title: 'Clear credentials?', message: 'Speaking, scoring and audio import will stop working until new ones are entered.', confirmLabel: 'Clear', danger: true })) return;
      settings.clearCredentials();
      say('Credentials cleared.');
      refresh();
    },
  });

  // ---- Voices ----
  //
  // A picker rather than a text field: a voice is chosen from what the service
  // offers, and a mistyped name fails only later, at the point of speaking,
  // with a service error that says nothing about what was wrong.
  const voicePickers = new Map();
  const voiceRows = LANGS.map((lang) => {
    const locale = LOCALES[lang];
    const select = el('select', { class: 'settings-input', 'aria-label': `${LANG_NAMES[lang]} voice` });
    select.addEventListener('change', () => {
      settings.saveVoice(locale, select.value);
      say(`${LANG_NAMES[lang]} voice: ${select.selectedOptions[0]?.textContent ?? select.value}.`);
    });
    voicePickers.set(locale, select);
    return el('label', { class: 'settings-field' }, [el('span', { text: `${LANG_NAMES[lang]} voice` }), select]);
  });

  /** Fill a picker with the voices on offer, plus whatever is currently chosen. */
  function fillVoices(locale, select) {
    const chosen = settings.voice(locale);
    const options = voiceOptions(locale, chosen);
    // Rebuilt only when the set of options actually differs, so re-opening the
    // panel does not discard a dropdown the user has open.
    const same = options.length === select.options.length
      && options.every((option, index) => select.options[index].value === option.id);
    if (!same) {
      select.replaceChildren(...options.map((option) => el('option', { value: option.id, text: option.label })));
    }
    select.value = chosen;
  }

  // ---- Cloud sync ----
  const sasInput = el('input', { class: 'settings-input', type: 'password', placeholder: 'Container SAS URL', 'aria-label': 'Container SAS URL' });
  const sasState = el('p', { class: 'settings-state' });

  const saveSas = button({
    class: 'btn primary', text: 'Save',
    onClick: () => {
      const url = sasInput.value.trim();
      if (!url) {
        say('Paste the container SAS URL first.', 'error');
        return;
      }
      const saved = settings.saveSasUrl(url);
      // Cleared whether or not the write succeeded: a SAS URL carries its own
      // signature, and a field holding one is a credential left on screen.
      sasInput.value = '';
      say(saved ? 'Sync container saved.' : 'Could not save: this browser is refusing to store settings.', saved ? 'info' : 'error');
      refresh();
      onContainerChange();
    },
  });

  // "Forget", not "Clear": it sits beside a button that deletes what is in the
  // container, and two buttons both called Clear next to each other is how the
  // wrong one gets pressed. This one only forgets the URL, on this device.
  const clearSas = button({
    class: 'btn danger', text: 'Forget container',
    onClick: async () => {
      if (!await confirmModal({
        title: 'Forget the sync container?',
        message: 'The URL is removed from this device. Nothing in the container is deleted, and everything here stays as it is -- there is simply nothing to sync with until a container is set again.',
        confirmLabel: 'Forget it',
        danger: true,
      })) return;
      settings.saveSasUrl('');
      say('Sync container cleared.');
      refresh();
      onContainerChange();
    },
  });

  const syncBtn = button({
    class: 'btn', text: 'Sync now',
    onClick: async () => {
      syncBtn.disabled = true;
      say('Syncing…', 'busy');
      try {
        const outcome = await actions.sync((progress) => say(syncProgress(progress), 'busy'));
        say(describeSync(outcome), outcome.ok ? 'info' : 'error');
      } finally {
        syncBtn.disabled = false;
      }
    },
  });

  const eraseCloudBtn = button({
    class: 'btn danger', text: 'Clear cloud data',
    title: 'Delete everything in the sync container. This device keeps its own copy.',
    onClick: async () => {
      if (!await confirmModal({
        title: 'Delete everything in the container?',
        message: 'Every session, recording and word stored in the cloud is removed, for every device that syncs with it. This device keeps its own copy, and the next sync uploads it again.',
        confirmLabel: 'Delete it all',
        danger: true,
      })) return;

      eraseCloudBtn.disabled = true;
      say('Clearing the container…', 'busy');
      try {
        const outcome = await actions.eraseCloud((progress) => say(erasing(progress), 'busy'));
        say(describeErase(outcome), outcome.ok ? 'info' : 'error');
      } finally {
        eraseCloudBtn.disabled = false;
        refresh();
      }
    },
  });

  const clearLockBtn = button({
    class: 'btn', text: 'Clear sync lock',
    title: 'Use this only if a device that will not come back left the lock held',
    onClick: async () => {
      if (!await confirmModal({
        title: 'Clear the sync lock?',
        message: 'Do this only if a device that has stopped syncing left it held. Clearing it while another device is mid-sync lets two devices write at once.',
        confirmLabel: 'Clear it',
        danger: true,
      })) return;
      const outcome = await actions.clearSyncLock();
      say(outcome.ok ? 'Sync lock cleared.' : `Could not clear it: ${outcome.reason}`, outcome.ok ? 'info' : 'error');
    },
  });

  // The fields and the Save button go away once credentials are stored: there
  // is nothing to do with a stored key except replace it, and a form left
  // standing with the key blanked out reads as though it had been lost. Clear
  // brings them back.
  const sasForm = el('div', { class: 'settings-form' }, [
    field('Container SAS URL', sasInput),
    el('div', { class: 'settings-actions' }, [saveSas]),
  ]);

  const credentialForm = el('div', { class: 'settings-form' }, [
    field('Key', keyInput),
    field('Region', regionInput),
    field('Resource name', resourceInput),
    el('div', { class: 'settings-actions' }, [saveCredentials]),
  ]);

  // No heading of its own -- see the library panel for why.
  container.append(
    status,
    section('Speech service', [
      credentialState,
      credentialForm,
      el('div', { class: 'settings-actions' }, [clearCredentials]),
    ]),
    section('Voices', voiceRows),
    section('Cloud sync', [
      sasState,
      // Same as the key above: once it is stored there is nothing to do with it
      // but replace it, and a SAS URL sitting in a field is a credential on
      // screen. Clear brings the field back.
      sasForm,
      // Two rows, and the split is the point: what this panel is for on a
      // normal day on the first, what cannot be undone on the second. Mixing
      // them put Forget container first, so the leftmost button -- where a
      // hand goes without reading -- was a destructive one.
      el('div', { class: 'settings-actions' }, [syncBtn, clearLockBtn]),
      el('div', { class: 'settings-actions' }, [clearSas, eraseCloudBtn]),
    ]),
  );

  function refresh() {
    const credentials = settings.credentials();
    // The region, and nothing else. The resource name is not worth a line of
    // its own -- it is a name this person chose, read back to them -- but its
    // absence is, because two features quietly do not work without it.
    credentialState.textContent = credentials
      ? `Configured for ${credentials.region}${credentials.resourceName ? '' : '. No resource name, so audio import and word timings are unavailable.'}`
      : 'Not configured. Speaking, scoring and audio import need a key and region.';
    regionInput.value = credentials?.region ?? '';
    resourceInput.value = credentials?.resourceName ?? '';
    credentialForm.hidden = Boolean(credentials);
    clearCredentials.hidden = !credentials;

    for (const [locale, select] of voicePickers) fillVoices(locale, select);

    const sasUrl = settings.sasUrl();
    sasState.textContent = sasUrl ? 'A sync container is configured.' : 'No sync container. Everything stays on this device.';
    sasForm.hidden = Boolean(sasUrl);
    clearSas.hidden = !sasUrl;
    syncBtn.disabled = !sasUrl;
    clearLockBtn.disabled = !sasUrl;
    eraseCloudBtn.disabled = !sasUrl;
  }

  refresh();

  return {
    setOpen(open) {
      container.hidden = !open;
      container.classList.toggle('is-open', open);
      if (open) refresh();
    },
    say,
    refresh,
  };
}

const field = (label, input) => el('label', { class: 'settings-field' }, [el('span', { text: label }), input]);
const section = (heading, children) => el('section', { class: 'settings-section' }, [el('h3', { text: heading }), ...children]);

const erasing = (progress) => (progress?.total
  ? `Clearing ${progress.done ?? 0} / ${progress.total}…`
  : 'Clearing the container…');

function describeErase(outcome) {
  if (outcome.ok) {
    return outcome.deleted
      ? `Container cleared — ${outcome.deleted} file${outcome.deleted === 1 ? '' : 's'} deleted. The next sync uploads this device's copy.`
      : 'The container was already empty.';
  }
  if (outcome.reason === 'not-configured') return 'Add a container SAS URL first.';
  if (outcome.reason?.startsWith('locked-by:')) return `Another device (${outcome.reason.slice('locked-by:'.length)}) is syncing. Try again shortly.`;
  if (outcome.reason === 'locked') return 'Another device is syncing. Try again shortly.';
  return `Only ${outcome.deleted} file${outcome.deleted === 1 ? '' : 's'} could be deleted: ${outcome.reason}`;
}

