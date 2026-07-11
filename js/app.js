// 主应用逻辑：把各模块串起来，管理句子列表与界面交互。

import { segment } from './segment.js';
import { detectLang, LOCALES } from './lang.js';
import { synthesizeAzure, speakWithBrowser } from './tts.js';
import { assessPronunciation } from './pron.js';
import { Recorder } from './recorder.js';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  hasCredentials,
  loadHideText,
  saveHideText,
  VOICE_OPTIONS,
  getVoice,
  saveVoice,
} from './config.js';

// ---- 全局状态 ----

/** @type {Array<{ id: number, text: string, lang: 'ja'|'en', hidden: boolean, recorder: Recorder, recordingUrl: string|null, recordingBlob: Blob|null }>} */
let sentences = [];
let nextId = 1;

// 全局「隐藏正文」开关，作为每句独立开关的默认值。
let globalHideText = false;

// 供 TTS 播放复用的 audio 元素
const ttsAudio = new Audio();

// ---- DOM 引用 ----
const $ = (sel) => document.querySelector(sel);

const els = {
  input: $('#input-text'),
  splitBtn: $('#split-btn'),
  clearInputBtn: $('#clear-input-btn'),
  list: $('#sentence-list'),
  count: $('#sentence-count'),
  // 凭据面板
  keyInput: $('#azure-key'),
  regionInput: $('#azure-region'),
  saveKeyBtn: $('#save-key-btn'),
  clearKeyBtn: $('#clear-key-btn'),
  keyStatus: $('#key-status'),
  toggleKeyPanel: $('#toggle-key-panel'),
  keyPanel: $('#key-panel'),
  globalHideInput: $('#global-hide-input'),
  voiceJa: $('#voice-ja'),
  voiceEn: $('#voice-en'),
};

// ---- 凭据面板 ----

function refreshKeyStatus() {
  const creds = loadCredentials();
  if (creds) {
    els.keyStatus.textContent = `Saved: Region = ${creds.region} (key hidden)`;
    els.keyStatus.dataset.state = 'ok';
  } else {
    els.keyStatus.textContent = "Not configured: falling back to the browser's built-in voice";
    els.keyStatus.dataset.state = 'empty';
  }
}

function initKeyPanel() {
  const creds = loadCredentials();
  if (creds) els.regionInput.value = creds.region;

  els.saveKeyBtn.addEventListener('click', () => {
    const key = els.keyInput.value.trim();
    const region = els.regionInput.value.trim();
    if (!key || !region) {
      alert('Please enter both Key and Region');
      return;
    }
    saveCredentials(key, region);
    els.keyInput.value = '';
    refreshKeyStatus();
  });

  els.clearKeyBtn.addEventListener('click', () => {
    clearCredentials();
    els.keyInput.value = '';
    refreshKeyStatus();
  });

  els.toggleKeyPanel.addEventListener('click', () => {
    els.keyPanel.hidden = !els.keyPanel.hidden;
    els.toggleKeyPanel.setAttribute('aria-expanded', String(!els.keyPanel.hidden));
  });

  initVoiceSelectors();
  refreshKeyStatus();
}

/** 填充并绑定音色下拉框，选择写入本地存储。 */
function initVoiceSelectors() {
  const wire = (selectEl, locale) => {
    for (const opt of VOICE_OPTIONS[locale]) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    }
    selectEl.value = getVoice(locale);
    selectEl.addEventListener('change', () => saveVoice(locale, selectEl.value));
  };
  wire(els.voiceJa, 'ja-JP');
  wire(els.voiceEn, 'en-US');
}

// ---- 句子列表 ----

function handleSplit() {
  const parts = segment(els.input.value);
  // 释放旧录音资源
  for (const s of sentences) s.recorder.dispose();

  sentences = parts.map((text) => ({
    id: nextId++,
    text,
    lang: detectLang(text),
    hidden: globalHideText, // 默认取全局开关
    recorder: new Recorder(),
    recordingUrl: null,
    recordingBlob: null,
  }));

  render();
}

