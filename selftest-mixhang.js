// Regression tests for the "mixSession() can hang forever" incident.
//
// Three things must hold from here on:
//   (a) a feed erroring (missing/corrupt source pcm, or ffmpeg never even
//       starting) makes mixSession() reject promptly - not after the full
//       watchdog timeout, and without leaving the fifo dir or an orphaned
//       ffmpeg behind;
//   (b) a hard-hung ffmpeg (opens nothing, exits never) still makes
//       mixSession() reject, inside its watchdog window, having actually
//       killed the process rather than leaving it running;
//   (c) finishRecording() releases the slot and does not touch raw audio
//       when mixSession() rejects - verified at the source level, since
//       index.js self-starts a live bot on import and so cannot be pulled in
//       as a library for a runtime call in this test.
//
// Scenarios (f) and (g) exist because of how the feeds reach ffmpeg, and are
// the two regressions worth naming here:
//
//   - (f) The mixer must not care how many speakers there are. While the
//     feeds wrote through fs.WriteStream, every write went via libuv's small
//     fixed-size threadpool, and a write into a full 64KB pipe parked a
//     worker until ffmpeg drained it. With more speakers than threads, the
//     write ffmpeg was waiting for could never be scheduled: a permanent
//     deadlock that not even process exit survived. The feeds now write
//     through net.Socket (epoll), so nothing is parked and the pool is
//     irrelevant. Deliberately NOT setting UV_THREADPOOL_SIZE here: this
//     suite must run against the default pool, or (f) proves nothing.
//
//   - (g) A track small enough to fit in the pipe buffer must still mix. It
//     can be written and closed before a still-starting ffmpeg opens that
//     input, and a fifo whose last fd closes discards everything buffered -
//     leaving ffmpeg to block in open() forever on an input that already
//     came and went.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PCM } from './config.js';
import { mixSession, MixTimeoutError } from './mixer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BPS = PCM.bytesPerSecond;
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// Comfortably under the 64KB pipe buffer - see the file banner above.
const SHORT_SEC = 0.1;

function tone(seconds, hz, amp = 0.3) {
  const samples = Math.round(PCM.sampleRate * seconds);
  const buf = Buffer.alloc(samples * PCM.channels * PCM.bytesPerSample);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / PCM.sampleRate) * amp * 32767);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t0, value, err: null };
  } catch (err) {
    return { ms: Date.now() - t0, value: null, err };
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── (a1) a feed whose source pcm cannot even be opened ────────────────────
async function testMissingSourceRejectsPromptly() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mixhang-a1-'));
  const goodFile = path.join(dir, 'good.pcm');
  fs.writeFileSync(goodFile, tone(SHORT_SEC, 440));

  const tracks = [
    { userId: '1', label: 'Good', file: goodFile, bursts: [{ offsetMs: 0, bytes: Math.round(SHORT_SEC * BPS) }] },
    // Never written - fsp.open() inside feedTrack() throws ENOENT. Before the
    // fix this happened outside feedTrack's try/finally, so the fifo write
    // stream it had already opened was never closed.
    {
      userId: '2',
      label: 'Missing',
      file: path.join(dir, 'does-not-exist.pcm'),
      bursts: [{ offsetMs: 0, bytes: Math.round(SHORT_SEC * BPS) }],
    },
  ];
  const out = path.join(dir, 'out.mp3');

  const { ms, err } = await timed(() =>
    mixSession({ tracks, workDir: dir, outFile: out, durationMs: SHORT_SEC * 1000, channels: 1, mixTimeoutMs: 8000 })
  );

  check('missing source pcm rejects mixSession()', !!err, err?.message);
  check('rejected via the direct path, not the watchdog', ms < 5000, `${ms}ms`);
  check('no fifo directory left behind', !fs.existsSync(path.join(dir, 'fifo')));
  check('no leftover ".part" file', !fs.existsSync(`${out}.part`));

  await fsp.rm(dir, { recursive: true, force: true });
}

// ─── (a2) ffmpeg itself never starts (bad path) ────────────────────────────
async function testFfmpegSpawnFailureRejectsPromptly() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mixhang-a2-'));
  const file = path.join(dir, 'a.pcm');
  fs.writeFileSync(file, tone(SHORT_SEC, 440));
  const tracks = [{ userId: '1', label: 'A', file, bursts: [{ offsetMs: 0, bytes: Math.round(SHORT_SEC * BPS) }] }];
  const out = path.join(dir, 'out.mp3');

  const { ms, err } = await timed(() =>
    mixSession({
      tracks,
      workDir: dir,
      outFile: out,
      durationMs: SHORT_SEC * 1000,
      channels: 1,
      mixTimeoutMs: 8000,
      ffmpegPath: path.join(dir, 'no-such-ffmpeg-binary'),
    })
  );

  check('a premature ffmpeg exit (failed spawn) rejects mixSession()', !!err, err?.message);
  check('rejected via the direct path, not the watchdog', ms < 5000, `${ms}ms`);

  await fsp.rm(dir, { recursive: true, force: true });
}

