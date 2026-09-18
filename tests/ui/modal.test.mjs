import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><button id="opener">open</button></body>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

const { openModal, confirmModal, promptModal } = await import('../../js/ui/modal.js');

const backdrop = () => document.querySelector('.modal-backdrop');
const buttonLabelled = (label) => [...document.querySelectorAll('.modal-actions button')].find((b) => b.textContent === label);
const pressEscape = () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

// Every modal opened by a test is closed here. A modal keeps a document-level
// keydown listener until it closes, so simply clearing the body would leave
// listeners from earlier tests alive to intercept a later test's Escape.
const opened = [];
const track = (modal) => { opened.push(modal); return modal; };

beforeEach(() => {
  for (const modal of opened.splice(0)) modal.close?.();
  document.body.replaceChildren(document.createElement('button'));
});

test('opens with its title, body and actions, and marks itself as a dialog', () => {
  track(openModal({ title: 'Are you sure?', body: 'This cannot be undone.', actions: [{ label: 'OK', value: true }] }));

  assert.equal(document.querySelector('.modal-title').textContent, 'Are you sure?');
  assert.equal(document.querySelector('.modal-body').textContent, 'This cannot be undone.');
  assert.equal(document.querySelector('.modal-card').getAttribute('role'), 'dialog');
  assert.equal(document.querySelector('.modal-card').getAttribute('aria-modal'), 'true');
});

test('an action resolves with its value and removes the dialog', async () => {
  const { result } = openModal({ title: 't', body: 'b', actions: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] });

  buttonLabelled('No').click();

  assert.equal(await result, 'no');
  assert.equal(backdrop(), null);
});

test('Escape dismisses, including on a destructive dialog', async () => {
  // The inconsistency this primitive exists to remove: Escape used to close a
  // context menu but not the dialog asking whether to delete everything.
  // confirmModal resolves to the answer directly; openModal is the one that
  // returns { result, close }.
  const result = confirmModal({ title: 'Delete everything?', message: 'x', danger: true });

  pressEscape();

  assert.equal(await result, false);
  assert.equal(backdrop(), null);
});

test('a click on the backdrop dismisses; one inside the card does not', async () => {
  const { result } = openModal({ title: 't', body: 'b', dismissValue: 'dismissed', actions: [{ label: 'OK', value: true }] });

  document.querySelector('.modal-card').click();
  assert.ok(backdrop(), 'still open');

  backdrop().click();
  assert.equal(await result, 'dismissed');
});

test('closing twice resolves once and does not throw', async () => {
  const modal = openModal({ title: 't', body: 'b', dismissValue: 'first', actions: [{ label: 'OK', value: 'button' }] });

  buttonLabelled('OK').click();
  pressEscape();
  modal.close('again');

  assert.equal(await modal.result, 'button');
  assert.equal(backdrop(), null);
});

test('Escape stops working once the dialog is gone', async () => {
  const { result } = openModal({ title: 't', body: 'b', dismissValue: null, actions: [] });
  pressEscape();
  await result;

  // No listener should remain: pressing Escape again must not throw or touch
  // anything.
  pressEscape();
  assert.equal(backdrop(), null);
});

test('focus moves into the dialog and back where it was', async () => {
  const opener = document.querySelector('button');
  opener.focus();
  assert.equal(document.activeElement, opener);

  const { result } = openModal({ title: 't', body: 'b', actions: [{ label: 'OK', value: true, autofocus: true }] });
  assert.equal(document.activeElement, buttonLabelled('OK'));

  buttonLabelled('OK').click();
  await result;
  assert.equal(document.activeElement, opener, 'focus came back');
});

test('a destructive dialog focuses Cancel, so a stray Enter does not confirm it', () => {
  confirmModal({ title: 'Delete?', message: 'x', confirmLabel: 'Delete', danger: true });
  assert.equal(document.activeElement, buttonLabelled('Cancel'));
  assert.ok(buttonLabelled('Delete').classList.contains('danger'));
});

test('an ordinary dialog focuses its confirming action', () => {
  confirmModal({ title: 'Save?', message: 'x', confirmLabel: 'Save' });
  assert.equal(document.activeElement, buttonLabelled('Save'));
});

test('confirmModal resolves true or false', async () => {
  const yes = confirmModal({ title: 't', message: 'm', confirmLabel: 'Go' });
  buttonLabelled('Go').click();
  assert.equal(await yes, true);

  const no = confirmModal({ title: 't', message: 'm' });
  buttonLabelled('Cancel').click();
  assert.equal(await no, false);
});

test('promptModal returns the text, pre-selected for replacing', async () => {
  const result = promptModal({ title: 'Rename', label: 'Name', value: 'Old name' });
  const input = document.querySelector('.modal-input');

  assert.equal(input.value, 'Old name');
  assert.equal(document.activeElement, input);

  input.value = 'New name';
  buttonLabelled('Save').click();
  assert.equal(await result, 'New name');
});

test('promptModal: Enter submits', async () => {
  const result = promptModal({ title: 'Rename', label: 'Name' });
  const input = document.querySelector('.modal-input');
  input.value = 'Typed';

  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  assert.equal(await result, 'Typed');
});

test('promptModal: dismissing returns null rather than an empty string', async () => {
  const result = promptModal({ title: 'Rename', label: 'Name', value: 'Old' });
  pressEscape();
  assert.equal(await result, null);
});

test('two dialogs in sequence leave nothing behind', async () => {
  const first = confirmModal({ title: 'One', message: 'x' });
  buttonLabelled('Cancel').click();
  await first;

  const second = confirmModal({ title: 'Two', message: 'x' });
  assert.equal(document.querySelectorAll('.modal-backdrop').length, 1);
  buttonLabelled('Cancel').click();
  await second;

  assert.equal(document.querySelectorAll('.modal-backdrop').length, 0);
});
