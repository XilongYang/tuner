import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../../js/platform/player.js';

/** Tracks every URL created and revoked, which is the property most worth testing. */
function fakeAudioEnvironment({ failPlay = false } = {}) {
  const created = [];
  const revoked = [];
  let next = 1;
  const elements = [];

  return {
    created,
    revoked,
    elements,
    live: () => created.filter((u) => !revoked.includes(u)),
    last: () => elements[elements.length - 1],
    deps: {
      createObjectUrl: () => { const url = `blob:${next++}`; created.push(url); return url; },
      revokeObjectUrl: (url) => revoked.push(url),
      createAudio: (url) => {
        const element = {
          url,
          paused: false,
          onended: null,
          onerror: null,
          pause() { this.paused = true; },
          play: async () => { if (failPlay) throw new Error('autoplay blocked'); },
        };
        elements.push(element);
        return element;
      },
    },
  };
}

const clip = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

test('play: starts a clip and reports what is playing', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);

  assert.equal(await player.play(clip(), 'btn-a'), true);
  assert.equal(player.current(), 'btn-a');
  assert.equal(player.isPlaying('btn-a'), true);
  assert.equal(player.isPlaying('btn-b'), false);
});

test('play: the same token again stops it, so one button both starts and stops', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);
  await player.play(clip(), 'btn-a');

  assert.equal(await player.play(clip(), 'btn-a'), false);
  assert.equal(player.current(), null);
  assert.deepEqual(env.live(), [], 'and the URL was released');
});

test('play: a different token replaces what was playing and releases its URL', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);

  await player.play(clip(), 'btn-a');
  const first = env.created[0];
  await player.play(clip(), 'btn-b');

  assert.equal(player.current(), 'btn-b');
  assert.ok(env.revoked.includes(first), 'the replaced clip was released');
  assert.equal(env.live().length, 1, 'exactly one URL is held at a time');
});

test('reaching the end releases the URL', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);
  await player.play(clip(), 'btn-a');

  env.last().onended();

  assert.equal(player.current(), null);
  assert.deepEqual(env.live(), []);
});

test('a clip the browser cannot decode releases the URL too', async () => {
  // Without an error path, one undecodable clip pins its Blob for the life of
  // the tab.
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);
  await player.play(clip(), 'btn-a');

  env.last().onerror();

  assert.equal(player.current(), null);
  assert.deepEqual(env.live(), []);
});

test('a refused play leaves nothing held and reports failure', async () => {
  const env = fakeAudioEnvironment({ failPlay: true });
  const player = createPlayer(env.deps);

  assert.equal(await player.play(clip(), 'btn-a'), false);
  assert.equal(player.current(), null);
  assert.deepEqual(env.live(), []);
});

test('stop: releases and is safe to call when nothing is playing', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);

  player.stop();
  await player.play(clip(), 'btn-a');
  player.stop();
  player.stop();

  assert.equal(player.current(), null);
  assert.deepEqual(env.live(), []);
});

test('many plays in a row never accumulate URLs', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);

  for (let i = 0; i < 20; i++) await player.play(clip(), `btn-${i}`);
  assert.equal(env.created.length, 20);
  assert.equal(env.live().length, 1, 'only the one currently playing');

  player.stop();
  assert.deepEqual(env.live(), []);
});

test('subscribers hear starts and stops, so buttons can show their state', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);
  const heard = [];
  const off = player.subscribe((token) => heard.push(token));

  await player.play(clip(), 'a');
  await player.play(clip(), 'b');
  player.stop();

  assert.deepEqual(heard, ['a', 'b', null]);

  off();
  await player.play(clip(), 'c');
  assert.deepEqual(heard, ['a', 'b', null], 'unsubscribing stops delivery');
});

test('playing pauses the element it replaces rather than leaving it running', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);

  await player.play(clip(), 'a');
  const first = env.last();
  await player.play(clip(), 'b');

  assert.equal(first.paused, true);
});

test('a null token plays without claiming to be any particular source', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);

  assert.equal(await player.play(clip()), true);
  assert.equal(player.current(), null);
  assert.equal(player.isPlaying(null), false, 'null never counts as "this one is playing"');
});

test('onTime: reports how far into the clip playback is, with its token', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);
  const ticks = [];
  player.onTime((token, elapsedMs) => ticks.push([token, elapsedMs]));

  await player.play(new Blob(['a']), 's1');
  const element = env.last();
  element.currentTime = 0.25;
  element.ontimeupdate();
  element.currentTime = 1.5;
  element.ontimeupdate();

  assert.deepEqual(ticks, [['s1', 250], ['s1', 1500]]);
});

test('onTime: unsubscribing stops the reports, so a row that is gone is not called', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);
  const ticks = [];
  const stop = player.onTime((...args) => ticks.push(args));

  await player.play(new Blob(['a']), 's1');
  stop();
  env.last().currentTime = 1;
  env.last().ontimeupdate();

  assert.deepEqual(ticks, []);
});

test('onTime: a time listener is not told about starts and stops, and buttons are not told about time', async () => {
  const env = fakeAudioEnvironment();
  const player = createPlayer(env.deps);
  const states = [];
  const ticks = [];
  player.subscribe((token) => states.push(token));
  player.onTime(() => ticks.push('tick'));

  await player.play(new Blob(['a']), 's1');
  env.last().currentTime = 0.1;
  env.last().ontimeupdate();
  player.stop();

  assert.deepEqual(states, ['s1', null], 'one start, one stop -- no repaint per tick');
  assert.deepEqual(ticks, ['tick']);
});