// ─── (b) ffmpeg that opens nothing and never exits ─────────────────────────
async function testWatchdogKillsHungFfmpeg() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mixhang-b-'));
  const file = path.join(dir, 'a.pcm');
  fs.writeFileSync(file, tone(SHORT_SEC, 440));
  const tracks = [{ userId: '1', label: 'A', file, bursts: [{ offsetMs: 0, bytes: Math.round(SHORT_SEC * BPS) }] }];
  const out = path.join(dir, 'out.mp3');
  const pidFile = path.join(dir, 'fake-ffmpeg.pid');

  const fakeFfmpeg = path.join(__dirname, 'fake-ffmpeg-hang.mjs');
  const WATCHDOG_MS = 800; // short, only for this test - production stays at the 10-minute default

  const prevPidFileEnv = process.env.FAKE_FFMPEG_PIDFILE;
  process.env.FAKE_FFMPEG_PIDFILE = pidFile;
  let ms, err;
  try {
    ({ ms, err } = await timed(() =>
      mixSession({
        tracks,
        workDir: dir,
        outFile: out,
        durationMs: SHORT_SEC * 1000, // small on purpose - see the file banner
        channels: 1,
        mixTimeoutMs: WATCHDOG_MS,
        ffmpegPath: fakeFfmpeg,
      })
    ));
  } finally {
    if (prevPidFileEnv === undefined) delete process.env.FAKE_FFMPEG_PIDFILE;
    else process.env.FAKE_FFMPEG_PIDFILE = prevPidFileEnv;
  }

  check('watchdog rejects a hung ffmpeg', err instanceof MixTimeoutError, err?.message);
  check(
    'settles close to the watchdog window, not the 10-minute default',
    ms >= WATCHDOG_MS && ms < WATCHDOG_MS + 5000,
    `${ms}ms`
  );

  let pid = null;
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  } catch {}
  check('fake ffmpeg actually started (pidfile written)', Number.isInteger(pid) && pid > 0);
  if (pid) {
    // SIGKILL is asynchronous - give the kernel a moment to reap it before asserting.
    await new Promise((r) => setTimeout(r, 300));
    check('the hung ffmpeg process was actually killed, not just abandoned', !pidAlive(pid));
  }

  check('no fifo directory left behind', !fs.existsSync(path.join(dir, 'fifo')));
  check('raw source pcm was left untouched by the timeout', fs.existsSync(file));

  await fsp.rm(dir, { recursive: true, force: true });
}

// ─── (d) a corrupt burst index cannot run away or crash the mix ───────────
//
// recover.js builds its tracks straight out of a session.json/checkpoint.json
// that the crash it is recovering from may well have truncated or corrupted.
// A NaN/negative/absent value must degrade to silence rather than throw, and
// - the one that actually mattered - an absurd offsetMs must NOT turn the
// silence padding into an unbounded write loop. Before the clamp, an offset
// of 1e15 ms asked feedTrack() for ~190 petabytes of silence: mixSession()
// would still reject on the watchdog, but the abandoned feed would go on
// generating silence for the life of the process.
async function testCorruptBurstIndex() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mixhang-d-'));
  const file = path.join(dir, 'a.pcm');
  const audio = tone(SHORT_SEC, 440);
  fs.writeFileSync(file, audio);

  const tracks = [
    {
      userId: '1',
      label: 'Corrupt',
      file,
      bursts: [
        { offsetMs: 0, bytes: Math.round(SHORT_SEC * BPS) },
        { offsetMs: NaN, bytes: NaN },
        { offsetMs: -5000, bytes: -1 },
        { offsetMs: 1e15, bytes: 100 }, // the runaway: ~31,000 years in
        { offsetMs: undefined, bytes: undefined },
      ],
    },
  ];
  const out = path.join(dir, 'out.mp3');

  const { ms, err } = await timed(() =>
    mixSession({
      tracks,
      workDir: dir,
      outFile: out,
      durationMs: SHORT_SEC * 1000,
      channels: 1,
      mixTimeoutMs: 20_000,
    })
  );

  check('a corrupt burst index does not throw or hang the mix', !err, err?.message);
  check('it finishes in seconds, not on the watchdog (no unbounded silence run)', ms < 15_000, `${ms}ms`);
  check('a real mp3 still came out of it', fs.existsSync(out) && fs.statSync(out).size > 0,
    fs.existsSync(out) ? `${fs.statSync(out).size} bytes` : 'missing');
  check('no fifo directory left behind', !fs.existsSync(path.join(dir, 'fifo')));

  await fsp.rm(dir, { recursive: true, force: true });
}

