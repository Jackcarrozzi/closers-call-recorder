// Turns the condensed per-speaker files back into a single, correctly-timed mp3.
//
// Rather than writing multi-gigabyte padded PCM files to disk, we hand ffmpeg a
// named pipe per speaker and stream the silence in as it reads. Peak disk usage
// stays at "the speech itself", no matter how long the call ran.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PCM } from './config.js';
import { SpeakerTrack } from './tracks.js';

const SILENCE_CHUNK = Buffer.alloc(PCM.bytesPerSecond); // 1s of silence, reused

// Flat and generous rather than clever: a normal 2h chunk mixes down in well
// under two minutes on this host, so 10 minutes is a huge margin, not a tight
// budget. What matters is that it is finite - see mixSession() below for what
// this is guarding against.
const MIX_TIMEOUT_MS = 10 * 60 * 1000;

// A guard rail, not a policy knob: MAX_SESSION_HOURS caps a chunk at 6h by
// default, so nothing legitimate ever reaches a quarter of this. It exists
// because durationMs and burst offsets are not always ours: recover.js builds
// them straight out of a session.json/checkpoint.json that may have been
// truncated or corrupted by the very crash it is recovering from, and one
// absurd offset ("this speech starts at t+31,000 years") turns the silence
// padding below into an unbounded write loop that no watchdog can stop -
// the mix rejects on schedule, but the abandoned feed keeps generating
// silence forever. Anything past this is corruption, so it is clamped.
const MAX_MIX_MS = 24 * 60 * 60 * 1000;

/** Corruption-proof ms: never NaN, never negative, never absurd. */
function saneMs(ms) {
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_MIX_MS) : 0;
}

// How long a feed will wait for ffmpeg to open its input before giving up.
// ffmpeg opens all of its inputs during start-up, in milliseconds; this only
// has to be longer than a badly overloaded host's process start-up, and
// shorter than the watchdog, so that "ffmpeg never came" reports itself
// rather than surfacing as a generic timeout ten minutes later.
const FIFO_READER_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until ffmpeg has opened the read end of this fifo, and returns an
 * open write fd as the proof of it.
 *
 * This is the handshake the old write-only open() used to give us for free,
 * minus the part that caused the incident. `open(fifo, O_WRONLY)` blocks
 * until a reader arrives - on a libuv threadpool worker that nothing can
 * ever cancel if no reader is coming. Adding O_NONBLOCK turns exactly that
 * wait into an immediate ENXIO ("no reader yet") which we can simply retry,
 * so the wait happens in JS, on a timer we control, instead of inside an
 * uninterruptible syscall. A reader still blocked inside its own open()
 * already counts, which is what lets this rendezvous with ffmpeg at all.
 *
 * openSync is deliberate: with O_NONBLOCK the call cannot block, so it costs
 * nothing to run on the main thread and never touches the threadpool.
 */
