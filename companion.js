// Screen-share capture companion. Runs on the machine that does the sharing.
//
// Discord will not give a bot access to video - not through any supported API -
// so the pixels have to be captured where they already exist: your own screen.
// This watches the bot's status endpoint, and when it reports that somebody has
// started sharing, it tells OBS to start recording. When the share (or the call)
// ends, it stops, renames the file to match the audio recording, and uploads it.
//
//   node --env-file=companion.env companion.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import OBSWebSocket from 'obs-websocket-js';

const cfg = {
  statusUrl: process.env.BOT_STATUS_URL ?? '',
  secret: process.env.COMPANION_SECRET ?? '',
  obsUrl: process.env.OBS_URL ?? 'ws://127.0.0.1:4455',
  obsPassword: process.env.OBS_PASSWORD ?? '',
  pollSeconds: Number(process.env.POLL_SECONDS ?? 4),
  rcloneRemote: process.env.RCLONE_REMOTE ?? '',
  rcloneExe: process.env.RCLONE_EXE ?? 'rclone',
  deleteAfterUpload: /^(1|true|yes|on)$/i.test(process.env.DELETE_AFTER_UPLOAD ?? ''),
};

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
  info: (m) => console.log(`${stamp()} ${m}`),
  warn: (m) => console.warn(`${stamp()} WARN ${m}`),
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
};

if (!cfg.statusUrl || !cfg.secret) {
  log.error('BOT_STATUS_URL and COMPANION_SECRET must both be set in companion.env');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── OBS ──────────────────────────────────────────────────────────────────

const obs = new OBSWebSocket();
let obsReady = false;

async function connectOBS() {
  if (obsReady) return true;
  try {
    await obs.connect(cfg.obsUrl, cfg.obsPassword || undefined);
    obsReady = true;
    log.info(`connected to OBS at ${cfg.obsUrl}`);
    return true;
  } catch (err) {
    obsReady = false;
    return false;
  }
}

obs.on('ConnectionClosed', () => {
  if (obsReady) log.warn('lost the OBS connection - will reconnect');
  obsReady = false;
});

async function obsRecording() {
  try {
    const { outputActive } = await obs.call('GetRecordStatus');
    return outputActive;
  } catch {
    obsReady = false;
    return false;
  }
}

// ─── the bot ──────────────────────────────────────────────────────────────

async function fetchState() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(cfg.statusUrl, {
      headers: { Authorization: `Bearer ${cfg.secret}` },
      signal: controller.signal,
    });
    if (res.status === 401) throw new Error('the bot rejected COMPANION_SECRET - the two must match');
    if (!res.ok) throw new Error(`status endpoint returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── upload ───────────────────────────────────────────────────────────────

function runRclone(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cfg.rcloneExe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString().slice(0, 2000)));
    proc.on('error', reject);
    proc.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`rclone exited ${c}: ${err.trim()}`))));
  });
}

async function fileForSession(rawPath, sessionId) {
  if (!rawPath) return null;
  const dir = path.dirname(rawPath);
  const ext = path.extname(rawPath) || '.mkv';
  const target = path.join(dir, `${sessionId}${ext}`);
  try {
    await fs.rename(rawPath, target);
    return target;
  } catch (err) {
    log.warn(`could not rename the recording (${err.message}) - keeping ${rawPath}`);
    return rawPath;
  }
}

async function upload(file, startedAt) {
  if (!cfg.rcloneRemote || !file) return;
  const when = startedAt ? new Date(startedAt) : new Date();
  const month = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
  const dest = `${cfg.rcloneRemote.replace(/\/+$/, '')}/${month}/${path.basename(file)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await runRclone(['copyto', file, dest, '--retries', '1', '--stats', '0']);
      log.info(`uploaded ${path.basename(file)}`);
      if (cfg.deleteAfterUpload) await fs.rm(file, { force: true });
      return;
    } catch (err) {
      log.warn(`upload attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await sleep(attempt * 10_000);
    }
  }
  log.error(`gave up uploading ${file} - it is still on disk`);
}

// ─── loop ─────────────────────────────────────────────────────────────────

let current = null;   // { sessionId, startedAt }
let lastError = '';

async function tick() {
  let state;
  try {
    state = await fetchState();
    lastError = '';
  } catch (err) {
    if (err.message !== lastError) {
      log.warn(`can't reach the bot: ${err.message}`);
      lastError = err.message;
    }
    return;
  }

  const want = !!state.shouldRecordVideo;

  if (want && !current) {
    if (!(await connectOBS())) {
      log.warn('someone is sharing but OBS is not reachable - is OBS running?');
      return;
    }
    if (await obsRecording()) {
      log.info('OBS was already recording - adopting it');
    } else {
      await obs.call('StartRecord');
    }
    current = { sessionId: state.sessionId ?? 'session', startedAt: state.startedAt };
    const who = (state.sharers ?? []).map((s) => s.name).join(', ') || 'the call';
    log.info(`recording video: ${who} in #${state.channel}`);
    return;
  }

  if (!want && current) {
    const { sessionId, startedAt } = current;
    current = null;
    try {
      const { outputPath } = await obs.call('StopRecord');
      log.info('video stopped');
      // OBS finishes writing the container a moment after it reports stopping.
      await sleep(2000);
      const file = await fileForSession(outputPath, sessionId);
      await upload(file, startedAt);
    } catch (err) {
      log.error(`failed to stop or save the video: ${err.message}`);
    }
  }
}

log.info(`watching ${cfg.statusUrl} every ${cfg.pollSeconds}s`);
log.info(cfg.rcloneRemote ? `uploads go to ${cfg.rcloneRemote}` : 'uploads disabled - files stay on this machine');

process.on('SIGINT', async () => {
  if (current) {
    log.info('stopping - saving the video in progress first');
    try { await obs.call('StopRecord'); } catch {}
  }
  process.exit(0);
});

for (;;) {
  await tick().catch((err) => log.error(err.stack ?? err.message));
  await sleep(Math.max(2, cfg.pollSeconds) * 1000);
}
