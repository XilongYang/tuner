// The settings sidebar: the credentials the speech services need, the container
// cloud sync uses, and the sync controls.
//
// Credentials are shown as configured-or-not rather than displayed back. A key
// that is echoed into a field is a key that ends up in a screenshot, and there
// is nothing to do with a stored key except replace it.

import { el, button } from '../../dom.js';
import { confirmModal } from '../../modal.js';
import { LANGS, LANG_NAMES, LOCALES } from '../../../model/lang.js';
import { voiceOptions } from '../../../model/voices.js';

export function createSettingsPanel({ container, actions, settings }) {
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
      settings.saveSasUrl(url);
      sasInput.value = '';
      say(url ? 'Sync container saved.' : 'Sync container cleared.');
      refresh();
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
  const credentialForm = el('div', { class: 'settings-form' }, [
    field('Key', keyInput),
    field('Region', regionInput),
    field('Resource name', resourceInput),
    el('div', { class: 'settings-actions' }, [saveCredentials]),
  ]);

  container.append(
    el('h2', { class: 'panel-title', text: 'Settings' }),
    status,
    section('Speech service', [
      credentialState,
      credentialForm,
      el('div', { class: 'settings-actions' }, [clearCredentials]),
    ]),
    section('Voices', voiceRows),
    section('Cloud sync', [
      sasState,
      field('Container SAS URL', sasInput),
      el('div', { class: 'settings-actions' }, [saveSas, syncBtn, clearLockBtn]),
    ]),
  );

  function refresh() {
    const credentials = settings.credentials();
    credentialState.textContent = credentials
      ? `Configured for ${credentials.region}${credentials.resourceName ? ` · ${credentials.resourceName}` : ' · no resource name, so audio import is unavailable'}`
      : 'Not configured. Speaking, scoring and audio import need a key and region.';
    regionInput.value = credentials?.region ?? '';
    resourceInput.value = credentials?.resourceName ?? '';
    credentialForm.hidden = Boolean(credentials);
    clearCredentials.hidden = !credentials;

    for (const [locale, select] of voicePickers) fillVoices(locale, select);

    const sasUrl = settings.sasUrl();
    sasState.textContent = sasUrl ? 'A sync container is configured.' : 'No sync container. Everything stays on this device.';
    syncBtn.disabled = !sasUrl;
    clearLockBtn.disabled = !sasUrl;
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

const syncProgress = (progress) => (progress?.total
  ? `Syncing ${progress.done ?? 0} / ${progress.total}…`
  : 'Syncing…');

function describeSync(outcome) {
  if (!outcome.ok) {
    if (outcome.reason === 'not-configured') return 'Add a container SAS URL first.';
    if (outcome.reason?.startsWith('locked-by:')) return `Another device (${outcome.reason.slice('locked-by:'.length)}) is syncing. Try again shortly.`;
    if (outcome.reason === 'locked') return 'Another device is syncing. Try again shortly.';
    return `Sync failed: ${outcome.reason}`;
  }
  const parts = [`${outcome.uploaded} uploaded`, `${outcome.downloaded} downloaded`];
  if (outcome.deleted) parts.push(`${outcome.deleted} deleted`);
  if (outcome.skipped) parts.push(`${outcome.skipped} left for the next round`);
  if (outcome.swept) parts.push(`${outcome.swept} orphaned file${outcome.swept === 1 ? '' : 's'} removed`);
  const warnings = outcome.warnings?.length ? ` (${outcome.warnings.length} warning${outcome.warnings.length === 1 ? '' : 's'})` : '';
  return `Sync complete — ${parts.join(', ')}.${warnings}`;
}
