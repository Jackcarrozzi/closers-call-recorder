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

  for (const file of files) {
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
