// The capture processor, running on the audio thread.
//
// Each call receives one block (128 samples), copies it, and posts it to the
// main thread. The copy is required: the input buffer is reused between calls,
// so a posted view would be overwritten before it was read.
//
// This file is loaded as an AudioWorklet module, not imported: it runs in a
// separate global scope where `AudioWorkletProcessor` and `registerProcessor`
// exist and ordinary module imports do not.

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) this.port.postMessage(channel.slice(0));
    // Staying alive: returning false would let the node be collected mid-take.
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
