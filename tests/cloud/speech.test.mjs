import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  speechClient, parseAssessment, normalizeTranscript, buildSsml, toBase64Utf8, ticksToMs,
} from '../../js/cloud/speech.js';

const CREDS = { key: 'secret', region: 'japaneast', resourceName: 'my-resource' };

let calls = [];
const realFetch = globalThis.fetch;
function stubFetch(responder) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url, opts);
  };
}
afterEach(() => { globalThis.fetch = realFetch; });

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// ---- Pure parsing ----

test('ticksToMs: converts 100-nanosecond ticks to milliseconds', () => {
  assert.equal(ticksToMs(10_000), 1);
  assert.equal(ticksToMs(12_345_000), 1234.5);
  assert.equal(ticksToMs(0), 0);
});

test('ticksToMs: absent timing is null, not 0 -- an omitted word has no audio at all', () => {
  assert.equal(ticksToMs(undefined), null);
  assert.equal(ticksToMs(null), null);
  assert.equal(ticksToMs('123'), null);
  assert.equal(ticksToMs(NaN), null);
});

test('buildSsml: puts xml:lang on speak only, because voice-level xml:lang is rejected', () => {
  const ssml = buildSsml('hello', 'en-US', 'en-US-JennyNeural');
  assert.match(ssml, /<speak [^>]*xml:lang="en-US"/);
  assert.match(ssml, /<voice name="en-US-JennyNeural">/);
  assert.equal(/<voice[^>]*xml:lang/.test(ssml), false);
});

test('buildSsml: escapes text that would otherwise break the document', () => {
  assert.match(buildSsml('5 < 6 & "quoted"', 'en-US', 'v'), /5 &lt; 6 &amp; &quot;quoted&quot;/);
});

test('toBase64Utf8: round-trips non-ASCII reference text', () => {
  const encoded = toBase64Utf8('難しい');
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))), '難しい');
});

const assessmentResponse = (over = {}) => ({
  RecognitionStatus: 'Success',
  DisplayText: 'Hello there.',
  NBest: [{
    Display: 'Hello there.',
    PronunciationAssessment: { AccuracyScore: 92, FluencyScore: 88, CompletenessScore: 100, PronScore: 90 },
    Words: [{
      Word: 'hello',
      PronunciationAssessment: { AccuracyScore: 95, ErrorType: 'None' },
      Offset: 1_000_000,
      Duration: 5_000_000,
      Phonemes: [{ Phoneme: 'h', PronunciationAssessment: { AccuracyScore: 90 } }],
    }],
  }],
  ...over,
});

test('parseAssessment: reads overall and per-word scores from the nested shape', () => {
  const result = parseAssessment(assessmentResponse());
  assert.deepEqual(result.overall, { accuracy: 92, fluency: 88, completeness: 100, pronunciation: 90 });
  assert.equal(result.words[0].word, 'hello');
  assert.equal(result.words[0].accuracy, 95);
  assert.equal(result.words[0].offsetMs, 100);
  assert.equal(result.words[0].durationMs, 500);
});

test('parseAssessment: reads the same scores from the flat shape the conversation endpoint returns', () => {
  const result = parseAssessment({
    RecognitionStatus: 'Success',
    NBest: [{
      Display: 'x',
      AccuracyScore: 70, FluencyScore: 60, CompletenessScore: 50, PronScore: 65,
      Words: [{ Word: 'x', AccuracyScore: 55, ErrorType: 'Mispronunciation' }],
    }],
  });
  assert.deepEqual(result.overall, { accuracy: 70, fluency: 60, completeness: 50, pronunciation: 65 });
  assert.equal(result.words[0].accuracy, 55);
  assert.equal(result.words[0].errorType, 'Mispronunciation');
});

test('parseAssessment: a missing score reads as 0 rather than undefined', () => {
  const result = parseAssessment({ RecognitionStatus: 'Success', NBest: [{ Display: '', Words: [] }] });
  assert.deepEqual(result.overall, { accuracy: 0, fluency: 0, completeness: 0, pronunciation: 0 });
});

test('parseAssessment: an omitted word keeps null timings, so callers can tell there is no audio', () => {
  const result = parseAssessment(assessmentResponse({
    NBest: [{ Display: 'x', Words: [{ Word: 'skipped', PronunciationAssessment: { ErrorType: 'Omission' } }] }],
  }));
  assert.equal(result.words[0].errorType, 'Omission');
  assert.equal(result.words[0].offsetMs, null);
  assert.equal(result.words[0].durationMs, null);
});

test('parseAssessment: drops unnamed phonemes, which Japanese returns', () => {
  const result = parseAssessment(assessmentResponse({
    NBest: [{
      Display: 'x',
      Words: [{ Word: '難しい', Phonemes: [{ Phoneme: '', PronunciationAssessment: { AccuracyScore: 80 } }, { Phoneme: 'm', PronunciationAssessment: { AccuracyScore: 70 } }] }],
    }],
  }));
  assert.deepEqual(result.words[0].phonemes, [{ phoneme: 'm', accuracy: 70 }]);
});

test('parseAssessment: nothing recognised throws with the reason and what to do', () => {
  assert.throws(() => parseAssessment({ RecognitionStatus: 'NoMatch' }), /No speech was recognised \(NoMatch\)/);
  assert.throws(() => parseAssessment({ RecognitionStatus: 'InitialSilenceTimeout' }), /InitialSilenceTimeout/);
  assert.throws(() => parseAssessment(null), /unknown status/);
});

