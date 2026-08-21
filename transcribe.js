// Optional transcripts, labelled by speaker.
//
// Because each person has their own isolated track, we can transcribe them one
// at a time and know exactly who said what - no diarisation guesswork. We feed
// the transcriber the condensed track (speech only) and then map the timestamps
// it returns back onto the real call timeline, which also means we never pay to
// transcribe silence.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { PCM } from './config.js';
import { safeLabel } from './mixer.js';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d.toString().slice(0, 4000)));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${c}: ${err.trim()}`))));
  });
}

/** Condensed-track seconds -> real position in the call, in seconds. */
function toSessionSeconds(condensedSec, bursts) {
  let cursorMs = 0;
  const targetMs = condensedSec * 1000;
  for (const b of bursts) {
    const lenMs = (b.bytes / PCM.bytesPerSecond) * 1000;
    if (targetMs <= cursorMs + lenMs) {
      return (b.offsetMs + (targetMs - cursorMs)) / 1000;
    }
    cursorMs += lenMs;
  }
  const last = bursts[bursts.length - 1];
  return last ? (last.offsetMs + (last.bytes / PCM.bytesPerSecond) * 1000) / 1000 : condensedSec;
}

async function toWav(pcmFile, wavFile) {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 's16le', '-ar', String(PCM.sampleRate), '-ac', String(PCM.channels), '-i', pcmFile,
    '-ar', '16000', '-ac', '1', wavFile,
  ]);
}

async function transcribeOpenAI(wavFile, { apiKey, model }) {
  const body = new FormData();
  body.append('file', new Blob([await fs.readFile(wavFile)], { type: 'audio/wav' }), 'audio.wav');
  body.append('model', model);
  body.append('response_format', 'verbose_json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });
  if (!res.ok) throw new Error(`OpenAI transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return (json.segments ?? []).map((s) => ({ start: s.start, text: String(s.text).trim() }));
}

async function transcribeLocal(wavFile, { bin, model }) {
  const out = wavFile.replace(/\.wav$/, '');
  await run(bin, ['-m', model, '-f', wavFile, '-oj', '-of', out, '-nt']);
  const json = JSON.parse(await fs.readFile(`${out}.json`, 'utf8'));
  const segs = json.transcription ?? [];
  return segs.map((s) => ({
    start: (s.offsets?.from ?? 0) / 1000,
    text: String(s.text ?? '').trim(),
  }));
}

function stamp(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

/**
 * @returns {Promise<string|null>} path to the written .txt, or null if disabled/empty
 */
export async function transcribeSession({ mode, tracks, manifest, outFile, config, log }) {
  if (mode === 'off' || tracks.length === 0) return null;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'transcribe-'));
  const lines = [];

  try {
    for (const track of tracks) {
      if (track.totalBytes < PCM.bytesPerSecond) continue; // under a second of speech
      const wav = path.join(tmp, `${safeLabel(track.label)}.wav`);
      await toWav(track.file, wav);

      let segments;
      if (mode === 'openai') {
        segments = await transcribeOpenAI(wav, {
          apiKey: config.openaiApiKey,
          model: config.openaiModel,
        });
      } else {
        segments = await transcribeLocal(wav, {
          bin: config.whisperBin,
          model: config.whisperModel,
        });
      }

      for (const seg of segments) {
        if (!seg.text) continue;
        lines.push({
          at: toSessionSeconds(seg.start, track.bursts),
          label: track.label,
          text: seg.text,
        });
      }
      log.info(`transcribed ${track.label} (${segments.length} segments)`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  if (lines.length === 0) return null;
  lines.sort((a, b) => a.at - b.at);

  const header = [
    `${manifest.guild.name} - #${manifest.channel.name}`,
    `${new Date(manifest.startedAt).toLocaleString('en-US', { timeZone: config.timezone })}`,
    `${Math.round(manifest.durationMs / 60000)} minutes - ${manifest.speakers.length} speaker(s)`,
    '',
  ].join('\n');

  const body = lines.map((l) => `[${stamp(l.at)}] ${l.label}: ${l.text}`).join('\n');
  await fs.writeFile(outFile, `${header}${body}\n`);
  return outFile;
}
