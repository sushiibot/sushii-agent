// Downsample microphone audio to mono PCM16 in 20 ms packets, off the main thread.
class VoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.rate = options.processorOptions.rate;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.packet = new Int16Array(Math.round(this.rate / 50));
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) {
      this.sum += value;
      this.count++;
      this.phase += this.rate / sampleRate;
      if (this.phase < 1) continue;
      this.phase -= 1;
      const sample = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.packet[this.offset++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      if (this.offset === this.packet.length) {
        this.port.postMessage(this.packet.buffer, [this.packet.buffer]);
        this.packet = new Int16Array(Math.round(this.rate / 50));
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
