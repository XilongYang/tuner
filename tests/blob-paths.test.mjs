import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOB_MANIFEST_PATH, BLOB_RECORDINGS_PREFIX, blobRecordingPath,
  BLOB_REFERENCES_PREFIX, blobReferencePath,
  BLOB_ASSESSMENTS_PREFIX, blobAssessmentPath,
  BLOB_INPUTTEXT_PREFIX, blobInputTextPath,
  BLOB_SOURCEAUDIO_PREFIX, blobSourceAudioPath,
  BLOB_VOCAB_AUDIO_PREFIX, blobVocabAudioPath, referencedVocabAudioPaths,
  referencedBlobPaths,
} from '../js/sync/blob-paths.js';

test('blob path builders: each nests under its own prefix and matches the constant', () => {
  assert.equal(BLOB_MANIFEST_PATH, 'tuner/manifest.json');

  assert.equal(blobRecordingPath('sess1', 'sent1'), `${BLOB_RECORDINGS_PREFIX}sess1/sent1.wav`);
  assert.ok(blobRecordingPath('sess1', 'sent1').startsWith(BLOB_RECORDINGS_PREFIX));

  assert.equal(blobReferencePath('sess1', 'sent1'), `${BLOB_REFERENCES_PREFIX}sess1/sent1.audio`);
  assert.equal(blobAssessmentPath('sess1', 'sent1'), `${BLOB_ASSESSMENTS_PREFIX}sess1/sent1.json`);
  assert.equal(blobInputTextPath('sess1'), `${BLOB_INPUTTEXT_PREFIX}sess1.txt`);
  assert.equal(blobSourceAudioPath('sess1'), `${BLOB_SOURCEAUDIO_PREFIX}sess1.audio`);
  assert.equal(blobVocabAudioPath('key1', 'occ1'), `${BLOB_VOCAB_AUDIO_PREFIX}key1/occ1.audio`);
});

test('blob path builders: distinct sessions/sentences never collide', () => {
  const a = blobRecordingPath('sessA', 'sentX');
  const b = blobRecordingPath('sessB', 'sentX');
  const c = blobRecordingPath('sessA', 'sentY');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('referencedBlobPaths: pulls the right path out of each content-kind flag on a manifest session', () => {
  const sessions = [
    {
      id: 's1',
      hasInputText: true,
      hasSourceAudio: false,
      sentences: [
        { id: 'a', hasRecording: true, hasReference: false, hasAssessment: true },
        { id: 'b', hasRecording: false, hasReference: true, hasAssessment: false },
      ],
    },
    {
      id: 's2',
      hasInputText: false,
      hasSourceAudio: true,
      sentences: [],
    },
  ];
  const result = referencedBlobPaths(sessions);
  assert.deepEqual(result.recordingPaths, [blobRecordingPath('s1', 'a')]);
  assert.deepEqual(result.referencePaths, [blobReferencePath('s1', 'b')]);
  assert.deepEqual(result.assessmentPaths, [blobAssessmentPath('s1', 'a')]);
  assert.deepEqual(result.inputTextPaths, [blobInputTextPath('s1')]);
  assert.deepEqual(result.sourceAudioPaths, [blobSourceAudioPath('s2')]);
});

test('referencedBlobPaths: missing/empty sessions array yields all-empty path sets, not a throw', () => {
  const result = referencedBlobPaths(undefined);
  assert.deepEqual(result, {
    recordingPaths: [], referencePaths: [], assessmentPaths: [], inputTextPaths: [], sourceAudioPaths: [],
  });
});

test('referencedVocabAudioPaths: pulls a path per audio-bearing source, skipping text-only occurrences', () => {
  const vocab = [
    {
      audioPathKey: 'keyA',
      sources: [
        { occurrenceId: 'occ1', hasAudio: true },
        { occurrenceId: 'occ2', hasAudio: false },
      ],
    },
    {
      audioPathKey: 'keyB',
      sources: [{ occurrenceId: 'occ3', hasAudio: true }],
    },
  ];
  const result = referencedVocabAudioPaths(vocab);
  assert.deepEqual(result, [
    blobVocabAudioPath('keyA', 'occ1'),
    blobVocabAudioPath('keyB', 'occ3'),
  ]);
});

test('referencedVocabAudioPaths: missing/empty vocab array yields an empty list, not a throw', () => {
  assert.deepEqual(referencedVocabAudioPaths(undefined), []);
  assert.deepEqual(referencedVocabAudioPaths([]), []);
});