function render() {
  els.list.innerHTML = '';
  els.count.textContent = sentences.length
    ? `${sentences.length} ${sentences.length > 1 ? 'sentences' : 'sentence'}`
    : '';

  if (sentences.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'Paste text and click Split; sentences will appear here, one per line.';
    els.list.appendChild(empty);
    return;
  }

  sentences.forEach((sentence, index) => {
    els.list.appendChild(renderRow(sentence, index));
  });
}

/** 构造句子文本元素；用内联 span 包裹整句，隐藏时按行渲染为连续黑条。 */
function buildTextEl(sentence) {
  const el = document.createElement('div');
  el.className = 'row-text';
  if (sentence.hidden) el.classList.add('is-hidden');
  const inner = document.createElement('span');
  inner.className = 'row-text-inner';
  inner.textContent = sentence.text;
  el.appendChild(inner);
  return el;
}

/** 刷新单句隐藏开关按钮的显示。 */
function paintHidden(sentence) {
  if (!sentence._hideBtn) return;
  sentence._hideBtn.textContent = sentence.hidden ? 'Show' : 'Hide';
  sentence._hideBtn.setAttribute('aria-pressed', String(sentence.hidden));
}

/** 设置单句的隐藏状态并同步 DOM。 */
function applyHidden(sentence, value) {
  sentence.hidden = value;
  if (sentence._textEl) sentence._textEl.classList.toggle('is-hidden', value);
  paintHidden(sentence);
}

function renderRow(sentence, index) {
  const row = document.createElement('div');
  row.className = 'sentence-row';

  // 序号
  const num = document.createElement('div');
  num.className = 'row-index';
  num.textContent = String(index + 1).padStart(2, '0');
  row.appendChild(num);

  // 主体
  const body = document.createElement('div');
  body.className = 'row-body';

  const textEl = buildTextEl(sentence);
  sentence._textEl = textEl;
  body.appendChild(textEl);

  // 操作区
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  // 语言切换
  const langToggle = document.createElement('button');
  langToggle.className = 'lang-toggle';
  langToggle.type = 'button';
  const paintLang = () => {
    langToggle.textContent = sentence.lang;
    langToggle.title = 'Click to switch language (ja / en)';
  };
  paintLang();
  langToggle.addEventListener('click', () => {
    sentence.lang = sentence.lang === 'ja' ? 'en' : 'ja';
    paintLang();
  });
  actions.appendChild(langToggle);

  // 每句「隐藏正文」独立开关
  const hideBtn = document.createElement('button');
  hideBtn.className = 'hide-toggle';
  hideBtn.type = 'button';
  hideBtn.title = 'Toggle hiding this sentence';
  sentence._hideBtn = hideBtn;
  paintHidden(sentence);
  hideBtn.addEventListener('click', () => applyHidden(sentence, !sentence.hidden));
  actions.appendChild(hideBtn);

  // 朗读
  const playBtn = document.createElement('button');
  playBtn.className = 'btn';
  playBtn.type = 'button';
  playBtn.textContent = 'Speak';
  actions.appendChild(playBtn);

  // 录音
  const recordBtn = document.createElement('button');
  recordBtn.className = 'btn';
  recordBtn.type = 'button';
  recordBtn.textContent = 'Record';
  actions.appendChild(recordBtn);

  // 回放
  const playbackBtn = document.createElement('button');
  playbackBtn.className = 'btn';
  playbackBtn.type = 'button';
  playbackBtn.textContent = 'Playback';
  playbackBtn.hidden = !sentence.recordingUrl;
  actions.appendChild(playbackBtn);

  // 评分
  const scoreBtn = document.createElement('button');
  scoreBtn.className = 'btn';
  scoreBtn.type = 'button';
  scoreBtn.textContent = 'Score';
  scoreBtn.hidden = !sentence.recordingBlob;
  actions.appendChild(scoreBtn);

  body.appendChild(actions);

  // 状态/错误行
  const status = document.createElement('div');
  status.className = 'row-status';
  status.hidden = true;
  body.appendChild(status);

  // 评分结果容器
  const result = document.createElement('div');
  result.className = 'row-result';
  result.hidden = true;
  body.appendChild(result);

  row.appendChild(body);

  // ---- 行内交互 ----
  wireRow({ sentence, row, playBtn, recordBtn, playbackBtn, scoreBtn, status, result });

  return row;
}

