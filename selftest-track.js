// Phase 2: drive the real SpeakerTrack writer with simulated packet timing and
// confirm the bursts it records put the speech back in the right place.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PCM } from './config.js';
import { SpeakerTrack } from './tracks.js';
import { mixSession } from './mixer.js';

const FRAME = PCM.frameBytes; // 20ms
const FRAME_MS = 20;

function frame(hz, n, amp = 0.4) {
  const buf = Buffer.alloc(FRAME);
  const samples = FRAME / (PCM.channels * PCM.bytesPerSample);
  for (let i = 0; i < samples; i++) {
    const t = (n * samples + i) / PCM.sampleRate;
    const v = Math.round(Math.sin(2 * Math.PI * hz * t) * amp * 32767);
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

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tracktest-'));
const sessionStart = 1_000_000; // arbitrary fake clock origin

// Alice speaks 1.0s-3.0s and 7.0s-9.0s. Bob speaks 4.0s-6.0s.
const alice = new SpeakerTrack({ userId: '1', label: 'Alice', dir, sessionStart });
const bob = new SpeakerTrack({ userId: '2', label: 'Bob', dir, sessionStart });

let n = 0;
for (const [from, to] of [[1000, 3000], [7000, 9000]]) {
  for (let t = from; t < to; t += FRAME_MS) {
    // A packet arrives at the END of the audio window it carries.
    alice.write(frame(440, n++), sessionStart + t + FRAME_MS);
  }
}
n = 0;
for (let t = 4000; t < 6000; t += FRAME_MS) {
  bob.write(frame(880, n++), sessionStart + t + FRAME_MS);
}

await alice.close();
await bob.close();

const summary = [alice, bob].map((t) => t.toJSON());
console.log('bursts recorded:');
for (const s of summary) {
  console.log(`  ${s.label.padEnd(6)} ${s.bursts.map((b) => `${(b.offsetMs / 1000).toFixed(2)}s +${(b.bytes / PCM.bytesPerSecond).toFixed(2)}s`).join('  ')}`);
}

const expectBursts =
  alice.bursts.length === 2 && bob.bursts.length === 1 &&
  Math.abs(alice.bursts[0].offsetMs - 1000) < 30 &&
  Math.abs(alice.bursts[1].offsetMs - 7000) < 30 &&
  Math.abs(bob.bursts[0].offsetMs - 4000) < 30;

const out = path.join(dir, 'mixed.mp3');
await mixSession({ tracks: [alice, bob], workDir: dir, outFile: out, durationMs: 10_000, channels: 1 });

const raw = path.join(dir, 'decoded.pcm');
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-f', 's16le', '-ar', '48000', '-ac', '1', raw]);
const buf = await fsp.readFile(raw);
const perSec = 96000;
const loud = [];
for (let s = 0; s < 10; s++) {
  const slice = buf.subarray(s * perSec, (s + 1) * perSec);
  let sum = 0;
  for (let i = 0; i + 1 < slice.length; i += 2) sum += Math.abs(slice.readInt16LE(i));
  loud.push(slice.length ? sum / (slice.length / 2) > 1500 : false);
}
const expected = [false, true, true, false, true, true, false, true, true, false];
const shapeOk = loud.every((v, i) => v === expected[i]);

console.log('speech windows :', loud.map((v) => (v ? '#' : '.')).join(''), shapeOk ? 'OK' : 'FAIL');
console.log('expected       :', expected.map((v) => (v ? '#' : '.')).join(''));
console.log('burst offsets  :', expectBursts ? 'OK' : 'FAIL');

await fsp.rm(dir, { recursive: true, force: true });
if (!shapeOk || !expectBursts) process.exit(1);
console.log('\nPASS - the live capture path reproduces the call timeline.');
