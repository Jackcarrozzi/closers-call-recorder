// Copies finished recordings to Google Drive (or any other rclone remote).

import { spawn } from 'node:child_process';
import path from 'node:path';

function runRclone(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('rclone', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (d) => (err += d.toString().slice(0, 4000)));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`rclone exited ${code}: ${err.trim()}`))
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Absolute file paths currently being handed to rclone by ANY caller in this
// process. A live finishRecording() and the backlog sweep (backlog.js) can
// both decide the same finished mp3 needs uploading at once; sharing one Set
// here - rather than threading a lock through every caller - is what stops
// that turning into two rclone processes racing on the same file. Whichever
// call reaches a path first uploads it; the other skips that path and simply
// doesn't count it as uploaded, so it isn't deleted locally either - it just
// gets picked up again next time around, uploaded exactly once either way.
const inFlight = new Set();

/**
 * Claims paths in that same set on behalf of a caller that has finished
 * writing them but is not ready to upload them yet, and hands back the
 * release.
 *
 * finishRecording() needs this across transcription: on a long call that can
 * run well past the age the backlog sweep uses to decide a file has been
 * abandoned, and with no claim held the sweep would upload the mp3 and - under
 * DELETE_LOCAL_AFTER_UPLOAD - delete it out from under the call still working
 * on it, whose own upload then fails on a file that is no longer there and
 * reports a Drive outage that never happened.
 *
 * Only the paths this call actually added are released, so two overlapping
 * holds on the same path can never release each other's.
 */
export function reserveUploads(files) {
  const mine = files.filter((f) => !inFlight.has(f));
  for (const f of mine) inFlight.add(f);
  return () => {
    for (const f of mine) inFlight.delete(f);
    mine.length = 0; // releasing twice must not free a later claim on the same path
  };
}

/**
 * Uploads files into <remote>/<YYYY-MM>/, which is what keeps a year of calls
 * browsable instead of one folder with two thousand items in it.
 */
export async function uploadFiles({ files, remote, rcloneConfig, startedAt, retries = 3, log }) {
  if (!remote) {
    log.info('no RCLONE_REMOTE set - leaving the recording on disk');
    return { uploaded: [], skipped: true };
  }

  const month = `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, '0')}`;
  const env = rcloneConfig ? { RCLONE_CONFIG: rcloneConfig } : {};
  const uploaded = [];
  const claimed = [];

  try {
    for (const file of files) {
      if (inFlight.has(file)) {
        log.info(`${path.basename(file)} is already being uploaded elsewhere - leaving it for that to finish`);
        continue;
      }
      inFlight.add(file);
      claimed.push(file);

      const dest = `${remote.replace(/\/+$/, '')}/${month}/${path.basename(file)}`;
      let lastErr;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          await runRclone(
            ['copyto', file, dest, '--retries', '1', '--low-level-retries', '3', '--stats', '0'],
            env
          );
          uploaded.push(dest);
          log.info(`uploaded ${path.basename(file)} -> ${dest}`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          log.warn(`upload attempt ${attempt}/${retries} failed: ${err.message}`);
          if (attempt < retries) await sleep(attempt * 5000);
        }
      }
      if (lastErr) throw lastErr;
    }
  } finally {
    for (const file of claimed) inFlight.delete(file);
  }

  return { uploaded, skipped: false };
}

export async function checkRemote({ remote, rcloneConfig }) {
  if (!remote) return { ok: true, note: 'uploads disabled' };
  try {
    const env = rcloneConfig ? { RCLONE_CONFIG: rcloneConfig } : {};
    await runRclone(['lsd', remote.split(':')[0] + ':', '--max-depth', '1'], env);
    return { ok: true };
  } catch (err) {
    return { ok: false, note: err.message };
  }
}
