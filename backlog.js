// Retries finished recordings that were mixed but never made it to Drive.
//
// finishRecording() uploads its own output immediately after mixing, but if
// that upload exhausted its retries - a dead token, a network outage, an
// OAuth refresh token that quietly expired - the mp3 is left on disk with
// nothing left to retry it. This sweeps sessions/ for exactly that: a
// finished mp3 sitting next to no un-mixed raw audio, uploads it through the
// same rclone path, and deletes it locally under the same rule
// finishRecording already uses (DELETE_LOCAL_AFTER_UPLOAD, and only once it
// actually uploaded).
//
// Only ever looks at finished output: "*.mp3" and the "*.txt" transcript
// filed beside it - the same set finishRecording() hands to uploadFiles().
// mixSession() (and recover.js, which uses it) writes to "<name>.mp3.part"
// and renames to "<name>.mp3" only once ffmpeg has fully closed the file, so
// anything visible here as a bare "*.mp3" is already complete - a ".part"
// mid-mix is never matched. The mtime guard below is a second, independent
// layer on top of that, not the reason this is safe to run concurrently with
// a live recording.
//
// uploadFiles() itself (see upload.js) refuses to start a second upload of a
// path that's already mid-upload elsewhere, and finishRecording() holds its
// own output in that same set from the moment it is mixed right through to
// its own upload - so this can neither upload a file twice nor delete one out
// from under the call that is still working on it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadFiles } from './upload.js';

const MIN_AGE_MS = 5 * 60 * 1000; // belt-and-braces on top of the .part scheme above

const UPLOADABLE = /\.(mp3|txt)$/i;

// What is left in a session directory once everything anybody wants has gone:
// bookkeeping this process wrote for itself. A directory holding only these is
// spent and can be removed.
const INDEX_FILES = new Set(['session.json', 'checkpoint.json', 'checkpoint.json.tmp']);

/**
 * Remove a session directory once the only things left in it are the index
 * files above - never while any audio or transcript is still there. Shared
 * with recover.js so both cleanup paths obey exactly the same rule.
 */
export async function removeIfSpent(dir) {
  const left = await fs.readdir(dir).catch(() => null);
  if (!left) return;
  if (left.every((name) => INDEX_FILES.has(name))) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Session ids look like "2026-08-28_1603_CLOSERS" - recover back to a Date
 *  so a backlog file still files under the month it was actually recorded. */
function startedAtFor(sessionId) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})_/.exec(sessionId);
  if (!m) return new Date();
  const [, y, mo, d, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

// A sweep with a real backlog behind a slow or failing remote takes three
// attempts and two backoffs per directory, which passes fifteen minutes long
// before it passes a hundred directories. Without this the interval timer
// would start a second sweep on top of the first, then a third, each spawning
// its own rclone processes against the same files.
let sweeping = false;

export async function sweepBacklog(opts) {
  if (sweeping) {
    opts.log.info('a backlog sweep is still running - skipping this one');
    return;
  }
  sweeping = true;
  try {
    await runSweep(opts);
  } finally {
    sweeping = false;
  }
}

async function runSweep({
  dataDir,
  log,
  rcloneRemote,
  rcloneConfig,
  uploadRetries = 3,
  deleteLocalAfterUpload = false,
}) {
  if (!rcloneRemote) return; // nothing configured to upload to

  const root = path.join(dataDir, 'sessions');
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
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

    const finished = files.filter((f) => f.isFile() && UPLOADABLE.test(f.name));
    if (finished.length === 0) continue;

    const stale = [];
    for (const f of finished) {
      const full = path.join(dir, f.name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > MIN_AGE_MS) stale.push(full);
    }
    if (stale.length === 0) continue; // too fresh - could still be a live chunk's own upload

    let uploaded;
    try {
      uploaded = await uploadFiles({
        files: stale,
        remote: rcloneRemote,
        rcloneConfig,
        startedAt: startedAtFor(entry.name),
        retries: uploadRetries,
        log,
      });
    } catch (err) {
      log.warn(`${entry.name}: backlog upload failed, will retry next sweep: ${err.message}`);
      continue;
    }

    if (uploaded.uploaded.length) {
      log.info(`${entry.name}: uploaded ${uploaded.uploaded.length} backlog file(s) left by an earlier failed upload`);
    }

    if (deleteLocalAfterUpload && uploaded.uploaded.length >= stale.length) {
      // Only the files this sweep actually uploaded - not the whole
      // directory, which may still hold a not-yet-stale file or raw audio a
      // later recovery pass still needs.
      for (const f of stale) await fs.rm(f, { force: true }).catch(() => {});
      await removeIfSpent(dir);
    }
  }
}
