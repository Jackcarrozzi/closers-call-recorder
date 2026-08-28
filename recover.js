// Salvages raw per-speaker audio nobody ever finished with.
//
// The burst index - which bytes of speaker-*.pcm land where on the call's
// timeline - lives only in memory while a chunk is recording. It is written
// to disk as session.json when a chunk closes normally, and roughly every
// 30 seconds as checkpoint.json while it's still live (see session.js). A
// clean stop() always deletes speaker-*.pcm once it has been folded into the
// mp3, so any session directory that still HAS speaker-*.pcm files when this
// runs was not cleanly finished. That covers two different situations the
// same way:
//
//   - a crash or hard kill mid-recording, before stop() ever ran - only
//     checkpoint.json survives, accurate to within ~30s of when it died;
//   - the recording ended fine (session.json exists, complete and
//     authoritative) but mixSession() itself threw - ffmpeg missing, a
//     corrupt opus stream, disk trouble - and the process kept running.
//     finishRecording()'s own catch block logs that and moves on without
//     cleaning up, so this is the only thing that ever comes back for it.
//
// Either way, this runs once at boot, before the bot logs in or anything can
// start a new recording, so there is nothing live yet for it to race with -
// including a directory from the second case above, which a still-running
// process left untouched rather than retried until its next restart.

import fs from 'node:fs/promises';
import path from 'node:path';
import { SpeakerTrack } from './tracks.js';
import { mixSession } from './mixer.js';
import { uploadFiles } from './upload.js';
import { removeIfSpent } from './backlog.js';

/** The most complete index available for a directory: the real one if the
 *  chunk reached stop(), the last checkpoint otherwise. */
async function loadIndex(dir) {
  for (const name of ['session.json', 'checkpoint.json']) {
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      return { source: name, data: JSON.parse(raw) };
    } catch {
      // try the next one
    }
  }
  return null;
}

function trackEndMs(bursts) {
  if (!bursts?.length) return 0;
  const last = bursts[bursts.length - 1];
  return last.offsetMs + SpeakerTrack.msFor(last.bytes);
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {object} opts.log
 * @param {string} [opts.rcloneRemote]
 * @param {string} [opts.rcloneConfig]
 * @param {number} [opts.uploadRetries]
 * @param {boolean} [opts.deleteLocalAfterUpload]
 * @param {string} [opts.bitrate]
 * @param {number} [opts.channels]
 */
export async function recoverOrphanedSessions({
  dataDir,
  log,
  rcloneRemote,
  rcloneConfig,
  uploadRetries = 3,
  deleteLocalAfterUpload = false,
  bitrate = '64k',
  channels = 1,
}) {
  const root = path.join(dataDir, 'sessions');
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // nothing recorded yet
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);

    let files;
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const pcmFiles = files.filter((f) => f.isFile() && /^speaker-.+\.pcm$/.test(f.name));
    if (pcmFiles.length === 0) continue; // a clean stop() always removes these

    log.warn(`${entry.name}: found raw audio that was never folded into a finished recording - recovering`);

    const index = await loadIndex(dir);
    if (!index) {
      // No index survived at all - a crash before the very first checkpoint
      // had a chance to run (under 30s in). There is no record of where in
      // the call any of this speech belongs, so there is nothing safe to
      // reassemble. Leave it on disk untouched rather than guess.
      log.warn(`${entry.name}: no index (session.json or checkpoint.json) - leaving raw audio in place for manual review`);
      continue;
    }

    const tracks = [];
    for (const s of index.data.speakers ?? []) {
      if (!s.bursts?.length) continue;
      const file = path.join(dir, s.file);
      try {
        const stat = await fs.stat(file);
        if (stat.size === 0) continue;
      } catch {
        continue; // the pcm this entry points at is gone
      }
      tracks.push({ userId: s.userId, label: s.label, file, bursts: s.bursts });
    }

    if (tracks.length === 0) {
      log.warn(`${entry.name}: index had no usable speaker audio - nothing to recover`);
      continue;
    }

    const durationMs = Math.max(index.data.durationMs ?? 0, ...tracks.map((t) => trackEndMs(t.bursts)));
    const outFile = path.join(dir, `${entry.name}_recovered.mp3`);
    const partial = index.source === 'checkpoint.json';

    try {
      await mixSession({ tracks, workDir: dir, outFile, durationMs, bitrate, channels });
      log.warn(
        `${entry.name}: recovered ~${Math.round(durationMs / 1000)}s of audio from ` +
          `${partial
            ? 'a checkpoint (the process died mid-chunk - up to ~30s short of the real end)'
            : 'a complete index (the chunk finished, but its mix or upload never did)'
          } -> ${path.basename(outFile)}`
      );

      // These bytes are now inside the mp3. Only remove the ones that were
      // actually used - anything that failed to load above is left alone.
      for (const t of tracks) await fs.rm(t.file, { force: true }).catch(() => {});

      let uploaded = { uploaded: [], skipped: true };
      try {
        uploaded = await uploadFiles({
          files: [outFile],
          remote: rcloneRemote,
          rcloneConfig,
          startedAt: new Date(index.data.startedAt ?? Date.now()),
          retries: uploadRetries,
          log,
        });
      } catch (err) {
        log.warn(`${entry.name}: recovered file kept locally, upload failed: ${err.message}`);
      }

      if (deleteLocalAfterUpload && uploaded.uploaded.length >= 1) {
        // Only the file this pass produced and actually uploaded. Removing
        // the whole directory would take everything else in it with it, and
        // this pass uploaded none of that: a transcript, an earlier finished
        // mp3 whose own upload failed and which the backlog sweep has not got
        // to yet, or raw audio belonging to a speaker whose entry was missing
        // from the index and so was deliberately left alone above. The
        // directory itself goes only once nothing but bookkeeping is left.
        await fs.rm(outFile, { force: true }).catch(() => {});
        await removeIfSpent(dir);
      }
    } catch (err) {
      log.error(`${entry.name}: could not mix the recovered audio, leaving raw files in place: ${err.message}`);
    }
  }
}
