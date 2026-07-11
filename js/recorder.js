// 录音：封装浏览器原生 MediaRecorder。
// 每个句子对应一个 Recorder 实例；录音结果以 Blob + object URL 形式保存在内存中，
// 刷新页面即丢失（当前阶段可接受）。

/** 选择浏览器支持的音频 MIME 类型。 */
function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

export class Recorder {
  constructor() {
    this._mediaRecorder = null;
    this._stream = null;
    this._chunks = [];
    this._objectUrl = null;
  }

  get isRecording() {
    return this._mediaRecorder && this._mediaRecorder.state === 'recording';
  }

  /**
   * 开始录音。若浏览器不支持或用户拒绝授权会抛错。
   */
  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前浏览器不支持录音（getUserMedia 不可用）');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('当前浏览器不支持 MediaRecorder');
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        throw new Error('麦克风权限被拒绝，请在浏览器中允许麦克风访问');
      }
      throw new Error('无法访问麦克风：' + (err && err.message ? err.message : err));
    }

    const mimeType = pickMimeType();
    this._chunks = [];
    this._mediaRecorder = mimeType
      ? new MediaRecorder(this._stream, { mimeType })
      : new MediaRecorder(this._stream);

    this._mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    });

    this._mediaRecorder.start();
  }

  /**
   * 停止录音，返回 { blob, url }。
   * @returns {Promise<{ blob: Blob, url: string }>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this._mediaRecorder) {
        reject(new Error('尚未开始录音'));
        return;
      }
      this._mediaRecorder.addEventListener('stop', () => {
        const type = this._mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(this._chunks, { type });
        this._releaseStream();

        // 释放上一次的 URL，避免内存泄漏
        if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = URL.createObjectURL(blob);
        resolve({ blob, url: this._objectUrl });
      }, { once: true });

      this._mediaRecorder.stop();
    });
  }

  _releaseStream() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
  }

  /** 释放全部资源。 */
  dispose() {
    this._releaseStream();
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    this._mediaRecorder = null;
    this._chunks = [];
  }
}