async function waitForReader(fifoPath, abort) {
  const deadline = Date.now() + FIFO_READER_TIMEOUT_MS;
  for (;;) {
    try {
      return fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (err) {
      if (err.code !== 'ENXIO') throw err; // a real error, not "no reader yet"
      if (abort.stop) throw new Error(`mix aborted before ffmpeg opened ${path.basename(fifoPath)}`);
      if (Date.now() >= deadline) {
        throw new Error(
          `ffmpeg never opened ${path.basename(fifoPath)} within ${FIFO_READER_TIMEOUT_MS / 1000}s`
        );
      }
      await sleep(5);
    }
  }
}

export class MixTimeoutError extends Error {
  constructor(ms) {
    super(
      `mix did not finish within ${Math.round(ms / 1000)}s (ffmpeg or a feed got stuck) - ` +
        `raw audio and session.json were left in place for a manual look`
    );
    this.name = 'MixTimeoutError';
  }
}

/** True once the child has actually exited or been signalled - safe to call kill() on repeatedly. */
function ffmpegIsDone(ffmpeg) {
  return ffmpeg.exitCode !== null || ffmpeg.signalCode !== null;
}

/** Idempotent: never throws, safe to call whether or not ffmpeg is still alive. */
function killFfmpeg(ffmpeg) {
  if (ffmpegIsDone(ffmpeg)) return;
  try {
    ffmpeg.kill('SIGKILL');
  } catch {}
}

/**
 * A write stream's 'error' event, if nothing is listening for it, is an
 * uncaught exception that takes the whole process down - and stream.write()
 * returning true (no backpressure) skips attaching any listener at all
 * below, so a fifo whose reader (ffmpeg) has already died can still kill us
 * on a write that never even hit the backpressure branch. This is the one
 * listener that always exists, for the life of the stream, so that can never
 * happen; it just remembers the error so the next write - or this one, if
 * it's already in flight - can fail the feed cleanly instead.
 */
function armFeedErrors(stream) {
  stream.on('error', (err) => {
    if (!stream.feedError) stream.feedError = err;
  });
}

function writeAsync(stream, buf) {
  if (stream.feedError) return Promise.reject(stream.feedError);
  return new Promise((resolve, reject) => {
    if (stream.write(buf)) return resolve();
    // Per-write, but always removed on settling either way - unlike a bare
    // .once('error', reject) on every backpressured write, this can't pile
    // up listeners over a long call's worth of writes.
    const onDrain = () => settle(resolve);
    const onError = (err) => settle(() => reject(err));
    function settle(fn) {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      fn();
    }
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function writeSilence(stream, bytes, abort) {
  let left = bytes;
  while (left > 0 && !abort.stop) {
    const n = Math.min(left, SILENCE_CHUNK.length);
    await writeAsync(stream, n === SILENCE_CHUNK.length ? SILENCE_CHUNK : SILENCE_CHUNK.subarray(0, n));
    left -= n;
  }
}

/**
 * Close a feed's fifo write end, whether or not it ever wrote anything.
 *
 * Waits for 'close', not 'finish': 'finish' only means "the last write was
 * handed over", and the fd is still open at that point. ffmpeg's EOF on this
 * input is precisely the moment this fd closes, so resolving on 'finish'
 * would report a feed as finished while ffmpeg was still waiting on it.
 * 'error' is accepted as an ending too - a feed whose reader died (EPIPE)
 * must settle here rather than wait for a clean finish that cannot happen.
 */
async function closeFeedStream(out) {
  if (out.destroyed) return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      out.off('close', done);
      out.off('error', done);
      resolve();
    };
    out.once('close', done);
    out.once('error', done);
    if (out.feedError) out.destroy();
    else out.end();
  });
}

/**
 * Streams one speaker's timeline into a fifo: silence, speech, silence, speech...
 *
 * `abort` is the shared stop-flag mixSession() sets once it has settled. A
 * feed that the watchdog abandoned is still a running loop with a fifo write
 * end open; without this it would keep generating audio for a reader that is
 * never coming, for the life of the process. Checked at every loop boundary
 * so an abandoned feed unwinds to its own finally (closing the fd) instead.
 */
async function feedTrack(track, fifoPath, durationMs, abort) {
  // The write end of the fifo, acquired and then driven in a way that never
  // touches libuv's threadpool. Both halves of that matter, and the original
  // incident was one of each:
  //
  // 1. THE OPEN. `fs.createWriteStream`'s default flags are write-only, and
  //    `open(fifo, O_WRONLY)` blocks until a reader opens the other end - on
  //    a threadpool worker, inside a syscall nothing in JS can cancel. If no
  //    reader is ever coming, that worker is gone for the life of the
  //    process. waitForReader() does the same rendezvous with O_NONBLOCK, so
  //    the waiting happens on a JS timer instead of inside the kernel.
  //
  // 2. THE WRITES. This is the half that actually deadlocked production, and
  //    the half a read-write open does nothing about. `fs.WriteStream` sends
  //    every write() through the threadpool too, and a write to a fifo whose
  //    64KB kernel buffer is full blocks there until the reader drains it.
  //    ffmpeg opens its inputs one after another, and does not start draining
  //    any of them until it has opened them all - so while it is still
  //    starting up, each feed that has already rendezvoused fills its pipe
  //    and parks a worker. Once as many feeds are parked as the pool has
  //    threads, the write that would unblock ffmpeg's next input has no
  //    worker left to run on, and ffmpeg is waiting on exactly that write:
  //    a circular wait, permanent, and not even process exit survives it.
  //    Six speakers against the default four-thread pool is precisely the
  //    incident. Raising UV_THREADPOOL_SIZE only moves the cliff.
  //
  // A net.Socket over the same fd removes the cliff instead of moving it:
  // libuv drives pipe fds with epoll, so a full pipe costs a poll
  // registration rather than a blocked thread, and no number of speakers can
  // exhaust anything. It is also the only version that finds out when ffmpeg
  // dies - a blocked threadpool write just sits there, whereas this raises
  // EPIPE and fails the feed properly.
  //
  // The fd from waitForReader() is already O_WRONLY|O_NONBLOCK, which is
  // exactly what a Socket wants. Nothing may await between acquiring it and
  // handing it over, or a throw in between would leak it.
  const fd = await waitForReader(fifoPath, abort);
  const out = new net.Socket({ fd, readable: false, writable: true });
  armFeedErrors(out); // before anything can write to it - see armFeedErrors()
  // Registered so mixSession() can destroy this stream from the outside on a
  // failure: the abort flag alone can't free a feed parked on a 'drain' that
  // is never coming, and destroying it settles that await so the feed can
  // unwind and close its fd.
  abort.streams.add(out);

  // Everything below - including opening the source pcm - is inside the
  // try/finally on purpose. fsp.open() throwing (a missing or unreadable
  // pcm file) used to happen before the try started, which skipped the
  // finally entirely and left `out`'s fifo write end open forever: ffmpeg
  // would then block reading it with no EOF ever coming. Every exit path
  // from here must close `out`.
  let src = null;
  try {
    src = await fsp.open(track.file, 'r');
    let readPos = 0;
    let written = 0;
    // Nothing in this feed may ever write past the end of the call. A burst
    // offset is only as trustworthy as the index it came from - see
    // MAX_MIX_MS - and bytesFor() happily turns a corrupt offset into a
    // silence run of any size. Every target below is clamped to this.
    const totalBytes = SpeakerTrack.bytesFor(saneMs(durationMs));

    for (const burst of track.bursts) {
      if (abort.stop) break;
      // A NaN/absent/negative offset yields NaN or 0 here, and neither is
      // > written, so a corrupt burst silently loses its padding rather than
      // throwing or running away - the speech itself still gets written.
      const target = Math.min(SpeakerTrack.bytesFor(burst.offsetMs), totalBytes);
      if (target > written) {
        await writeSilence(out, target - written, abort);
        written = target;
      }
      // A burst whose byte count is corrupt (negative, NaN, absent) must not
      // reach Buffer.allocUnsafe(), which throws synchronously on a bad
      // size - clamp instead of crashing the whole mix over one bad entry.
      let left = Number.isFinite(burst.bytes) && burst.bytes > 0 ? burst.bytes : 0;
      while (left > 0 && !abort.stop) {
        const size = Math.min(left, 1 << 20);
        const buf = Buffer.allocUnsafe(size);
        const { bytesRead } = await src.read(buf, 0, size, readPos);
        // A burst index pointing past the end of a truncated pcm file (a
        // decoder that choked mid-capture, say) ends here rather than
        // spinning: whatever wasn't actually recorded is silence.
        if (bytesRead === 0) { left = 0; break; }
        readPos += bytesRead;
        left -= bytesRead;
        written += bytesRead;
        await writeAsync(out, buf.subarray(0, bytesRead));
      }
    }
    if (!abort.stop && totalBytes > written) await writeSilence(out, totalBytes - written, abort);
  } finally {
    if (src) await src.close().catch(() => {});
    await closeFeedStream(out);
    abort.streams.delete(out);
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
 * @param {number} [opts.mixTimeoutMs]   hard cap on the whole mix; test-only override,
 *                                       production callers should leave this at the default
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
  mixTimeoutMs = MIX_TIMEOUT_MS,
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

  // Shared with every feed: the stop-flag and the set of live fifo write
  // streams, so a mix that gives up can also tell its feeds to give up
  // instead of leaving them writing into a pipe nobody will ever read again.
  const abort = { stop: false, streams: new Set() };
  // Each feed rendezvouses with ffmpeg on its own fifo before it writes
  // anything (see feedTrack), so ffmpeg is always already reading an input
  // by the time that input's data - and eventually its EOF - arrives.
  const feeds = tracks.map((t, i) => feedTrack(t, fifos[i], durationMs, abort));

  // The watchdog: whatever else is or isn't fixed above, mixSession() must
  // always settle. Promise.race, not just Promise.all, is what guarantees
  // that - the race settles the moment ONE side does, and simply abandons
  // the other. So even if some corner nothing above anticipated leaves
  // ffmpeg or a feed stuck forever (a wedged filtergraph, a slow disk, a
  // future bug), this mix still fails loudly within mixTimeoutMs instead of
  // holding a recording slot hostage indefinitely.
  let watchdogTimer;
  const watchdog = new Promise((_, reject) => {
    watchdogTimer = setTimeout(() => reject(new MixTimeoutError(mixTimeoutMs)), mixTimeoutMs);
    watchdogTimer.unref?.();
  });

  try {
    await Promise.race([Promise.all([done, ...feeds]), watchdog]);
    // Only now does ffmpeg's own exit code say the file is actually
    // complete - rename it into the name everything else looks for.
    await fsp.rename(outPart, outFile);
    for (let i = 0; i < perSpeaker.length; i++) await fsp.rename(perSpeakerParts[i], perSpeaker[i].file);
  } catch (err) {
    // Whether this is the watchdog firing or a feed/ffmpeg error the race
    // never got to see resolve first, ffmpeg must not be left running: a
    // still-alive ffmpeg holds fifo read ends open, which is exactly the
    // kind of half-finished state that got us here in the first place, and
    // an orphaned process is a leak on every failed mix otherwise.
    killFfmpeg(ffmpeg);
    // Feeds this mix has just abandoned must stop too. The flag stops their
    // loops at the next boundary; destroying the stream settles a feed that
    // is parked on a 'drain' which - now that ffmpeg is dead - would never
    // come. Both are needed, and both are safe: every feed promise already
    // has a rejection handler attached by the Promise.all above, so the
    // errors this raises in abandoned feeds can't surface as unhandled
    // rejections. (A write already handed to the kernel still can't be
    // cancelled - see "Residual risk" in the patch report - but nothing new
    // is queued behind it, and the fd is released as soon as it returns.)
    abort.stop = true;
    for (const s of abort.streams) {
      try {
        s.destroy(new Error('mix aborted'));
      } catch {}
    }
    throw err;
  } finally {
    abort.stop = true;
    clearTimeout(watchdogTimer);
    // The raw pcm this mix was reading from is never touched here, on any
    // path - success or failure. Callers (finishRecording, recover.js) only
    // delete it after mixSession() has actually resolved, so a timeout or
    // any other rejection always leaves it and session.json/checkpoint.json
    // in place for a retry or manual rescue.
    await fsp.rm(fifoDir, { recursive: true, force: true }).catch(() => {});
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
