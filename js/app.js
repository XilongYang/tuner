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
} from './config.js';

// ---- 全局状态 ----

/** @type {Array<{ id: number, text: string, lang: 'ja'|'en', recorder: Recorder, recordingUrl: string|null, recordingBlob: Blob|null }>} */
let sentences = [];
let nextId = 1;

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
};

// ---- 凭据面板 ----

function refreshKeyStatus() {
  const creds = loadCredentials();
  if (creds) {
    els.keyStatus.textContent = `已保存：Region = ${creds.region}（Key 已隐藏）`;
    els.keyStatus.dataset.state = 'ok';
  } else {
    els.keyStatus.textContent = '未配置：将使用浏览器内置语音（降级方案）';
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
      alert('请同时填写 Key 和 Region');
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

  refreshKeyStatus();
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
    recorder: new Recorder(),
    recordingUrl: null,
    recordingBlob: null,
  }));

  render();
}

function render() {
  els.list.innerHTML = '';
  els.count.textContent = sentences.length
    ? `${sentences.length} 句`
    : '';

  if (sentences.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = '粘贴文本后点击「拆分」，句子会在这里逐条显示。';
    els.list.appendChild(empty);
    return;
  }

  sentences.forEach((sentence, index) => {
    els.list.appendChild(renderRow(sentence, index));
  });
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

  const textEl = document.createElement('div');
  textEl.className = 'row-text';
  textEl.textContent = sentence.text;
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
    langToggle.title = '点击切换语言（ja / en）';
  };
  paintLang();
  langToggle.addEventListener('click', () => {
    sentence.lang = sentence.lang === 'ja' ? 'en' : 'ja';
    paintLang();
  });
  actions.appendChild(langToggle);

  // 朗读
  const playBtn = document.createElement('button');
  playBtn.className = 'btn';
  playBtn.type = 'button';
  playBtn.textContent = '朗读';
  actions.appendChild(playBtn);

  // 录音
  const recordBtn = document.createElement('button');
  recordBtn.className = 'btn';
  recordBtn.type = 'button';
  recordBtn.textContent = '录音';
  actions.appendChild(recordBtn);

  // 回放
  const playbackBtn = document.createElement('button');
  playbackBtn.className = 'btn';
  playbackBtn.type = 'button';
  playbackBtn.textContent = '回放';
  playbackBtn.hidden = !sentence.recordingUrl;
  actions.appendChild(playbackBtn);

  // 评分
  const scoreBtn = document.createElement('button');
  scoreBtn.className = 'btn';
  scoreBtn.type = 'button';
  scoreBtn.textContent = '评分';
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
    setStatus(status, '正在合成语音…', 'info');
    try {
      if (hasCredentials()) {
        const blob = await synthesizeAzure(sentence.text, locale);
        ttsAudio.src = URL.createObjectURL(blob);
        await ttsAudio.play();
        setStatus(status, '', 'info');
      } else {
        await speakWithBrowser(sentence.text, locale);
        setStatus(status, '（使用浏览器内置语音，配置 Azure Key 可获得更自然的发音）', 'info');
      }
    } catch (err) {
      setStatus(status, '朗读失败：' + err.message, 'error');
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
        recordBtn.textContent = '录音';
        row.classList.remove('is-recording');
        playbackBtn.hidden = false;
        scoreBtn.hidden = false;
        setStatus(status, '录音完成，可点击「回放」试听，或点「评分」评估发音。', 'info');
      } catch (err) {
        setStatus(status, '停止录音失败：' + err.message, 'error');
      } finally {
        recordBtn.disabled = false;
      }
    } else {
      setStatus(status, '', 'info');
      try {
        await sentence.recorder.start();
        recordBtn.textContent = '停止';
        row.classList.add('is-recording');
        setStatus(status, '● 录音中…再次点击「停止」结束。', 'recording');
      } catch (err) {
        setStatus(status, '无法录音：' + err.message, 'error');
      }
    }
  });

  // 回放
  playbackBtn.addEventListener('click', () => {
    if (!sentence.recordingUrl) return;
    const audio = new Audio(sentence.recordingUrl);
    audio.play().catch((err) => {
      setStatus(status, '回放失败：' + err.message, 'error');
    });
  });

  // 评分
  scoreBtn.addEventListener('click', async () => {
    if (!sentence.recordingBlob) {
      setStatus(status, '请先录音再评分。', 'error');
      return;
    }
    scoreBtn.disabled = true;
    result.hidden = true;
    setStatus(status, '正在评估发音…', 'info');
    try {
      const locale = LOCALES[sentence.lang];
      const assessment = await assessPronunciation(
        sentence.recordingBlob, sentence.text, locale);
      renderAssessment(result, assessment);
      setStatus(status, '', 'info');
    } catch (err) {
      setStatus(status, '评分失败：' + err.message, 'error');
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
  Mispronunciation: '发音不准',
  Omission: '漏读',
  Insertion: '多读',
  UnexpectedBreak: '不当停顿',
  MissingBreak: '缺少停顿',
  Monotone: '语调平淡',
};

/** 渲染评分结果：总分 + 逐词着色。 */
function renderAssessment(container, a) {
  container.innerHTML = '';
  container.hidden = false;

  // 总分区
  const scores = document.createElement('div');
  scores.className = 'score-grid';
  const items = [
    ['综合', a.overall.pron],
    ['准确度', a.overall.accuracy],
    ['流利度', a.overall.fluency],
    ['完整度', a.overall.completeness],
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
      span.appendChild(buildWordTip('漏读 · 参考文本中有，但没读出来', '', null));
    } else if (w.errorType === 'Insertion') {
      span.dataset.error = 'insertion';
      span.appendChild(buildWordTip('多读 · 读了参考文本以外的内容', '', null));
    } else {
      const level = accuracyLevel(w.accuracy);
      span.dataset.level = level;
      const errLabel = ERROR_LABELS[w.errorType] || '';
      const head =
        `${w.word} · 准确度 ${Math.round(w.accuracy)}${errLabel ? ' · ' + errLabel : ''}`;
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
    '<span class="legend-item"><i data-level="good"></i>良好 ≥80</span>' +
    '<span class="legend-item"><i data-level="mid"></i>一般 60–79</span>' +
    '<span class="legend-item"><i data-level="bad"></i>较差 &lt;60</span>' +
    '<span class="legend-item"><i data-error="omission"></i>漏读</span>' +
    '<span class="legend-item"><i data-error="insertion"></i>多读</span>' +
    '<span class="legend-hint">悬停单词可看逐音素分数</span>';
  return legend;
}

// ---- 初始化 ----

function init() {
  initKeyPanel();
  els.splitBtn.addEventListener('click', handleSplit);
  els.clearInputBtn.addEventListener('click', () => {
    els.input.value = '';
    els.input.focus();
  });
  render();
}

init();
