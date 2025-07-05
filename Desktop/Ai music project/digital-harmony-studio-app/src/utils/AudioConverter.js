// src/utils/AudioConverter.js
// Audio conversion and processing utilities using FFmpeg.wasm
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';

const ffmpeg = createFFmpeg({ log: true });

// Mastering presets as FFmpeg filter strings
const MASTERING_PRESETS = {
  none: '',
  pop: 'equalizer=f=1000:t=q:w=1:g=3,acompressor=threshold=-20dB:ratio=4:attack=5:release=50,alimiter=limit=0.9',
  hiphop: 'equalizer=f=80:t=q:w=2:g=4,acompressor=threshold=-18dB:ratio=3:attack=10:release=100,alimiter=limit=0.9',
  acoustic: 'equalizer=f=5000:t=q:w=2:g=2,acompressor=threshold=-22dB:ratio=2:attack=20:release=200,alimiter=limit=0.9',
};

export async function convertAudio(file, sampleRate = '44100', masterPreset = 'none', lufs = null) {
  if (!ffmpeg.isLoaded()) {
    await ffmpeg.load();
  }
  const inputName = file.name;
  const outputName = inputName.replace(/\.[^/.]+$/, '') + `_${sampleRate}.wav`;
  ffmpeg.FS('writeFile', inputName, await fetchFile(file));

  // Build filter chain
  let filters = [];
  if (MASTERING_PRESETS[masterPreset]) filters.push(MASTERING_PRESETS[masterPreset]);
  if (lufs !== null) filters.push(`loudnorm=I=${lufs}:TP=-1.5:LRA=11`); // LUFS normalization
  const filterStr = filters.length ? ['-af', filters.join(',')] : [];

  await ffmpeg.run(
    '-i', inputName,
    '-ar', sampleRate,
    '-ac', '2',
    '-sample_fmt', 's16',
    ...filterStr,
    outputName
  );
  const data = ffmpeg.FS('readFile', outputName);
  const wavBlob = new Blob([data.buffer], { type: 'audio/wav' });
  // Clean up
  ffmpeg.FS('unlink', inputName);
  ffmpeg.FS('unlink', outputName);
  return wavBlob;
}

// TODO: Add metadata extraction, batch processing, advanced analysis, etc.
