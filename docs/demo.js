import { registerDshPianoView } from '../dist/demo.js';

registerDshPianoView();

const score = {
  id: 'demo-arpeggio',
  title: 'Demo arpeggio',
  ppq: 960,
  tempoMap: [{ tick: 0n, bpm: 112 }],
  timeSignatureMap: [{ tick: 0n, numerator: 4, denominator: 4 }],
  tracks: [{
    id: 'piano',
    instrument: { id: 'grand' },
    voices: [{
      id: 'right',
      events: [
        { id: 'c4', type: 'note', midi: 60, startTick: 0n, durationTicks: 840n, velocity: 0.52, voiceId: 'right', trackId: 'piano' },
        { id: 'e4', type: 'note', midi: 64, startTick: 480n, durationTicks: 840n, velocity: 0.64, voiceId: 'right', trackId: 'piano' },
        { id: 'g4', type: 'note', midi: 67, startTick: 960n, durationTicks: 840n, velocity: 0.76, voiceId: 'right', trackId: 'piano' },
        { id: 'c5', type: 'note', midi: 72, startTick: 1440n, durationTicks: 1_440n, velocity: 0.88, voiceId: 'right', trackId: 'piano' },
        { id: 'g4b', type: 'note', midi: 67, startTick: 2_400n, durationTicks: 840n, velocity: 0.68, voiceId: 'right', trackId: 'piano' },
        { id: 'e4b', type: 'note', midi: 64, startTick: 2_880n, durationTicks: 840n, velocity: 0.6, voiceId: 'right', trackId: 'piano' },
        { id: 'c4b', type: 'note', midi: 60, startTick: 3_360n, durationTicks: 1_440n, velocity: 0.5, voiceId: 'right', trackId: 'piano' },
        { id: 'pedal', type: 'pedal', startTick: 0n, endTick: 4_800n, value: 1, voiceId: 'right', trackId: 'piano' },
      ],
    }],
  }],
};

const piano = document.querySelector('#piano');
const status = document.querySelector('#status');
const seek = document.querySelector('#seek');
const time = document.querySelector('#time');
const pedal = document.querySelector('#pedal');
const mute = document.querySelector('#mute');

piano.setScore(score);
seek.max = String(piano.duration);

const formatTime = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(3).padStart(6, '0')}`;
};

const reportError = (error) => {
  status.textContent = error instanceof Error ? error.message : String(error);
};

document.querySelector('#play').addEventListener('click', async () => {
  try {
    await piano.play();
    status.textContent = '';
  } catch (error) {
    reportError(error);
  }
});

document.querySelector('#pause').addEventListener('click', () => piano.pause());
document.querySelector('#stop').addEventListener('click', () => piano.stop());
document.querySelector('#fullscreen').addEventListener('click', async () => {
  try {
    await piano.toggleFullscreen();
  } catch (error) {
    reportError(error);
  }
});
document.querySelector('#rate').addEventListener('change', (event) => piano.setRate(Number(event.currentTarget.value)));
document.querySelector('#volume').addEventListener('input', (event) => piano.setVolume(Number(event.currentTarget.value)));
seek.addEventListener('input', (event) => piano.seek(Number(event.currentTarget.value)));
mute.addEventListener('click', () => {
  const next = !piano.isMuted;
  piano.setMuted(next);
  mute.textContent = next ? 'Unmute' : 'Mute';
  mute.setAttribute('aria-pressed', String(next));
});
piano.addEventListener('pianist-audio-error', (event) => reportError(event.detail.code));

const refresh = () => {
  const current = piano.currentTime;
  seek.value = String(current);
  time.textContent = `${formatTime(current)} / ${formatTime(piano.duration)}`;
  pedal.textContent = piano.pedal > 0 ? `${Math.round(piano.pedal * 100)}%` : 'Up';
  requestAnimationFrame(refresh);
};

refresh();
