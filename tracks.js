// Per-speaker audio capture.
//
// Discord only sends us audio while someone is actually talking, so a naive
// recording of the packets would squash a two-hour call into four minutes of
// overlapping speech. We therefore store two things per speaker:
//
//   1. a "condensed" PCM file containing nothing but their speech, and
//   2. a burst index recording where in the call each piece of speech belongs.
//
// The mixer later replays those files against a real clock, inserting silence
// where the index says there was silence. Storing it this way means an empty
// six-hour channel costs a few kilobytes instead of four gigabytes.

import fs from 'node:fs';
import path from 'node:path';
import { PCM } from './config.js';

// A gap longer than this between packets is treated as the end of one burst of
// speech and the start of another.
const BURST_GAP_MS = 150;

export class SpeakerTrack {
  constructor({ userId, label, dir, sessionStart }) {
    this.userId = userId;
    this.label = label;
    this.sessionStart = sessionStart;
    this.file = path.join(dir, `speaker-${userId}.pcm`);
    this.stream = fs.createWriteStream(this.file);
    this.bursts = []; // [{ offsetMs, bytes }]
    this.current = null;
    this.totalBytes = 0;
    this.lastChunkAt = 0;
    this.closed = false;
  }

  /** Bytes of 48kHz stereo s16le audio -> milliseconds. */
  static msFor(bytes) {
    return (bytes / PCM.bytesPerSecond) * 1000;
  }

  /** Milliseconds -> a whole number of samples' worth of bytes. */
  static bytesFor(ms) {
    const frameSize = PCM.channels * PCM.bytesPerSample;
    const raw = Math.round((ms / 1000) * PCM.bytesPerSecond);
    return Math.max(0, raw - (raw % frameSize));
  }

  write(chunk, now = Date.now()) {
    if (this.closed || chunk.length === 0) return;

    const chunkMs = SpeakerTrack.msFor(chunk.length);
    const gap = now - this.lastChunkAt;

    if (!this.current || gap > BURST_GAP_MS) {
      // Start a new burst. The audio in this chunk was captured over the
      // window that just ended, so back-date it by the chunk's own duration.
      const offsetMs = Math.max(0, now - this.sessionStart - chunkMs);
      this.current = { offsetMs, bytes: 0 };
      this.bursts.push(this.current);
    }

    this.current.bytes += chunk.length;
    this.totalBytes += chunk.length;
    this.lastChunkAt = now;
    this.stream.write(chunk);
  }

  /** Wall-clock position, in ms, where this speaker's audio stops. */
  endMs() {
    if (this.bursts.length === 0) return 0;
    const last = this.bursts[this.bursts.length - 1];
    return last.offsetMs + SpeakerTrack.msFor(last.bytes);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.current = null;
    await new Promise((resolve) => this.stream.end(resolve));
  }

  /** Serialisable summary, written next to the audio for the mixer and for debugging. */
  toJSON() {
    return {
      userId: this.userId,
      label: this.label,
      file: path.basename(this.file),
      totalBytes: this.totalBytes,
      speechMs: Math.round(SpeakerTrack.msFor(this.totalBytes)),
      endMs: Math.round(this.endMs()),
      bursts: this.bursts.map((b) => ({ offsetMs: Math.round(b.offsetMs), bytes: b.bytes })),
    };
  }
}
