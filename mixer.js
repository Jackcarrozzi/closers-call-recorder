// Turns the condensed per-speaker files back into a single, correctly-timed mp3.
//
// Rather than writing multi-gigabyte padded PCM files to disk, we hand ffmpeg a
// named pipe per speaker and stream the silence in as it reads. Peak disk usage
// stays at "the speech itself", no matter how long the call ran.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PCM } from './config.js';
import { SpeakerTrack } from './tracks.js';

const SILENCE_CHUNK = Buffer.alloc(PCM.bytesPerSecond); // 1s of silence, reused

function writeAsync(stream, buf) {
  return new Promise((resolve, reject) => {
    if (stream.write(buf)) return resolve();
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

async function writeSilence(stream, bytes) {
  let left = bytes;
  while (left > 0) {
    const n = Math.min(left, SILENCE_CHUNK.length);
    await writeAsync(stream, n === SILENCE_CHUNK.length ? SILENCE_CHUNK : SILENCE_CHUNK.subarray(0, n));
    left -= n;
  }
}

/** Streams one speaker's timeline into a fifo: silence, speech, silence, speech... */
async function feedTrack(track, fifoPath, durationMs) {
  const out = fs.createWriteStream(fifoPath);
  const src = await fsp.open(track.file, 'r');
  let readPos = 0;
  let written = 0;

  try {
    for (const burst of track.bursts) {
      const target = SpeakerTrack.bytesFor(burst.offsetMs);
      if (target > written) {
        await writeSilence(out, target - written);
        written = target;
      }
      let left = burst.bytes;
      while (left > 0) {
        const size = Math.min(left, 1 << 20);
        const buf = Buffer.allocUnsafe(size);
        const { bytesRead } = await src.read(buf, 0, size, readPos);
        if (bytesRead === 0) { left = 0; break; }
        readPos += bytesRead;
        left -= bytesRead;
        written += bytesRead;
        await writeAsync(out, buf.subarray(0, bytesRead));
      }
    }
    const total = SpeakerTrack.bytesFor(durationMs);
    if (total > written) await writeSilence(out, total - written);
  } finally {
    await src.close();
    await new Promise((resolve) => out.end(resolve));
  }
}

async function mkfifo(p) {
  await new Promise((resolve, reject) => {
    const proc = spawn('mkfifo', [p], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`))));
  });
}

/**
 * @param {object} opts
 * @param {SpeakerTrack[]} opts.tracks   speakers with at least one burst
 * @param {string} opts.workDir          scratch directory for the fifos
 * @param {string} opts.outFile          destination .mp3
 * @param {number} opts.durationMs       full wall-clock length of the call
 * @param {boolean} [opts.keepUserTracks] also write one mp3 per speaker
 * @param {string} [opts.bitrate]
 * @param {number} [opts.channels]       1 = mono mixdown
 * @returns {Promise<{main: string, perSpeaker: {userId: string, label: string, file: string}[]}>}
 */
export async function mixSession({
  tracks,
  workDir,
  outFile,
  durationMs,
  keepUserTracks = false,
  bitrate = '64k',
  channels = 1,
  ffmpegPath = 'ffmpeg',
}) {
  if (tracks.length === 0) throw new Error('nothing to mix: no speaker captured any audio');

  const fifoDir = path.join(workDir, 'fifo');
  await fsp.mkdir(fifoDir, { recursive: true });
  const fifos = [];
  for (let i = 0; i < tracks.length; i++) {
    const p = path.join(fifoDir, `in${i}.pcm`);
    await fsp.rm(p, { force: true });
    await mkfifo(p);
    fifos.push(p);
  }

  // ffmpeg opens (and truncates) its output the moment it starts, long before
  // any audio has actually been encoded into it. Writing to "<name>.part" and
  // renaming only once ffmpeg has closed the file cleanly is what lets
  // anything else walking the sessions dir - the backlog sweep, a future
  // boot's recovery pass - trust that a bare "*.mp3" it finds is complete.
  const outPart = `${outFile}.part`;

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const f of fifos) {
    args.push('-f', 's16le', '-ar', String(PCM.sampleRate), '-ac', String(PCM.channels), '-i', f);
  }

  // Sum the speakers, then limit rather than normalise: normalising would duck
  // everyone whenever a second person starts talking.
  const mix =
    tracks.length === 1
      ? `[0:a]alimiter=limit=0.95[mixed]`
      : `${fifos.map((_, i) => `[${i}:a]`).join('')}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0[sum];[sum]alimiter=limit=0.95[mixed]`;
  args.push('-filter_complex', mix);
  // ffmpeg otherwise guesses the output container from the filename's
  // extension - ".part" isn't one it knows, so the format has to be named
  // explicitly for both outputs below.
  args.push('-map', '[mixed]', '-ac', String(channels), '-c:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3', outPart);

  const perSpeaker = [];
  const perSpeakerParts = [];
  if (keepUserTracks) {
    const base = outFile.replace(/\.mp3$/i, '');
    tracks.forEach((t, i) => {
      const file = `${base}.${safeLabel(t.label)}.mp3`;
      const part = `${file}.part`;
      args.push('-map', `${i}:a`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3', part);
      perSpeaker.push({ userId: t.userId, label: t.label, file });
      perSpeakerParts.push(part);
    });
  }

  const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  ffmpeg.stderr.on('data', (d) => (stderr += d.toString().slice(0, 4000)));

  const done = new Promise((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))
    );
  });

  // Writers block until ffmpeg opens the read end, which is why ffmpeg is spawned first.
  const feeds = tracks.map((t, i) => feedTrack(t, fifos[i], durationMs));

  try {
    await Promise.all([done, ...feeds]);
    // Only now does ffmpeg's own exit code say the file is actually
    // complete - rename it into the name everything else looks for.
    await fsp.rename(outPart, outFile);
    for (let i = 0; i < perSpeaker.length; i++) await fsp.rename(perSpeakerParts[i], perSpeaker[i].file);
  } finally {
    await fsp.rm(fifoDir, { recursive: true, force: true });
    // A failed mix (or one interrupted mid-encode) leaves ".part" files
    // instead of the renames above ever running - clean those up here so
    // they don't sit around forever; a successful run has already renamed
    // them away, so these are no-ops on the happy path.
    await fsp.rm(outPart, { force: true }).catch(() => {});
    for (const p of perSpeakerParts) await fsp.rm(p, { force: true }).catch(() => {});
  }

  return { main: outFile, perSpeaker };
}

export function safeLabel(label) {
  return (
    String(label)
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'speaker'
  );
}