// ─── (e) an absurd durationMs is clamped, not obeyed ──────────────────────
async function testAbsurdDurationClamped() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mixhang-e-'));
  const file = path.join(dir, 'a.pcm');
  fs.writeFileSync(file, tone(SHORT_SEC, 440));
  const tracks = [{ userId: '1', label: 'A', file, bursts: [{ offsetMs: 0, bytes: Math.round(SHORT_SEC * BPS) }] }];
  const out = path.join(dir, 'out.mp3');

  // durationMs itself is derived from the same untrusted index in recover.js
  // (Math.max of the recorded duration and every burst's end), so it can be
  // just as corrupt as the bursts are.
  for (const [label, durationMs] of [['NaN', NaN], ['negative', -1e9], ['Infinity', Infinity]]) {
    const { err } = await timed(() =>
      mixSession({ tracks, workDir: dir, outFile: out, durationMs, channels: 1, mixTimeoutMs: 20_000 })
    );
    check(`durationMs = ${label} still produces a mix instead of hanging or throwing`, !err, err?.message);
    await fsp.rm(out, { force: true });
  }

  await fsp.rm(dir, { recursive: true, force: true });
}

// ─── (f) more speakers than the threadpool has threads ────────────────────
//
// The regression this exists for is the incident itself. While ffmpeg is
// still starting up it has not begun draining any input, so every feed that
// has already rendezvoused fills its pipe's 64KB kernel buffer and stops.
// When those writes went through libuv's threadpool, "stopped" meant "parked
// a worker" - and once as many feeds were parked as the pool had threads
// (four, by default), the write that would have unblocked ffmpeg's next
// input had nowhere left to run, while ffmpeg sat waiting on exactly that
// write. Six speakers against a four-thread pool deadlocked permanently:
// mixSession() never settled, and the process could not even exit.
//
// This test process runs with the default pool, so eight tracks is
// comfortably past the cliff. It passing means the feeds are not on the
// threadpool at all any more.
async function testMoreTracksThanThreadpool() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mixhang-f-'));
  const N = 8;
  const tracks = [];
  for (let i = 0; i < N; i++) {
    const file = path.join(dir, `s${i}.pcm`);
    // Each track must carry MORE than a pipe buffer (64KB) for this to bite:
    // 1s of 48k stereo is 192KB, so every feed is guaranteed to hit the
    // backpressure that used to park a worker.
    const buf = tone(1, 300 + i * 90);
    fs.writeFileSync(file, buf);
    tracks.push({ userId: String(i), label: `S${i}`, file, bursts: [{ offsetMs: i * 200, bytes: buf.length }] });
  }
  const out = path.join(dir, 'many.mp3');

  const { ms, err } = await timed(() =>
    mixSession({ tracks, workDir: dir, outFile: out, durationMs: 5000, channels: 1, mixTimeoutMs: 30_000 })
  );

  check(`${N} tracks (> the default 4-thread pool) mixes instead of deadlocking`, !err, err?.message ?? `${ms}ms`);
  check('...and does so promptly', ms < 25_000, `${ms}ms`);
  check('a real mp3 came out', fs.existsSync(out) && fs.statSync(out).size > 1000,
    fs.existsSync(out) ? `${fs.statSync(out).size} bytes` : 'missing');

  // If a threadpool worker were still parked, an ordinary fs call would
  // queue behind it - this is the whole-process symptom from the incident.
  const t0 = Date.now();
  const alive = await Promise.race([
    fsp.writeFile(path.join(dir, 'probe'), 'ok').then(() => true),
    new Promise((r) => setTimeout(() => r(false), 3000)),
  ]);
  check('ordinary fs still works afterwards (no worker left parked)', alive, `${Date.now() - t0}ms`);

  await fsp.rm(dir, { recursive: true, force: true });
}

// ─── (g) a track smaller than the pipe buffer ─────────────────────────────
//
// A fifo only exists in the kernel while some fd is open on it: when the
// last one closes, anything buffered is discarded and the pipe resets. A
// track whose whole output fits in the 64KB buffer can be written and closed
// in well under a millisecond - long before a still-starting ffmpeg opens
// that input. Without the rendezvous in waitForReader(), ffmpeg then found
// an input with no data and no writer and blocked in open() forever.
async function testTrackSmallerThanPipeBuffer() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mixhang-g-'));
  const file = path.join(dir, 'tiny.pcm');
  const buf = tone(0.05, 440); // ~9.6KB, far under the 64KB pipe buffer
  fs.writeFileSync(file, buf);
  const tracks = [{ userId: '1', label: 'Tiny', file, bursts: [{ offsetMs: 0, bytes: buf.length }] }];
  const out = path.join(dir, 'tiny.mp3');

  const { ms, err } = await timed(() =>
    mixSession({ tracks, workDir: dir, outFile: out, durationMs: 50, channels: 1, mixTimeoutMs: 15_000 })
  );

  check('a track smaller than the pipe buffer still mixes', !err, err?.message ?? `${ms}ms`);
  check('...without waiting on the watchdog', ms < 10_000, `${ms}ms`);
  check('and produced a real mp3', fs.existsSync(out) && fs.statSync(out).size > 0,
    fs.existsSync(out) ? `${fs.statSync(out).size} bytes` : 'missing');

  await fsp.rm(dir, { recursive: true, force: true });
}