test('parseAssessment: a successful status with no candidate is still an error, not empty scores', () => {
  assert.throws(() => parseAssessment({ RecognitionStatus: 'Success', NBest: [] }), /no result/);
});

test('normalizeTranscript: maps locales to app languages and ticks-free timings to ms', () => {
  const result = normalizeTranscript({
    durationMilliseconds: 5000,
    phrases: [
      { locale: 'ja-JP', text: '今日は', offsetMilliseconds: 0, durationMilliseconds: 900, words: [{ text: '今日', offsetMilliseconds: 0, durationMilliseconds: 500 }] },
      { locale: 'en-US', text: 'Hello', offsetMilliseconds: 1000, durationMilliseconds: 800, words: [] },
    ],
  });

  assert.equal(result.durationMs, 5000);
  assert.deepEqual(result.phrases.map((p) => p.lang), ['ja', 'en']);
  assert.deepEqual(result.phrases[0].words, [{ text: '今日', offsetMs: 0, durationMs: 500 }]);
  assert.equal(result.phrases[1].offsetMs, 1000);
});

test('normalizeTranscript: no vendor field name survives the boundary', () => {
  const result = normalizeTranscript({ phrases: [{ locale: 'en-US', text: 'x', offsetMilliseconds: 1, durationMilliseconds: 2, words: [{ text: 'x', offsetMilliseconds: 1, durationMilliseconds: 2 }] }] });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('Milliseconds'), false);
  assert.equal(serialized.includes('locale'), false);
});

test('normalizeTranscript: an empty or malformed response gives no phrases rather than throwing', () => {
  assert.deepEqual(normalizeTranscript({}), { phrases: [], durationMs: null });
  assert.deepEqual(normalizeTranscript(null), { phrases: [], durationMs: null });
});

// ---- Requests ----

test('synthesize: posts SSML to the region endpoint with the key and the audio format', async () => {
  stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } }));
  const blob = await speechClient(CREDS).synthesize('hello', 'en-US', 'en-US-JennyNeural');

  assert.equal(calls[0].url, 'https://japaneast.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(calls[0].opts.headers['Ocp-Apim-Subscription-Key'], 'secret');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/ssml+xml');
  assert.match(calls[0].opts.headers['X-Microsoft-OutputFormat'], /mp3/);
  assert.match(calls[0].opts.body, /<voice name="en-US-JennyNeural">hello<\/voice>/);
  assert.equal(blob.size, 3);
});

test('assess: sends the required content type, the locale, and the config header', async () => {
  stubFetch(() => json(assessmentResponse()));
  const result = await speechClient(CREDS).assess(new Blob([new Uint8Array([1])]), '難しい', 'ja-JP');

  assert.match(calls[0].url, /language=ja-JP&format=detailed/);
  assert.equal(calls[0].opts.headers['Content-Type'], 'audio/wav; codecs=audio/pcm; samplerate=16000');

  const config = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(calls[0].opts.headers['Pronunciation-Assessment']), (c) => c.charCodeAt(0))));
  assert.equal(config.ReferenceText, '難しい');
  assert.equal(config.Granularity, 'Phoneme');
  assert.equal(config.EnableMiscue, true);
  assert.equal(result.overall.accuracy, 92);
});

test('transcribe: posts the file as multipart and lets fetch set the boundary', async () => {
  stubFetch(() => json({ durationMilliseconds: 1000, phrases: [] }));
  await speechClient(CREDS).transcribe(new Blob([new Uint8Array([1])], { type: 'audio/wav' }));

  assert.match(calls[0].url, /^https:\/\/my-resource\.cognitiveservices\.azure\.com\/speechtotext\/transcriptions:transcribe\?api-version=/);
  assert.ok(calls[0].opts.body instanceof FormData);
  assert.equal('Content-Type' in calls[0].opts.headers, false, 'a hand-written Content-Type would omit the multipart boundary');
  assert.deepEqual(JSON.parse(calls[0].opts.body.get('definition')), { locales: ['ja-JP', 'en-US'] });
});

test('transcribe: requested locales can be narrowed', async () => {
  stubFetch(() => json({ phrases: [] }));
  await speechClient(CREDS).transcribe(new Blob(), ['ja-JP']);
  assert.deepEqual(JSON.parse(calls[0].opts.body.get('definition')), { locales: ['ja-JP'] });
});

test('a rejected key says so, for all three operations', async () => {
  for (const status of [401, 403]) {
    stubFetch(() => new Response('', { status }));
    const client = speechClient(CREDS);
    await assert.rejects(() => client.synthesize('x', 'en-US', 'v'), /key or region was rejected/);
    await assert.rejects(() => client.assess(new Blob(), 'x', 'en-US'), /key or region was rejected/);
    await assert.rejects(() => client.transcribe(new Blob()), /key or region was rejected/);
  }
});

test('a quota failure is distinguished from any other error', async () => {
  stubFetch(() => new Response('', { status: 429 }));
  await assert.rejects(() => speechClient(CREDS).synthesize('x', 'en-US', 'v'), /quota is exhausted/);
});

test('another failure carries the status and the body', async () => {
  stubFetch(() => new Response('Voice not found', { status: 400 }));
  await assert.rejects(() => speechClient(CREDS).synthesize('x', 'en-US', 'bad-voice'), /HTTP 400 — Voice not found/);
});

test('a network failure points at the connection and the region', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => speechClient(CREDS).assess(new Blob(), 'x', 'en-US'), /could not be sent.*region/s);
});
