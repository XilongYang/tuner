// 录音：用 Web Audio API 直接采集 PCM，输出 16kHz / 16bit / 单声道 WAV。
//
// 为什么不用 MediaRecorder？
// MediaRecorder 在 Chrome 下产出 webm/opus，而 Azure 发音评估的 REST 短音频接口
// 只接受 `audio/wav (PCM 16k)` 或 `audio/ogg;opus`。为了让「同一份录音」既能回放
// 又能直接上传评分，这里统一采集裸 PCM 并封装成标准 WAV（浏览器可直接播放）。

const TARGET_RATE = 16000;

/** 将采集到的 Float32 采样重采样到 16kHz。 */
function resampleTo16k(input, inputRate) {
  if (inputRate === TARGET_RATE) return input;
  const ratio = inputRate / TARGET_RATE;
  const newLen = Math.round(input.length / ratio);
  const out = new Float32Array(newLen);

  if (ratio > 1) {
    // 下采样（如 48k/44.1k → 16k）：对每个输出样本取输入窗口的平均，
    // 兼作抗混叠低通，避免朴素抽点带来的混叠。
    for (let i = 0; i < newLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      let n = 0;
      for (let j = start; j < end; j++) { sum += input[j]; n++; }
      out[i] = n ? sum / n : 0;
    }
  } else {
    // 上采样：线性插值
    for (let i = 0; i < newLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = idx - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
  }
  return out;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * 峰值归一化：把整段录音等比放大到接近满幅，解决原始麦克风音量过小的问题。
 * 因为是录完后对整段做统一缩放，不像 autoGainControl 那样动态调整，故不会产生泵感/断音。
 * maxGain 上限避免把近乎静音的底噪放大到爆。
 */
function normalize(samples, targetPeak = 0.95, maxGain = 30) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0) return samples;
  const gain = Math.min(targetPeak / peak, maxGain);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return samples;
}

/** 将 Float32 PCM 编码为 16kHz/16bit/单声道 WAV，返回 ArrayBuffer。 */
function encodeWav(float32, inputRate) {
  const pcm = normalize(resampleTo16k(float32, inputRate));
  const numSamples = pcm.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk 大小
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // 单声道
  view.setUint32(24, TARGET_RATE, true); // 采样率
  view.setUint32(28, TARGET_RATE * 2, true); // 字节率 = 采样率 × 声道 × 每样本字节
  view.setUint16(32, 2, true);           // 块对齐
  view.setUint16(34, 16, true);          // 位深
  writeString(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** 合并多个 Float32Array 分块。 */
function flatten(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class Recorder {
  constructor() {
    this._audioContext = null;
    this._stream = null;
    this._source = null;
    this._workletNode = null;
    this._scriptNode = null;   // 仅在不支持 AudioWorklet 时使用
    this._silentGain = null;
    this._chunks = [];
    this._recording = false;
    this._sampleRate = TARGET_RATE;
    this._objectUrl = null;
  }

  get isRecording() {
    return this._recording;
  }

  /** 开始录音。若浏览器不支持或用户拒绝授权会抛错。 */
  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support recording (getUserMedia unavailable)');
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('This browser does not support the Web Audio API');
    }

    try {
      // 使用浏览器自带的音频增强（回声消除 / 降噪 / 自动增益）。
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        throw new Error('Microphone permission denied. Please allow microphone access in your browser.');
      }
      throw new Error('Cannot access microphone: ' + (err && err.message ? err.message : err));
    }

    // 使用设备原生采样率创建 AudioContext。
    // 不再强制 16kHz：强制非原生采样率会触发音频设备重配置，导致麦克风采集
    // 中途中断（录音图标闪断）与断音。原生采样率采集，录完在 encodeWav 里统一
    // 重采样到 16kHz（Azure REST 所需格式）。
    this._audioContext = new AudioCtx();
    // 自动播放策略可能让 context 处于 suspended，需显式恢复。
    if (this._audioContext.state === 'suspended') {
      try { await this._audioContext.resume(); } catch { /* 忽略 */ }
    }
    this._sampleRate = this._audioContext.sampleRate;
    this._source = this._audioContext.createMediaStreamSource(this._stream);
    this._chunks = [];

    if (this._audioContext.audioWorklet) {
      await this._startWithWorklet();
    } else {
      this._startWithScriptProcessor();
    }

    this._recording = true;
  }

  /** 首选：AudioWorklet 采集，音频线程处理，不丢帧。 */
  async _startWithWorklet() {
    const workletUrl = new URL('./recorder-worklet.js', import.meta.url);
    await this._audioContext.audioWorklet.addModule(workletUrl);

    this._workletNode = new AudioWorkletNode(this._audioContext, 'recorder-processor');
    this._workletNode.port.onmessage = (e) => {
      // e.data 是一块 Float32Array 采样
      if (this._recording && e.data && e.data.length) {
        this._chunks.push(e.data);
      }
    };

    // worklet 默认输出静音（我们不写 outputs），接到 destination 以保证图被持续拉取。
    this._source.connect(this._workletNode);
    this._workletNode.connect(this._audioContext.destination);
  }

  /** 兜底：老浏览器无 AudioWorklet 时用 ScriptProcessor（可能在主线程繁忙时丢帧）。 */
  _startWithScriptProcessor() {
    this._scriptNode = this._audioContext.createScriptProcessor(4096, 1, 1);
    this._scriptNode.addEventListener('audioprocess', (e) => {
      if (!this._recording) return;
      this._chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    });
    this._silentGain = this._audioContext.createGain();
    this._silentGain.gain.value = 0;
    this._source.connect(this._scriptNode);
    this._scriptNode.connect(this._silentGain);
    this._silentGain.connect(this._audioContext.destination);
  }

  /**
   * 停止录音，返回 { blob, url }（WAV 格式，可回放也可上传评分）。
   * @returns {Promise<{ blob: Blob, url: string }>}
   */
  async stop() {
    if (!this._recording) throw new Error('Recording has not started');
    this._recording = false;

    if (this._source) this._source.disconnect();
    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      this._workletNode.disconnect();
    }
    if (this._scriptNode) this._scriptNode.disconnect();
    if (this._silentGain) this._silentGain.disconnect();

    const pcm = flatten(this._chunks);
    const wavBuffer = encodeWav(pcm, this._sampleRate);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });

    this._releaseStream();
    if (this._audioContext) {
      try { await this._audioContext.close(); } catch { /* 忽略 */ }
      this._audioContext = null;
    }

    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = URL.createObjectURL(blob);
    return { blob, url: this._objectUrl };
  }

  _releaseStream() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
  }

  /** 释放全部资源。 */
  dispose() {
    this._recording = false;
    this._releaseStream();
    if (this._audioContext) {
      try { this._audioContext.close(); } catch { /* 忽略 */ }
      this._audioContext = null;
    }
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    this._source = null;
    this._workletNode = null;
    this._scriptNode = null;
    this._silentGain = null;
    this._chunks = [];
  }
}
