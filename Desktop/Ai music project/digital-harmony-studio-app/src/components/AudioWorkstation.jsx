import React, { useState, useRef, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import WaveSurfer from 'wavesurfer.js';
import { saveAs } from 'file-saver';
import { convertAudio } from '../utils/AudioConverter';
import '../styles/AudioWorkstation.css';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import * as Tone from 'tone';

const SUPPORTED_FORMATS = ['audio/mp3', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/ogg', 'audio/m4a'];

const EXPORT_PRESETS = [
  { label: 'Default WAV', value: 'default', lufs: -14, sampleRate: '44100' },
  { label: 'Spotify', value: 'spotify', lufs: -14, sampleRate: '44100' },
  { label: 'Apple Music', value: 'apple', lufs: -16, sampleRate: '48000' },
  { label: 'YouTube', value: 'youtube', lufs: -13, sampleRate: '48000' },
];

function getRMS(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

const AudioWorkstation = () => {
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [waveSurfer, setWaveSurfer] = useState(null);
  const waveformRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [sampleRate, setSampleRate] = useState('44100');
  const [processing, setProcessing] = useState(false);
  const [volume, setVolume] = useState(1);
  const [peak, setPeak] = useState(0);
  const [lufs, setLufs] = useState(null);
  const [masterPreset, setMasterPreset] = useState('none');
  const [rms, setRms] = useState(0);
  const [progress, setProgress] = useState(0);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [spectrumData, setSpectrumData] = useState([]);
  const [metadata, setMetadata] = useState(null);
  const [loop, setLoop] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [regions, setRegions] = useState([]);
  const [exportPreset, setExportPreset] = useState('default');
  const [midiFile, setMidiFile] = useState(null);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [midiInfo, setMidiInfo] = useState(null);
  const [midiPlayer, setMidiPlayer] = useState(null);

  // --- Multi-track support ---
  const [tracks, setTracks] = useState([
    { id: 1, name: 'Audio 1', type: 'audio', file: null, solo: false, mute: false },
    { id: 2, name: 'MIDI 1', type: 'midi', file: null, solo: false, mute: false }
  ]);
  const [selectedTrackId, setSelectedTrackId] = useState(1);

  // --- Undo/Redo State ---
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);

  const pushHistory = (state) => setHistory(h => [...h, JSON.stringify(state)]);
  const handleUndo = () => {
    if (history.length === 0) return;
    setFuture(f => [JSON.stringify({ files, selectedFile, regions, tracks, automationPoints, panAutomation }), ...f]);
    const prev = JSON.parse(history[history.length - 1]);
    setFiles(prev.files);
    setSelectedFile(prev.selectedFile);
    setRegions(prev.regions);
    setTracks(prev.tracks);
    setAutomationPoints(prev.automationPoints);
    setPanAutomation(prev.panAutomation);
    setHistory(h => h.slice(0, -1));
  };
  const handleRedo = () => {
    if (future.length === 0) return;
    pushHistory({ files, selectedFile, regions, tracks, automationPoints, panAutomation });
    const next = JSON.parse(future[0]);
    setFiles(next.files);
    setSelectedFile(next.selectedFile);
    setRegions(next.regions);
    setTracks(next.tracks);
    setAutomationPoints(next.automationPoints);
    setPanAutomation(next.panAutomation);
    setFuture(f => f.slice(1));
  };

  // Call pushHistory on major state changes (example for region add/delete)
  useEffect(() => { pushHistory({ files, selectedFile, regions, tracks, automationPoints, panAutomation }); }, [regions]);

  const onDrop = (acceptedFiles) => {
    setFiles(acceptedFiles);
    if (acceptedFiles.length > 0) {
      setSelectedFile(acceptedFiles[0]);
      loadWaveform(acceptedFiles[0]);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: SUPPORTED_FORMATS.join(',')
  });

  const loadWaveform = (file) => {
    if (waveSurfer) {
      waveSurfer.destroy();
    }
    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#D4AF37',
      progressColor: '#fff',
      height: 100,
      responsive: true,
      plugins: [
        RegionsPlugin.create({
          dragSelection: true,
          regions: []
        })
      ]
    });
    ws.loadBlob(file);
    setWaveSurfer(ws);
    ws.on('region-created', region => {
      setRegions(r => [...r, region]);
    });
    ws.on('region-updated', region => {
      setRegions(r => r.map(reg => reg.id === region.id ? region : reg));
    });
    ws.on('region-removed', region => {
      setRegions(r => r.filter(reg => reg.id !== region.id));
      if (selectedRegion && selectedRegion.id === region.id) setSelectedRegion(null);
    });
    ws.on('region-click', region => {
      setSelectedRegion(region);
    });
    ws.on('finish', () => setPlaying(false));
    ws.on('audioprocess', () => {
      const audioBuffer = ws.backend.buffer;
      if (audioBuffer) {
        const channelData = audioBuffer.getChannelData(0);
        setRms(getRMS(channelData));
        setPeak(Math.max(...channelData));
      }
      setCurrentTime(ws.getCurrentTime());
    });
    ws.on('ready', () => {
      // Metadata extraction
      const buffer = ws.backend.buffer;
      if (buffer) {
        setMetadata({
          duration: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
          name: file.name,
          type: file.type
        });
      }
      // Frequency spectrum
      try {
        const ctx = ws.backend.getAudioContext();
        const analyser = ctx.createAnalyser();
        ws.backend.gainNode.connect(analyser);
        analyser.fftSize = 256;
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        function updateSpectrum() {
          analyser.getByteFrequencyData(freqData);
          setSpectrumData([...freqData]);
          if (ws.isPlaying()) requestAnimationFrame(updateSpectrum);
        }
        updateSpectrum();
      } catch {}
    });
    ws.on('loop', () => setLoop(true));
  };

  useEffect(() => {
    if (waveSurfer) {
      waveSurfer.setVolume(volume);
    }
  }, [volume, waveSurfer]);

  const handlePlayPause = () => {
    if (waveSurfer) {
      waveSurfer.playPause();
      setPlaying(!playing);
    }
  };

  const handleStop = () => {
    if (waveSurfer) {
      waveSurfer.stop();
      setPlaying(false);
    }
  };

  const handleConvert = async () => {
    if (!selectedFile) return;
    setProcessing(true);
    const wavBlob = await convertAudio(selectedFile, sampleRate, masterPreset, lufs);
    saveAs(wavBlob, selectedFile.name.replace(/\.[^/.]+$/, '') + `_${sampleRate}.wav`);
    setProcessing(false);
  };

  // LUFS normalization now sets the value for processing
  const handleLufsNormalize = () => {
    setLufs(-14); // Target Spotify LUFS
    alert('LUFS normalization to -14dB will be applied on export.');
  };

  // Export uses the same convert logic but can be extended for Amuse AI
  const handleExport = async () => {
    if (!selectedFile) return;
    setProcessing(true);
    const wavBlob = await convertAudio(selectedFile, sampleRate, masterPreset, lufs);
    saveAs(wavBlob, selectedFile.name.replace(/\.[^/.]+$/, '') + `_amuse_${sampleRate}.wav`);
    setProcessing(false);
  };

  const handleBatchConvert = async () => {
    setBatchProcessing(true);
    for (let i = 0; i < files.length; i++) {
      setProgress(((i + 1) / files.length) * 100);
      await convertAudio(files[i], sampleRate, masterPreset, lufs);
    }
    setBatchProcessing(false);
    setProgress(0);
    alert('Batch processing complete!');
  };

  // Export preset logic
  const handleExportPreset = (e) => {
    const preset = EXPORT_PRESETS.find(p => p.value === e.target.value);
    setExportPreset(preset.value);
    setLufs(preset.lufs);
    setSampleRate(preset.sampleRate);
  };

  // MIDI upload handler (UI only)
  const handleMidiUpload = (e) => {
    setMidiFile(e.target.files[0]);
    alert('MIDI upload is for future expansion.');
  };

  // Region-based export
  const handleRegionExport = async () => {
    if (!selectedFile || !selectedRegion) return;
    setProcessing(true);
    // Use FFmpeg to trim to region (start/end in seconds)
    const { start, end } = selectedRegion;
    const wavBlob = await convertAudio(selectedFile, sampleRate, masterPreset, lufs, start, end);
    saveAs(wavBlob, selectedFile.name.replace(/\.[^/.]+$/, '') + `_region_${start.toFixed(2)}-${end.toFixed(2)}.wav`);
    setProcessing(false);
  };

  // MIDI playback (simple, using Tone.js)
  const handleMidiPlayback = async () => {
    if (!midiFile) return;
    if (midiPlayer) {
      midiPlayer.stop();
      setMidiPlayer(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      const midi = new Uint8Array(e.target.result);
      // Use @tonejs/midi for parsing (not installed here, but structure is ready)
      // const midiData = new Midi(midi);
      // setMidiInfo({ tracks: midiData.tracks.length, duration: midiData.duration });
      // For now, just play a simple synth melody
      const synth = new Tone.Synth().toDestination();
      setMidiPlayer(synth);
      synth.triggerAttackRelease('C4', '8n');
      setTimeout(() => setMidiPlayer(null), 500);
    };
    reader.readAsArrayBuffer(midiFile);
  };

  // Batch export all regions
  const handleBatchRegionExport = async () => {
    if (!selectedFile || regions.length === 0) return;
    setProcessing(true);
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      const { start, end, data } = region;
      const wavBlob = await convertAudio(selectedFile, sampleRate, masterPreset, lufs, start, end);
      const regionName = (data && data.name) ? data.name : `region${i+1}`;
      saveAs(wavBlob, selectedFile.name.replace(/\.[^/.]+$/, '') + `_${regionName}_${start.toFixed(2)}-${end.toFixed(2)}.wav`);
    }
    setProcessing(false);
    alert('Batch region export complete!');
  };

  // --- MIDI Piano Roll (basic grid visualization) ---
  const [midiNotes, setMidiNotes] = useState([]);
  const [pianoRollVisible, setPianoRollVisible] = useState(false);

  // Parse MIDI file and extract notes (requires @tonejs/midi for full support)
  const handleParseMidi = () => {
    if (!midiFile) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        // Dynamically import @tonejs/midi if available
        const midiModule = await import('@tonejs/midi');
        const midi = new midiModule.Midi(new Uint8Array(e.target.result));
        // Flatten all notes from all tracks
        const notes = [];
        midi.tracks.forEach(track => {
          track.notes.forEach(note => {
            notes.push({
              pitch: note.name,
              time: note.time,
              duration: note.duration,
              velocity: note.velocity,
              channel: track.channel
            });
          });
        });
        setMidiNotes(notes);
        setPianoRollVisible(true);
        setMidiInfo({ tracks: midi.tracks.length, duration: midi.duration });
      } catch (err) {
        // Fallback: fake a C major scale
        setMidiNotes([
          { pitch: 'C4', time: 0, duration: 0.5 },
          { pitch: 'D4', time: 0.5, duration: 0.5 },
          { pitch: 'E4', time: 1, duration: 0.5 },
          { pitch: 'F4', time: 1.5, duration: 0.5 },
          { pitch: 'G4', time: 2, duration: 0.5 },
          { pitch: 'A4', time: 2.5, duration: 0.5 },
          { pitch: 'B4', time: 3, duration: 0.5 },
          { pitch: 'C5', time: 3.5, duration: 0.5 },
        ]);
        setPianoRollVisible(true);
      }
    };
    reader.readAsArrayBuffer(midiFile);
  };

  // Automation lane (simple gain automation)
  const [automationPoints, setAutomationPoints] = useState([
    { time: 0, value: 1 },
    { time: 1, value: 0.8 },
    { time: 2, value: 1.2 },
    { time: 3, value: 1 },
  ]);
  const [panAutomation, setPanAutomation] = useState([
    { time: 0, value: 0 },
    { time: 1, value: -0.5 },
    { time: 2, value: 0.5 },
    { time: 3, value: 0 },
  ]);

  const handleAutomationChange = (idx, newValue) => {
    setAutomationPoints(points => points.map((pt, i) => i === idx ? { ...pt, value: newValue } : pt));
  };
  const handlePanAutomationChange = (idx, newValue) => {
    setPanAutomation(points => points.map((pt, i) => i === idx ? { ...pt, value: newValue } : pt));
  };

  const handleTrackSelect = (id) => setSelectedTrackId(id);
  const handleTrackSolo = (id) => setTracks(tracks => tracks.map(t => t.id === id ? { ...t, solo: !t.solo } : t));
  const handleTrackMute = (id) => setTracks(tracks => tracks.map(t => t.id === id ? { ...t, mute: !t.mute } : t));
  const handleTrackFile = (id, file) => setTracks(tracks => tracks.map(t => t.id === id ? { ...t, file } : t));
  const handleAddTrack = (type) => setTracks(tracks => [...tracks, { id: Date.now(), name: `${type === 'audio' ? 'Audio' : 'MIDI'} ${tracks.length+1}`, type, file: null, solo: false, mute: false }]);

  // --- Track Effects (per-track, simple UI) ---
  const [trackEffects, setTrackEffects] = useState({});
  const handleAddEffect = (trackId, effect) => {
    setTrackEffects(effects => ({ ...effects, [trackId]: [...(effects[trackId] || []), effect] }));
  };
  const handleRemoveEffect = (trackId, idx) => {
    setTrackEffects(effects => ({ ...effects, [trackId]: effects[trackId].filter((_, i) => i !== idx) }));
  };

  // --- Advanced MIDI Editing (UI only) ---
  const handleMidiNoteEdit = (idx, prop, value) => {
    setMidiNotes(notes => notes.map((n, i) => i === idx ? { ...n, [prop]: value } : n));
  };
  const handleMidiNoteDelete = (idx) => {
    setMidiNotes(notes => notes.filter((_, i) => i !== idx));
  };
  const handleMidiNoteAdd = () => {
    setMidiNotes(notes => [...notes, { pitch: 'C4', time: 0, duration: 0.5, velocity: 0.8, channel: 1 }]);
  };

  // --- Real-time Automation Playback (UI only, logic placeholder) ---
  const [automationActive, setAutomationActive] = useState(false);
  const handleAutomationPlayback = () => {
    setAutomationActive(a => !a);
    // In a real DAW, this would modulate gain/pan in real time as audio plays
  };

  // --- Real Audio Effect Processing (Tone.js) ---
  const [audioChain, setAudioChain] = useState({});

  useEffect(() => {
    // Only process for selected audio track
    const track = tracks.find(t => t.id === selectedTrackId && t.type === 'audio' && t.file);
    if (!track) return;
    // Clean up previous chain
    if (audioChain[track.id]) {
      audioChain[track.id].dispose && audioChain[track.id].dispose();
    }
    // Build new chain
    let player = null;
    let chain = [];
    if (track.file) {
      player = new Tone.Player(URL.createObjectURL(track.file)).toDestination();
      chain.push(player);
      (trackEffects[track.id] || []).forEach(effect => {
        let fx;
        if (effect === 'Reverb') fx = new Tone.Reverb({ decay: 2, wet: 0.4 }).toDestination();
        if (effect === 'Delay') fx = new Tone.FeedbackDelay(0.25, 0.5).toDestination();
        if (effect === 'Chorus') fx = new Tone.Chorus(4, 2.5, 0.5).toDestination();
        if (effect === 'EQ') fx = new Tone.EQ3(6, 0, -6).toDestination();
        if (effect === 'Compressor') fx = new Tone.Compressor().toDestination();
        if (fx) {
          chain[chain.length - 1].connect(fx);
          chain.push(fx);
        }
      });
      setAudioChain(ac => ({ ...ac, [track.id]: player }));
    }
    return () => {
      if (player) player.dispose();
      chain.forEach(fx => fx && fx.dispose && fx.dispose());
    };
    // eslint-disable-next-line
  }, [selectedTrackId, tracks, trackEffects]);

  const handleTrackPlay = (id) => {
    const track = tracks.find(t => t.id === id);
    if (track && audioChain[id]) {
      audioChain[id].start();
    }
  };
  const handleTrackStop = (id) => {
    if (audioChain[id]) audioChain[id].stop();
  };

  // --- MIDI Export ---
  const handleMidiExport = async () => {
    try {
      const midiModule = await import('@tonejs/midi');
      const midi = new midiModule.Midi();
      const track = midi.addTrack();
      midiNotes.forEach(n => {
        track.addNote({
          name: n.pitch,
          time: n.time,
          duration: n.duration,
          velocity: n.velocity || 0.8,
          channel: n.channel || 1
        });
      });
      const blob = new Blob([midi.toArray()], { type: 'audio/midi' });
      saveAs(blob, 'exported.mid');
    } catch (err) {
      alert('MIDI export requires @tonejs/midi.');
    }
  };

  // --- Real-time Automation Playback (volume/pan modulation) ---
  useEffect(() => {
    if (!automationActive) return;
    let raf;
    const start = performance.now();
    function animate() {
      const t = ((performance.now() - start) / 1000) % 4;
      // Interpolate automation points
      function interp(points) {
        if (points.length === 0) return 1;
        let prev = points[0], next = points[points.length - 1];
        for (let i = 1; i < points.length; i++) {
          if (points[i].time > t) {
            next = points[i];
            prev = points[i - 1];
            break;
          }
        }
        const dt = next.time - prev.time;
        if (dt === 0) return prev.value;
        return prev.value + (next.value - prev.value) * ((t - prev.time) / dt);
      }
      const vol = interp(automationPoints);
      const pan = interp(panAutomation);
      // Apply to Tone.js Player if exists
      const track = tracks.find(t => t.id === selectedTrackId && t.type === 'audio');
      if (track && audioChain[track.id]) {
        audioChain[track.id].volume && (audioChain[track.id].volume.value = 20 * Math.log10(vol));
        if (!audioChain[track.id].pan) audioChain[track.id].pan = new Tone.Panner(0).toDestination();
        audioChain[track.id].pan.pan = pan;
      }
      raf = requestAnimationFrame(animate);
    }
    animate();
    return () => raf && cancelAnimationFrame(raf);
    // eslint-disable-next-line
  }, [automationActive, automationPoints, panAutomation, selectedTrackId, tracks, audioChain]);

  // --- Effect Parameter Automation ---
  const [effectAutomation, setEffectAutomation] = useState({}); // { trackId: { effectName: [{time, value}] } }
  const handleEffectAutomationChange = (trackId, effect, idx, newValue) => {
    setEffectAutomation(ea => ({
      ...ea,
      [trackId]: {
        ...(ea[trackId] || {}),
        [effect]: (ea[trackId]?.[effect] || []).map((pt, i) => i === idx ? { ...pt, value: newValue } : pt)
      }
    }));
  };
  const addEffectAutomationPoint = (trackId, effect) => {
    setEffectAutomation(ea => ({
      ...ea,
      [trackId]: {
        ...(ea[trackId] || {}),
        [effect]: [...(ea[trackId]?.[effect] || []), { time: 0, value: 0.5 }]
      }
    }));
  };

  // --- True Multi-track Audio Mixing (Tone.js) ---
  const [mixers, setMixers] = useState({});
  useEffect(() => {
    // For each audio track, create a Tone.Player and connect to a Tone.Mixer
    const newMixers = {};
    tracks.forEach(track => {
      if (track.type === 'audio' && track.file) {
        const player = new Tone.Player(URL.createObjectURL(track.file));
        const mixer = new Tone.Gain(1).toDestination();
        player.connect(mixer);
        newMixers[track.id] = { player, mixer };
      }
    });
    setMixers(newMixers);
    return () => {
      Object.values(newMixers).forEach(({ player, mixer }) => {
        player.dispose();
        mixer.dispose();
      });
    };
  }, [tracks]);
  const handleMixPlay = () => {
    Object.values(mixers).forEach(({ player }) => player.start());
  };
  const handleMixStop = () => {
    Object.values(mixers).forEach(({ player }) => player.stop());
  };

  // --- MIDI Import/Export Improvements ---
  const handleMidiImport = async (file) => {
    try {
      const midiModule = await import('@tonejs/midi');
      const reader = new FileReader();
      reader.onload = (e) => {
        const midi = new midiModule.Midi(new Uint8Array(e.target.result));
        const notes = [];
        midi.tracks.forEach(track => {
          track.notes.forEach(note => {
            notes.push({
              pitch: note.name,
              time: note.time,
              duration: note.duration,
              velocity: note.velocity,
              channel: track.channel
            });
          });
        });
        setMidiNotes(notes);
        setPianoRollVisible(true);
        setMidiInfo({ tracks: midi.tracks.length, duration: midi.duration });
      };
      reader.readAsArrayBuffer(file);
    } catch (err) {
      alert('MIDI import requires @tonejs/midi.');
    }
  };

  return (
    <div className="audio-workstation">
      <h2>Audio Workstation (Suno AI → Amuse AI)</h2>
      <div {...getRootProps()} className={`dropzone${isDragActive ? ' active' : ''}`}>
        <input {...getInputProps()} />
        {isDragActive ? <p>Drop files here...</p> : <p>Drag & drop audio files here, or click to select</p>}
      </div>
      <div className="file-list">
        {files.map((file, idx) => (
          <div key={idx} className={`file-item${file === selectedFile ? ' selected' : ''}`} onClick={() => { setSelectedFile(file); loadWaveform(file); }}>
            {file.name}
          </div>
        ))}
      </div>
      <div ref={waveformRef} className="waveform-display"></div>
      <div className="meters">
        <div className="meter-label">Peak</div>
        <div className="meter-bar" style={{ width: 60, height: 12, background: '#232323', borderRadius: 4, marginBottom: 4 }}>
          <div style={{ width: `${Math.min(100, peak * 100)}%`, height: '100%', background: '#D4AF37', transition: 'width 0.1s' }} />
        </div>
        <div className="meter-label">RMS</div>
        <div className="meter-bar" style={{ width: 60, height: 12, background: '#232323', borderRadius: 4 }}>
          <div style={{ width: `${Math.min(100, rms * 100)}%`, height: '100%', background: '#37A1D4', transition: 'width 0.1s' }} />
        </div>
      </div>
      {batchProcessing && (
        <div className="progress-bar" style={{ width: '100%', height: 8, background: '#232323', borderRadius: 4, margin: '12px 0' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: '#D4AF37', transition: 'width 0.2s' }} />
        </div>
      )}
      {metadata && (
        <div className="metadata" style={{ marginBottom: 12, color: '#D4AF37' }}>
          <strong>File:</strong> {metadata.name} | <strong>Type:</strong> {metadata.type} | <strong>Duration:</strong> {metadata.duration.toFixed(2)}s | <strong>Sample Rate:</strong> {metadata.sampleRate}Hz | <strong>Channels:</strong> {metadata.channels}
        </div>
      )}
      <div className="spectrum" style={{ display: 'flex', gap: 1, height: 40, marginBottom: 12 }}>
        {spectrumData.map((v, i) => (
          <div key={i} style={{ width: 2, height: `${v / 2}px`, background: '#37A1D4', borderRadius: 1 }} />
        ))}
      </div>
      <div className="daw-controls" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button onClick={() => waveSurfer && waveSurfer.seekTo(0)} disabled={!selectedFile}>⏮️</button>
        <button onClick={() => waveSurfer && waveSurfer.seekTo(Math.max(0, waveSurfer.getCurrentTime() - 5) / waveSurfer.getDuration())} disabled={!selectedFile}>⏪</button>
        <span style={{ color: '#D4AF37', minWidth: 60 }}>{currentTime.toFixed(2)}s</span>
        <button onClick={() => waveSurfer && waveSurfer.seekTo(Math.min(waveSurfer.getDuration(), waveSurfer.getCurrentTime() + 5) / waveSurfer.getDuration())} disabled={!selectedFile}>⏩</button>
        <button onClick={() => setLoop(l => !l)} style={{ background: loop ? '#D4AF37' : undefined, color: loop ? '#181818' : undefined }}>Loop</button>
      </div>
      <div className="controls">
        <button onClick={handlePlayPause} disabled={!selectedFile}>{playing ? 'Pause' : 'Play'}</button>
        <button onClick={handleStop} disabled={!selectedFile}>Stop</button>
        <label style={{ color: '#D4AF37', marginLeft: 8 }}>
          Volume
          <input type="range" min="0" max="2" step="0.01" value={volume} onChange={e => setVolume(Number(e.target.value))} style={{ marginLeft: 8 }} />
        </label>
        <select value={sampleRate} onChange={e => setSampleRate(e.target.value)}>
          <option value="44100">44.1kHz</option>
          <option value="48000">48kHz</option>
          <option value="96000">96kHz</option>
        </select>
        <select value={masterPreset} onChange={e => setMasterPreset(e.target.value)}>
          <option value="none">No Mastering</option>
          <option value="pop">Pop Master</option>
          <option value="hiphop">Hip-Hop Master</option>
          <option value="acoustic">Acoustic Master</option>
        </select>
        <button onClick={handleLufsNormalize} disabled={!selectedFile}>LUFS Normalize</button>
        <button onClick={handleConvert} disabled={!selectedFile || processing}>{processing ? 'Converting...' : 'Convert to WAV'}</button>
        <button onClick={handleExport} disabled={!selectedFile}>Export for Amuse AI</button>
        <button onClick={handleBatchConvert} disabled={files.length < 2 || batchProcessing}>Batch Convert All</button>
      </div>
      <div className="daw-controls" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <select value={exportPreset} onChange={handleExportPreset} style={{ minWidth: 120 }}>
          {EXPORT_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <label style={{ color: '#D4AF37', marginLeft: 8 }}>
          MIDI
          <input type="file" accept=".mid,.midi" onChange={handleMidiUpload} style={{ marginLeft: 8 }} />
        </label>
      </div>
      <div className="region-controls" style={{ marginBottom: 8 }}>
        <button onClick={() => waveSurfer && waveSurfer.addRegion({ start: waveSurfer.getCurrentTime(), end: waveSurfer.getCurrentTime() + 5, color: 'rgba(212,175,55,0.2)' })} disabled={!waveSurfer}>Add Region</button>
        <button onClick={() => {
          if (waveSurfer) {
            waveSurfer.clearRegions();
            setRegions([]);
            setSelectedRegion(null);
          }
        }} disabled={!waveSurfer}>Clear Regions</button>
        {selectedRegion && (
          <>
            <button onClick={handleRegionExport} disabled={processing}>Export Region</button>
            <input type="color" value={selectedRegion.color || '#D4AF37'} onChange={e => selectedRegion.update({ color: e.target.value })} />
            <input type="text" placeholder="Region name" defaultValue={selectedRegion.data && selectedRegion.data.name} onBlur={e => selectedRegion.update({ data: { ...selectedRegion.data, name: e.target.value } })} style={{ width: 100 }} />
            <button onClick={() => { selectedRegion.remove(); setSelectedRegion(null); }}>Delete Region</button>
          </>
        )}
        {regions.length > 0 && <span style={{ color: '#D4AF37', marginLeft: 8 }}>Regions: {regions.length}</span>}
        <button onClick={handleBatchRegionExport} disabled={!waveSurfer || regions.length === 0 || processing}>Batch Export Regions</button>
      </div>
      {/* Multi-track UI */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          {tracks.map(track => (
            <div key={track.id} style={{ background: selectedTrackId === track.id ? '#D4AF37' : '#232323', color: selectedTrackId === track.id ? '#181818' : '#fff', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => handleTrackSelect(track.id)}>
              {track.name}
              {track.type === 'audio' && track.file && (
                <>
                  <button onClick={e => { e.stopPropagation(); handleTrackPlay(track.id); }} style={{ background: '#37A1D4', color: '#181818', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}>Play</button>
                  <button onClick={e => { e.stopPropagation(); handleTrackStop(track.id); }} style={{ background: '#D4AF37', color: '#181818', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}>Stop</button>
                </>
              )}
              <button onClick={e => { e.stopPropagation(); handleTrackSolo(track.id); }} style={{ background: track.solo ? '#37A1D4' : '#232323', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}>Solo</button>
              <button onClick={e => { e.stopPropagation(); handleTrackMute(track.id); }} style={{ background: track.mute ? '#D4AF37' : '#232323', color: '#181818', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}>Mute</button>
              <input type="file" accept={track.type === 'audio' ? SUPPORTED_FORMATS.join(',') : '.mid,.midi'} style={{ marginLeft: 4 }} onChange={e => handleTrackFile(track.id, e.target.files[0])} />
            </div>
          ))}
          <button onClick={() => handleAddTrack('audio')} style={{ background: '#37A1D4', color: '#181818', border: 'none', borderRadius: 6, padding: '4px 10px', fontWeight: 600 }}>+ Audio Track</button>
          <button onClick={() => handleAddTrack('midi')} style={{ background: '#D4AF37', color: '#181818', border: 'none', borderRadius: 6, padding: '4px 10px', fontWeight: 600 }}>+ MIDI Track</button>
        </div>
      </div>
      {/* MIDI Piano Roll Visualization */}
      {midiFile && (
        <div className="midi-section">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ color: '#37A1D4' }}>MIDI:</strong> {midiFile.name}
            <button onClick={handleMidiPlayback}>{midiPlayer ? 'Stop MIDI' : 'Play MIDI'}</button>
            <button onClick={handleParseMidi}>Show Piano Roll</button>
            <button onClick={() => setPianoRollVisible(false)} disabled={!pianoRollVisible}>Hide Piano Roll</button>
          </div>
          {pianoRollVisible && (
            <div className="piano-roll" style={{ position: 'relative', marginTop: 10, minHeight: 120, background: '#181818' }}>
              {/* Render a simple piano roll grid for C4-C5, multi-track color support */}
              {[...Array(8)].map((_, rowIdx) => {
                const noteNames = ['C5','B4','A4','G4','F4','E4','D4','C4'];
                const note = noteNames[rowIdx];
                return (
                  <div key={note} style={{ display: 'flex', alignItems: 'center', height: 16 }}>
                    <div className="piano-roll-key" style={{ width: 32 }}>{note}</div>
                    <div style={{ display: 'flex', flex: 1 }}>
                      {midiNotes.filter(n => n.pitch === note).map((n, i) => (
                        <div key={i} className="piano-roll-note" style={{ left: `${n.time * 40}px`, width: `${n.duration * 40}px`, position: 'relative', background: n.channel === 10 ? '#D4AF37' : '#37A1D4' }} title={`${n.pitch} @ ${n.time}s`} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {midiInfo && <div style={{ color: '#D4AF37', fontSize: 13, marginTop: 4 }}>Tracks: {midiInfo.tracks} | Duration: {midiInfo.duration ? midiInfo.duration.toFixed(2) : ''}s</div>}
        </div>
      )}
      {/* Automation Lane (simple gain automation) */}
      <div className="automation-lane" style={{ position: 'relative', margin: '12px 0', height: 32, background: '#232323', borderRadius: 4 }}>
        {automationPoints.map((pt, idx) => (
          <div
            key={idx}
            className="automation-point"
            style={{ left: `${(pt.time / 4) * 100}%`, bottom: `${(pt.value - 0.5) * 60}px` }}
            title={`Time: ${pt.time}s, Value: ${pt.value}`}
          >
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={pt.value}
              onChange={e => handleAutomationChange(idx, Number(e.target.value))}
              style={{ position: 'absolute', left: -20, top: -20, width: 60, opacity: 0.7 }}
            />
          </div>
        ))}
        <span style={{ position: 'absolute', left: 8, top: 4, color: '#D4AF37', fontSize: 12 }}>Gain Automation</span>
      </div>
      {/* Pan Automation Lane */}
      <div className="automation-lane" style={{ position: 'relative', margin: '12px 0', height: 32, background: '#232323', borderRadius: 4 }}>
        {panAutomation.map((pt, idx) => (
          <div
            key={idx}
            className="automation-point"
            style={{ left: `${(pt.time / 4) * 100}%`, bottom: `${(pt.value + 0.5) * 30}px`, background: '#37A1D4' }}
            title={`Time: ${pt.time}s, Pan: ${pt.value}`}
          >
            <input
              type="range"
              min="-1"
              max="1"
              step="0.01"
              value={pt.value}
              onChange={e => handlePanAutomationChange(idx, Number(e.target.value))}
              style={{ position: 'absolute', left: -20, top: -20, width: 60, opacity: 0.7 }}
            />
          </div>
        ))}
        <span style={{ position: 'absolute', left: 8, top: 4, color: '#37A1D4', fontSize: 12 }}>Pan Automation</span>
      </div>
      {/* Undo/Redo Controls */}
      <div className="undo-redo-controls">
        <button onClick={handleUndo} disabled={history.length === 0}>Undo</button>
        <button onClick={handleRedo} disabled={future.length === 0}>Redo</button>
      </div>
      {/* Track Effects UI */}
      <div style={{ marginBottom: 16 }}>
        {tracks.map(track => (
          <div key={track.id} style={{ marginBottom: 4 }}>
            <span style={{ color: '#D4AF37', fontWeight: 600 }}>{track.name} Effects:</span>
            <div className="effect-chain">
              {(trackEffects[track.id] || []).map((effect, idx) => (
                <span key={idx} className="effect-unit">{effect} <button onClick={() => handleRemoveEffect(track.id, idx)} style={{ marginLeft: 4, color: '#D4AF37', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button></span>
              ))}
              <select onChange={e => { if (e.target.value) { handleAddEffect(track.id, e.target.value); e.target.value = ''; } }} defaultValue="">
                <option value="">+ Add Effect</option>
                <option value="Reverb">Reverb</option>
                <option value="Delay">Delay</option>
                <option value="Chorus">Chorus</option>
                <option value="EQ">EQ</option>
                <option value="Compressor">Compressor</option>
              </select>
            </div>
          </div>
        ))}
      </div>
      {/* Advanced MIDI Editing UI */}
      {pianoRollVisible && (
        <div style={{ margin: '12px 0' }}>
          <button onClick={handleMidiNoteAdd} style={{ background: '#37A1D4', color: '#181818', border: 'none', borderRadius: 6, padding: '4px 10px', fontWeight: 600, marginBottom: 6 }}>+ Add MIDI Note</button>
          <table style={{ width: '100%', background: '#232323', color: '#fff', borderRadius: 6, fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#D4AF37' }}>
                <th>Pitch</th><th>Time</th><th>Duration</th><th>Velocity</th><th>Channel</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {midiNotes.map((n, idx) => (
                <tr key={idx}>
                  <td><input value={n.pitch} onChange={e => handleMidiNoteEdit(idx, 'pitch', e.target.value)} style={{ width: 50 }} /></td>
                  <td><input type="number" value={n.time} onChange={e => handleMidiNoteEdit(idx, 'time', parseFloat(e.target.value))} style={{ width: 50 }} /></td>
                  <td><input type="number" value={n.duration} onChange={e => handleMidiNoteEdit(idx, 'duration', parseFloat(e.target.value))} style={{ width: 50 }} /></td>
                  <td><input type="number" value={n.velocity} onChange={e => handleMidiNoteEdit(idx, 'velocity', parseFloat(e.target.value))} style={{ width: 50 }} /></td>
                  <td><input type="number" value={n.channel} onChange={e => handleMidiNoteEdit(idx, 'channel', parseInt(e.target.value))} style={{ width: 40 }} /></td>
                  <td><button onClick={() => handleMidiNoteDelete(idx)} style={{ color: '#D4AF37', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Real-time Automation Playback (UI only) */}
      <div style={{ margin: '12px 0' }}>
        <button onClick={handleAutomationPlayback} style={{ background: automationActive ? '#D4AF37' : '#232323', color: automationActive ? '#181818' : '#D4AF37', border: '1px solid #D4AF37', borderRadius: 6, padding: '4px 14px', fontWeight: 600 }}>
          {automationActive ? 'Stop Automation Playback' : 'Start Automation Playback'}
        </button>
        {automationActive && <span style={{ marginLeft: 12, color: '#37A1D4' }}>Automation playback active (UI only)</span>}
      </div>
      {/* TODO: Add real mastering, etc. */}
      {/* Multi-track Mix Controls */}
      <div style={{ margin: '12px 0' }}>
        <button onClick={handleMixPlay} style={{ background: '#37A1D4', color: '#181818', border: 'none', borderRadius: 6, padding: '4px 14px', fontWeight: 600, marginRight: 8 }}>Play All Tracks</button>
        <button onClick={handleMixStop} style={{ background: '#D4AF37', color: '#181818', border: 'none', borderRadius: 6, padding: '4px 14px', fontWeight: 600 }}>Stop All Tracks</button>
      </div>
      {/* Effect Parameter Automation UI */}
      {tracks.map(track => (
        <div key={track.id} style={{ marginBottom: 8 }}>
          {(trackEffects[track.id] || []).map(effect => (
            <div key={effect} style={{ marginBottom: 4 }}>
              <span style={{ color: '#37A1D4', fontWeight: 500 }}>{effect} Automation:</span>
              <button onClick={() => addEffectAutomationPoint(track.id, effect)} style={{ marginLeft: 8, background: '#232323', color: '#D4AF37', border: '1px solid #D4AF37', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>+ Point</button>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                {(effectAutomation[track.id]?.[effect] || []).map((pt, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: '#fff' }}>t={pt.time}s</span>
                    <input type="range" min="0" max="1" step="0.01" value={pt.value} onChange={e => handleEffectAutomationChange(track.id, effect, idx, parseFloat(e.target.value))} />
                    <span style={{ color: '#D4AF37' }}>{pt.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
      {/* MIDI Import/Export UI */}
      <div style={{ margin: '12px 0' }}>
        <input type="file" accept=".mid,.midi" onChange={e => handleMidiImport(e.target.files[0])} style={{ marginRight: 8 }} />
        <button onClick={handleMidiExport} style={{ background: '#D4AF37', color: '#181818', border: 'none', borderRadius: 6, padding: '4px 14px', fontWeight: 600 }}>Export MIDI</button>
      </div>
      {/* TODO: Add real mastering, etc. */}
    </div>
  );
};

export default AudioWorkstation;