// ─── (c) finishRecording releases the slot and preserves raw audio ────────
//
// index.js can't be imported here to call finishRecording() directly - the
// bottom of the file runs main() (config validation, Discord login) as a
// side effect of import, which is exactly the kind of thing a unit test must
// not trigger. Instead this checks the invariant at the source level: that
// slot.finalising is cleared (and scheduleEvaluate() fired) BEFORE
// mixSession() is ever awaited, and that raw pcm is only deleted AFTER
// mixSession() has resolved - inside the same try, so a rejection jumps
// straight past that deletion into the existing catch block.
function testFinishRecordingSourceInvariant() {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const m = /async function finishRecording\(slot, reason\) \{[\s\S]*?\n\}\n/.exec(src);
  check('finishRecording() found in index.js', !!m);
  if (!m) return;
  const body = m[0];

  const releaseIdx = body.search(/slot\.finalising = false;\s*\n\s*scheduleEvaluate\(\);/);
  const mixCallIdx = body.indexOf('await mixSession(');
  const pcmDeleteIdx = body.search(/for \(const t of tracks\) await fs\.rm\(t\.file/);

  check('slot.finalising is released and scheduleEvaluate() called', releaseIdx !== -1);
  check('mixSession() is awaited', mixCallIdx !== -1);
  check(
    'the slot is freed BEFORE mixSession() runs (a hung/rejected mix cannot hold the slot)',
    releaseIdx !== -1 && mixCallIdx !== -1 && releaseIdx < mixCallIdx
  );
  check('raw per-speaker pcm is only deleted AFTER mixSession() resolves', pcmDeleteIdx !== -1 && pcmDeleteIdx > mixCallIdx);

  // The catch block that guards the mixSession()-and-onward work (the LAST
  // "} catch (err) {" in the function - there is an earlier, unrelated one
  // around session.stop() itself) must not delete session.dir or the raw
  // tracks - only log and announce, leaving everything on disk for a retry.
  const trimmed = body.trimEnd();
  const catchStart = trimmed.lastIndexOf('} catch (err) {');
  const hasOuterCatch = catchStart !== -1 && trimmed.endsWith('}');
  check('finishRecording has a catch block that logs and announces', hasOuterCatch);
  if (hasOuterCatch) {
    const catchBody = trimmed.slice(catchStart, -1); // drop the function's own closing brace
    check('the catch block does not delete the session directory', !/fs\.rm\(session\.dir/.test(catchBody));
    check('the catch block does not delete raw track files', !/fs\.rm\(t\.file/.test(catchBody));
  }
}

console.log('-- (a1) missing/corrupt source pcm --');
await testMissingSourceRejectsPromptly();
console.log('\n-- (a2) ffmpeg fails to spawn at all --');
await testFfmpegSpawnFailureRejectsPromptly();
console.log('\n-- (b) ffmpeg opens nothing and never exits --');
await testWatchdogKillsHungFfmpeg();
console.log('\n-- (d) corrupt burst index (NaN / negative / absurd offsets) --');
await testCorruptBurstIndex();
console.log('\n-- (e) corrupt durationMs --');
await testAbsurdDurationClamped();
console.log('\n-- (f) more speakers than the threadpool has threads --');
await testMoreTracksThanThreadpool();
console.log('\n-- (g) a track smaller than the pipe buffer --');
await testTrackSmallerThanPipeBuffer();
console.log('\n-- (c) finishRecording()/slot-release invariant --');
testFinishRecordingSourceInvariant();

console.log();
const code = failures > 0 ? 1 : 0;
if (failures > 0) console.log(`${failures} check(s) FAILED`);
else console.log('PASS - mixSession() always settles, kills a hung ffmpeg, and never touches raw audio on failure.');

// Belt and braces: every scenario above was sized to stay under a pipe's
// kernel buffer so nothing should be left blocked in the fs threadpool by
// this point (see the file banner) - but if that ever regresses, this
// guarantees the test run itself reports its result and ends, rather than
// silently hanging the way the original bug did.
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 3000).unref?.();
process.exit(code);
