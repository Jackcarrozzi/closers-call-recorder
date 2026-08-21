// Proves the timeline maths: synthetic speech at known offsets should come back
// out of the mixer at those same offsets, with silence in between.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PCM } from './config.js';
import { mixSession } from './mixer.js';

const BPS = PCM.bytesPerSecond;

function tone(seconds, hz, amp = 0.4) {
  const samples = PCM.sampleRate * seconds;
  const buf = Buffer.alloc(samples * PCM.channels * PCM.bytesPerSample);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / PCM.sampleRate) * amp * 32767);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`${cmd} ${c}: ${err}`))));
  });
}

/** Mean absolute sample value in a one-second window of the decoded output. */
async function energyPerSecond(mp3, totalSec) {
  const raw = path.join(path.dirname(mp3), 'decoded.pcm');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp3,
    '-f', 's16le', '-ar', '48000', '-ac', '1', raw]);
  const buf = await fsp.readFile(raw);
  const perSec = 48000 * 2;
  const out = [];
  for (let s = 0; s < totalSec; s++) {
    const slice = buf.subarray(s * perSec, (s + 1) * perSec);
    let sum = 0;
    for (let i = 0; i + 1 < slice.length; i += 2) sum += Math.abs(slice.readInt16LE(i));
    out.push(slice.length ? Math.round(sum / (slice.length / 2)) : 0);
  }
  return out;
}

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mixtest-'));

// Speaker A talks at 1s-3s and again at 7s-9s. Speaker B talks at 4s-6s.
const aFile = path.join(dir, 'a.pcm');
fs.writeFileSync(aFile, Buffer.concat([tone(2, 440), tone(2, 440)]));
const bFile = path.join(dir, 'b.pcm');
fs.writeFileSync(bFile, tone(2, 880));

const tracks = [
  { userId: '1', label: 'Alice', file: aFile,
    bursts: [{ offsetMs: 1000, bytes: 2 * BPS }, { offsetMs: 7000, bytes: 2 * BPS }] },
  { userId: '2', label: 'Bob', file: bFile,
    bursts: [{ offsetMs: 4000, bytes: 2 * BPS }] },
];

const out = path.join(dir, 'mixed.mp3');
await mixSession({ tracks, workDir: dir, outFile: out, durationMs: 10_000,
  keepUserTracks: true, bitrate: '64k', channels: 1 });

const dur = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=nw=1:nk=1', out])).trim());
const energy = await energyPerSecond(out, 10);

const loud = energy.map((e) => e > 1500);
const expected = [false, true, true, false, true, true, false, true, true, false];
const shapeOk = loud.every((v, i) => v === expected[i]);
const durOk = Math.abs(dur - 10) < 0.35;
const perSpeakerFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.mp3'));

console.log('duration       :', dur.toFixed(3), 's', durOk ? 'OK' : 'FAIL (expected ~10)');
console.log('energy/second  :', energy.join(' '));
console.log('speech windows :', loud.map((v) => (v ? '#' : '.')).join(''), shapeOk ? 'OK' : 'FAIL');
console.log('expected       :', expected.map((v) => (v ? '#' : '.')).join(''));
console.log('files written  :', perSpeakerFiles.join(', '));

await fsp.rm(dir, { recursive: true, force: true });
if (!durOk || !shapeOk) process.exit(1);
console.log('\nPASS - speakers land at the right moments and the silence is preserved.');
