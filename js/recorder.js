// 录音：用 Web Audio API 直接采集 PCM，输出 16kHz / 16bit / 单声道 WAV。
//
// 为什么不用 MediaRecorder？
// MediaRecorder 在 Chrome 下产出 webm/opus，而 Azure 发音评估的 REST 短音频接口
// 只接受 `audio/wav (PCM 16k)` 或 `audio/ogg;opus`。为了让「同一份录音」既能回放
// 又能直接上传评分，这里统一采集裸 PCM 并封装成标准 WAV（浏览器可直接播放）。

const TARGET_RATE = 16000;

/** 将采集到的 Float32 采样按线性插值重采样到 16kHz。 */
function resampleTo16k(input, inputRate) {
  if (inputRate === TARGET_RATE) return input;
  const ratio = inputRate / TARGET_RATE;
  const newLen = Math.round(input.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** 将 Float32 PCM 编码为 16kHz/16bit/单声道 WAV，返回 ArrayBuffer。 */
function encodeWav(float32, inputRate) {
  const pcm = resampleTo16k(float32, inputRate);
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
      throw new Error('当前浏览器不支持录音（getUserMedia 不可用）');
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('当前浏览器不支持 Web Audio API');
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        throw new Error('麦克风权限被拒绝，请在浏览器中允许麦克风访问');
      }
      throw new Error('无法访问麦克风：' + (err && err.message ? err.message : err));
    }

    // 优先请求 16kHz；若浏览器（如部分 Safari）忽略该参数，用实际采样率并在编码时重采样。
    this._audioContext = new AudioCtx({ sampleRate: TARGET_RATE });
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
    if (!this._recording) throw new Error('尚未开始录音');
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
