let context = null;
let nextPlayTime = 0;
let activeBroadcastId = "";
let liveCodec = "mulaw";
let liveSampleRate = 8000;
let recordingAudio = null;
let recordingRequest = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") return;
  if (message.type === "AUDIO_START") startLive(message);
  if (message.type === "AUDIO_FRAMES") playFrameBatch(message.frames || []);
  if (message.type === "AUDIO_END") endLive(message.broadcastId);
  if (message.type === "PLAY_RECORDING") playRecording(message);
  if (message.type === "STOP_AUDIO") stopAll();
});

function audioContext() {
  if (!context || context.state === "closed") context = new AudioContext();
  if (context.state === "suspended") context.resume();
  return context;
}

function startLive({ broadcastId, codec, sampleRate }) {
  stopRecording();
  activeBroadcastId = String(broadcastId || "");
  liveCodec = ["pcm_s16le_48k_stereo", "s16le48", "pcm"].includes(codec) ? "pcm" : "mulaw";
  liveSampleRate = Number(sampleRate) || (liveCodec === "pcm" ? 48000 : 8000);
  const ctx = audioContext();
  nextPlayTime = Math.max(nextPlayTime, ctx.currentTime + 0.12);
}

function playFrameBatch(frames) {
  const ctx = audioContext();
  for (const frame of frames) {
    if (!activeBroadcastId || frame.broadcastId !== activeBroadcastId) continue;
    const input = frame.bytes || [];
    if (!input.length) continue;
    const pcm = liveCodec === "pcm";
    const channels = pcm ? 2 : 1;
    const samples = pcm ? Math.floor(input.length / 4) : input.length;
    if (!samples || nextPlayTime - ctx.currentTime > 0.75) continue;
    const buffer = ctx.createBuffer(channels, samples, liveSampleRate);
    if (pcm) {
      const view = new DataView(Uint8Array.from(input).buffer);
      for (let channel = 0; channel < channels; channel++) {
        const output = buffer.getChannelData(channel);
        for (let i = 0; i < samples; i++) output[i] = view.getInt16(i * 4 + channel * 2, true) / 32768;
      }
    } else {
      const output = buffer.getChannelData(0);
      for (let i = 0; i < samples; i++) output[i] = decodeMuLaw(input[i]) / 32768;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const start = nextPlayTime <= ctx.currentTime ? ctx.currentTime + 0.12 : nextPlayTime;
    source.start(start);
    nextPlayTime = start + buffer.duration;
  }
}

function decodeMuLaw(value) {
  const ulaw = (~value) & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  const sample = ((mantissa << 3) + 0x84) << exponent;
  return sign ? 0x84 - sample : sample - 0x84;
}

function playbackEnded(broadcastId) {
  chrome.runtime.sendMessage({ type: "PLAYBACK_ENDED", broadcastId }).catch(() => {});
}

function endLive(id) {
  if (id !== activeBroadcastId) return;
  activeBroadcastId = "";
  const delay = context ? Math.max(0, (nextPlayTime - context.currentTime) * 1000) : 0;
  setTimeout(() => playbackEnded(id), delay);
}

async function playRecording({ origin, token, broadcastId }) {
  stopAll();
  const controller = new AbortController();
  recordingRequest = controller;
  let playing = false;
  try {
    const response = await fetch(`${origin}/desktop/broadcasts/${encodeURIComponent(broadcastId)}/audio`, {
      headers: { "x-ops-desktop-client": "1", Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
    });
    if (!response.ok) return;
    const blob = await response.blob();
    if (recordingRequest !== controller) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    recordingAudio = { audio, url };
    const finished = () => {
      if (recordingAudio?.audio !== audio) return;
      stopRecording();
      playbackEnded(broadcastId);
    };
    audio.onended = finished;
    audio.onerror = finished;
    await audio.play();
    playing = true;
  } catch (_) {
  } finally {
    if (!playing && recordingRequest === controller) {
      stopRecording();
      playbackEnded(broadcastId);
    }
  }
}

function stopRecording() {
  recordingRequest?.abort();
  recordingRequest = null;
  if (recordingAudio) {
    const { audio, url } = recordingAudio;
    recordingAudio = null;
    audio.pause();
    URL.revokeObjectURL(url);
  }
}

function stopAll() {
  activeBroadcastId = "";
  nextPlayTime = 0;
  stopRecording();
  if (context) {
    context.close();
    context = null;
  }
}

chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" });
