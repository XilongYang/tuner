// AudioWorklet recording processor: runs on a dedicated audio thread, immune to
// main-thread jank, which fundamentally avoids the dropouts caused by
// ScriptProcessorNode dropping frames when the main thread is busy.
//
// Each process() call gets one input block (typically 128 samples), copies it,
// and posts it back to the main thread for collection.

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    // Skip when there is no input channel (e.g. the stream isn't ready yet).
    if (input && input[0]) {
      // The underlying buffer is reused, so a copy must be made before sending.
      this.port.postMessage(input[0].slice(0));
    }
    // Return true to keep the processor alive.
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
