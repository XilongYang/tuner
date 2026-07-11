// AudioWorklet 录音处理器：运行在专用音频线程，不受主线程卡顿影响，
// 从根本上避免 ScriptProcessorNode 在主线程繁忙时丢帧导致的断音。
//
// 每次 process 拿到一块输入（通常 128 采样），复制后通过 port 发回主线程收集。

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    // 无输入通道时（如流尚未就绪）跳过。
    if (input && input[0]) {
      // 底层缓冲会被复用，必须复制一份再发送。
      this.port.postMessage(input[0].slice(0));
    }
    // 返回 true 保持处理器存活。
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