function setStatus(statusEl, message, kind = 'info') {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function wireRow({ sentence, row, playBtn, recordBtn, playbackBtn, scoreBtn, status, result }) {
  // 朗读
  playBtn.addEventListener('click', async () => {
    const locale = LOCALES[sentence.lang];
    playBtn.disabled = true;
    setStatus(status, 'Synthesizing speech…', 'info');
    try {
      if (hasCredentials()) {
        const blob = await synthesizeAzure(sentence.text, locale);
        ttsAudio.src = URL.createObjectURL(blob);
        await ttsAudio.play();
        setStatus(status, '', 'info');
      } else {
        await speakWithBrowser(sentence.text, locale);
        setStatus(status, "(Using the browser's built-in voice — add an Azure key for more natural speech.)", 'info');
      }
    } catch (err) {
      setStatus(status, 'Speak failed: ' + err.message, 'error');
    } finally {
      playBtn.disabled = false;
    }
  });

  // 录音（切换开始/停止）
  recordBtn.addEventListener('click', async () => {
    if (sentence.recorder.isRecording) {
      recordBtn.disabled = true;
      try {
        const { url, blob } = await sentence.recorder.stop();
        sentence.recordingUrl = url;
        sentence.recordingBlob = blob;
        recordBtn.textContent = 'Record';
        row.classList.remove('is-recording');
        playbackBtn.hidden = false;
        scoreBtn.hidden = false;
        setStatus(status, 'Recording done. Click Playback to listen, or Score to assess pronunciation.', 'info');
      } catch (err) {
        setStatus(status, 'Failed to stop recording: ' + err.message, 'error');
      } finally {
        recordBtn.disabled = false;
      }
    } else {
      setStatus(status, '', 'info');
      try {
        await sentence.recorder.start();
        recordBtn.textContent = 'Stop';
        row.classList.add('is-recording');
        setStatus(status, '● Recording… click Stop to finish.', 'recording');
      } catch (err) {
        setStatus(status, 'Cannot record: ' + err.message, 'error');
      }
    }
  });

  // 回放
  playbackBtn.addEventListener('click', () => {
    if (!sentence.recordingUrl) return;
    const audio = new Audio(sentence.recordingUrl);
    audio.play().catch((err) => {
      setStatus(status, 'Playback failed: ' + err.message, 'error');
    });
  });

  // 评分
  scoreBtn.addEventListener('click', async () => {
    if (!sentence.recordingBlob) {
      setStatus(status, 'Please record before scoring.', 'error');
      return;
    }
    scoreBtn.disabled = true;
    result.hidden = true;
    setStatus(status, 'Assessing pronunciation…', 'info');
    try {
      const locale = LOCALES[sentence.lang];
      const assessment = await assessPronunciation(
        sentence.recordingBlob, sentence.text, locale);
      renderAssessment(result, assessment);
      setStatus(status, '', 'info');
    } catch (err) {
      setStatus(status, 'Scoring failed: ' + err.message, 'error');
    } finally {
      scoreBtn.disabled = false;
    }
  });
}

/** 根据准确度分数决定词的展示等级。 */
function accuracyLevel(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'mid';
  return 'bad';
}

const ERROR_LABELS = {
  None: '',
  Mispronunciation: 'mispronounced',
  Omission: 'omission',
  Insertion: 'insertion',
  UnexpectedBreak: 'unexpected break',
  MissingBreak: 'missing break',
  Monotone: 'monotone',
};

/** 渲染评分结果：总分 + 逐词着色。 */
function renderAssessment(container, a) {
  container.innerHTML = '';
  container.hidden = false;

  // 总分区
  const scores = document.createElement('div');
  scores.className = 'score-grid';
  const items = [
    ['Overall', a.overall.pron],
    ['Accuracy', a.overall.accuracy],
    ['Fluency', a.overall.fluency],
    ['Completeness', a.overall.completeness],
  ];
  for (const [label, value] of items) {
    const chip = document.createElement('div');
    chip.className = 'score-chip';
    chip.dataset.level = accuracyLevel(value);
    chip.innerHTML =
      `<span class="score-value">${Math.round(value)}</span>` +
      `<span class="score-label">${label}</span>`;
    scores.appendChild(chip);
  }
  container.appendChild(scores);

  // 逐词区
  const wordsWrap = document.createElement('div');
  wordsWrap.className = 'words-line';
  for (const w of a.words) {
    const span = document.createElement('span');
    span.className = 'word';
    span.appendChild(document.createTextNode(w.word));

    if (w.errorType === 'Omission') {
      span.dataset.error = 'omission';
      span.appendChild(buildWordTip('Omission · in the reference but not spoken', '', null));
    } else if (w.errorType === 'Insertion') {
      span.dataset.error = 'insertion';
      span.appendChild(buildWordTip('Insertion · spoken but not in the reference', '', null));
    } else {
      const level = accuracyLevel(w.accuracy);
      span.dataset.level = level;
      const errLabel = ERROR_LABELS[w.errorType] || '';
      const head =
        `${w.word} · accuracy ${Math.round(w.accuracy)}${errLabel ? ' · ' + errLabel : ''}`;
      span.appendChild(buildWordTip(head, level, w.phonemes));
    }
    wordsWrap.appendChild(span);
  }
  container.appendChild(wordsWrap);

  // 图例
  const legend = buildLegend();
  container.appendChild(legend);
}

/** 构造单词的悬停提示：标题行 + 逐音素色块。鼠标移上即时显示（纯 CSS）。 */
function buildWordTip(head, headLevel, phonemes) {
  const tip = document.createElement('span');
  tip.className = 'word-tip';

  const h = document.createElement('span');
  h.className = 'tip-head';
  if (headLevel) h.dataset.level = headLevel;
  h.textContent = head;
  tip.appendChild(h);

  if (phonemes && phonemes.length) {
    const pw = document.createElement('span');
    pw.className = 'tip-phonemes';
    for (const p of phonemes) {
      const chip = document.createElement('span');
      chip.className = 'ph';
      chip.dataset.level = accuracyLevel(p.accuracy);
      const name = document.createElement('b');
      name.textContent = p.phoneme;
      const score = document.createElement('i');
      score.textContent = Math.round(p.accuracy);
      chip.appendChild(name);
      chip.appendChild(score);
      pw.appendChild(chip);
    }
    tip.appendChild(pw);
  }
  return tip;
}

function buildLegend() {
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML =
    '<span class="legend-item"><i data-level="good"></i>Good ≥80</span>' +
    '<span class="legend-item"><i data-level="mid"></i>Fair 60–79</span>' +
    '<span class="legend-item"><i data-level="bad"></i>Poor &lt;60</span>' +
    '<span class="legend-item"><i data-error="omission"></i>Omission</span>' +
    '<span class="legend-item"><i data-error="insertion"></i>Insertion</span>' +
    '<span class="legend-hint">Hover a word for per-phoneme scores</span>';
  return legend;
}

// ---- 初始化 ----

function init() {
  initKeyPanel();

  // 全局「隐藏正文」开关：读取本地存储，变更时写回并联动所有句子。
  globalHideText = loadHideText();
  els.globalHideInput.checked = globalHideText;
  els.globalHideInput.addEventListener('change', () => {
    globalHideText = els.globalHideInput.checked;
    saveHideText(globalHideText);
    for (const s of sentences) applyHidden(s, globalHideText);
  });

  els.splitBtn.addEventListener('click', handleSplit);
  els.clearInputBtn.addEventListener('click', () => {
    els.input.value = '';
    els.input.focus();
  });
  render();
}

init();
