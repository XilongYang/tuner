// 主应用逻辑：把各模块串起来，管理句子列表与界面交互。

import { segment } from './segment.js';
import { detectLang, LOCALES } from './lang.js';
import { synthesizeAzure, speakWithBrowser } from './tts.js';
import { Recorder } from './recorder.js';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  hasCredentials,
} from './config.js';

// ---- 全局状态 ----

/** @type {Array<{ id: number, text: string, lang: 'ja'|'en', recorder: Recorder, recordingUrl: string|null }>} */
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

  body.appendChild(actions);

  // 状态/错误行
  const status = document.createElement('div');
  status.className = 'row-status';
  status.hidden = true;
  body.appendChild(status);

  row.appendChild(body);

  // ---- 行内交互 ----
  wireRow({ sentence, row, playBtn, recordBtn, playbackBtn, status });

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

function wireRow({ sentence, row, playBtn, recordBtn, playbackBtn, status }) {
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
        const { url } = await sentence.recorder.stop();
        sentence.recordingUrl = url;
        recordBtn.textContent = '录音';
        row.classList.remove('is-recording');
        playbackBtn.hidden = false;
        setStatus(status, '录音完成，可点击「回放」试听。', 'info');
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
