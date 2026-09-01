// Closers Call Recorder
//
// Watches a set of Discord voice channels. The moment a real person joins one,
// a bot slips in and starts recording; when the last person leaves, it mixes the
// call down to a single mp3, optionally transcribes it, and files it in Drive.
// Nobody has to be signed in, and nobody has to remember to press anything.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, GatewayIntentBits, ChannelType, EmbedBuilder } from 'discord.js';
import { config, validate } from './config.js';
import { logger } from './logger.js';
import { RecordingSession } from './session.js';
import { mixSession } from './mixer.js';
import { uploadFiles, checkRemote, reserveUploads } from './upload.js';
import { transcribeSession } from './transcribe.js';
import { startStatusServer } from './status-server.js';
import { recoverOrphanedSessions } from './recover.js';
import { sweepBacklog } from './backlog.js';
import { generateDependencyReport } from '@discordjs/voice';

const log = logger;

// ─── slots ────────────────────────────────────────────────────────────────
// A single bot user can only hold one voice connection per server, so each
// extra token buys one more call we can record at the same time.

class Slot {
  constructor(index, token) {
    this.index = index;
    this.token = token;
    this.log = log.child(`bot${index + 1}`);
    this.session = null;
    this.finalising = false;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
      ],
    });
  }

  get busy() {
    return this.session !== null || this.finalising;
  }
}

const slots = config.tokens.map((token, i) => new Slot(i, token));
const graceTimers = new Map(); // channelId -> timeout
const joinCooldown = new Map(); // channelId -> ms timestamp; set after a failed join
const joinRounds = new Map(); // channelId -> how many times joining has failed
const abandonedUntil = new Map(); // channelId -> ms timestamp we won't try again before
const joinInFlight = new Set(); // channelIds we are mid-join on, right now
// A failing join is visible in Discord: the bot appears in the channel, sits
// there, and vanishes. Retrying that forever is worse than not recording, so
// the budget is fixed and small. Two tries per attempt, two attempts total,
// widening pauses between them, and then the channel is abandoned for an
// hour - long enough that a transient permissions glitch or a Discord outage
// isn't retried into the ground, short enough that it heals itself without
// anyone having to redeploy. Four appearances, worst case, then an hour of
// silence, then a fresh round of attempts.
const JOIN_ATTEMPTS = 2;
const MAX_JOIN_ROUNDS = 2;
const JOIN_BACKOFF_MS = [60_000, 300_000];
const ABANDON_MS = 60 * 60 * 1000;
const IDLE_SWEEP_MS = 15_000;

// Running out of disk mid-call is the one failure that loses audio outright, so
// it is guarded by measurement rather than by arithmetic about how much people
// talk. Speech is stored uncompressed while a call is live - roughly 100 MB per
// hour per person actually speaking - and only shrinks to an mp3 at the end.
// Three thresholds, each one cheaper than the one below it:
const DISK_CHECK_MS = 30_000;
const DISK_WARN_BYTES = 2_500_000_000; // start saying so, early and clearly
const DISK_CUT_BYTES = 1_500_000_000; // cut the chunk early and compress it now
const DISK_PRUNE_BYTES = 800_000_000; // only with PRUNE_WHEN_FULL - off by default
const DISK_STOP_BYTES = 250_000_000; // refuse to start anything new
let diskPaused = false;
let lastDiskWarn = 0;
let lastPauseWarn = 0;
let lastUploadFailWarn = 0;
let evaluateQueued = false;

const BACKLOG_SWEEP_MS = 15 * 60 * 1000;

// What /health answers with. A gateway resume - which discord.js does on its
// own, routinely - takes client.isReady() false for a few seconds while the
// recorder carries on recording perfectly well. Reporting "down" for that is
// a false alarm for whatever is watching the endpoint, so a drop is only
// reported once it has outlasted a resume. A revoked token or a genuinely
// stuck gateway lasts far longer than this and is still reported.
const READY_GRACE_MS = 2 * 60 * 1000;
let lastGatewayReadyMs = 0;

/**
 * True when at least one bot slot is logged in with its gateway up - or was,
 * recently enough that this is a reconnect rather than an outage. Sampled on
 * the idle sweep as well as on each /health request, so the grace is measured
 * against real time rather than against how often anyone happens to ask.
 */
function gatewayReady() {
  if (slots.some((s) => s.client.isReady())) {
    lastGatewayReadyMs = Date.now();
    return true;
  }
  // Never up at all yet: still starting, or every login failed. Not ready,
  // and no grace to extend - this is exactly what a readiness probe is for.
  if (!lastGatewayReadyMs) return false;
  return Date.now() - lastGatewayReadyMs < READY_GRACE_MS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function channelLabel(guild, id) {
  const ch = guild.channels.cache.get(id);
  return ch ? `#${ch.name}` : id;
}

/**
 * Leave voice the way a real client does, over the gateway.
 *
 * This is the fix for the join that dies in "signalling". A killed or
 * redeployed container leaves Discord believing the bot is still sitting in the
 * channel. Asking to join a channel it already has us in changes nothing, so it
 * never replies with a voice server, and the handshake waits for an answer that
 * is never coming. Op 4 with a null channel is the only way to clear that.
 *
 * It is sent unconditionally rather than only when our cache says we are stuck,
 * because that cache being a step behind is one of the ways we got here.
 * Unlike GuildMember#disconnect() this is not a moderation action, so it needs
 * no Move Members permission - which the bot does not have.
 */
async function leaveVoice(guild, log) {
  const held = guild.members.me?.voice?.channelId ?? null;
  if (held) log.warn(`clearing our leftover voice session in ${channelLabel(guild, held)}`);

  try {
    guild.shard.send({
      op: 4,
      d: { guild_id: guild.id, channel_id: null, self_mute: false, self_deaf: false },
    });
  } catch (err) {
    log.warn(`could not send the voice leave: ${err.message}`);
    return false;
  }

  if (!held) {
    await sleep(250); // let it reach Discord before we ask to join again
    return false;
  }

  // Wait for Discord to confirm instead of guessing at a delay.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!guild.members.me?.voice?.channelId) {
      log.info('leftover voice session cleared');
      return true;
    }
  }
  log.warn('Discord did not confirm the leave within 5s - trying the join anyway');
  return true;
}

// ─── channel matching ─────────────────────────────────────────────────────

function isWatched(channel) {
  if (!channel) return false;
  if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
    return false;
  }
  if (config.guildId && channel.guild.id !== config.guildId) return false;

  if (config.watchChannelIds.includes(channel.id)) return true;

  const name = channel.name.toLowerCase();
  if (config.watchChannelNames.includes(name)) return true;

  const category = channel.parent?.name?.toLowerCase();
  if (category && config.watchCategoryNames.includes(category)) return true;

  // Being strict here costs more than it's worth. "Closers" is just as likely
  // to be the name of the channel as the name of the category above it, and
  // getting that wrong looks exactly like a broken bot. Match either.
  if (config.watchCategoryNames.includes(name)) return true;

  return false;
}

function watchedChannels() {
  const seen = new Map();
  for (const slot of slots) {
    for (const guild of slot.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (isWatched(channel)) seen.set(channel.id, channel);
      }
    }
  }
  return [...seen.values()];
}

function humansIn(channel) {
  return channel.members.filter((m) => !(config.ignoreBots && m.user.bot)).size;
}

/**
 * Everyone in the channel with a screen share or camera live. Discord tells us
 * that this is happening; it does not let bots see the video itself.
 */
function sharersIn(channel) {
  if (!channel) return [];
  return [...channel.members.values()]
    .filter((m) => !m.user.bot && (m.voice?.streaming || m.voice?.selfVideo))
    .map((m) => ({ id: m.id, name: m.displayName, screen: !!m.voice?.streaming, camera: !!m.voice?.selfVideo }));
}

function slotRecording(channelId) {
  return slots.find((s) => s.session && s.session.channel.id === channelId) ?? null;
}

/** A slot that is free and whose bot is actually a member of this guild. */
function freeSlotFor(guildId) {
  return slots.find((s) => !s.busy && s.client.guilds.cache.has(guildId)) ?? null;
}

// ─── keeping the disk from ever filling ───────────────────────────────────

async function freeBytes() {
  try {
    const st = await fs.statfs(config.dataDir);
    return st.bavail * st.bsize;
  } catch {
    return Number.POSITIVE_INFINITY; // never let a failed check stop a recording
  }
}

function human(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** Finished sessions, oldest first. A live session's own directory is never touched. */
async function finishedSessionDirs() {
  const root = path.join(config.dataDir, 'sessions');
  const live = new Set(slots.filter((s) => s.session).map((s) => s.session.dir));
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    if (live.has(dir)) continue;
    const stat = await fs.stat(dir).catch(() => null);
    if (stat) dirs.push({ dir, name: e.name, mtimeMs: stat.mtimeMs });
  }
  return dirs.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function checkDisk() {
  const free = await freeBytes();
  if (!Number.isFinite(free)) return;

  // 1. Cheapest lever, and it loses nothing: end the chunk now. The speech on
  //    disk is uncompressed, so finishing it turns gigabytes into megabytes and
  //    the call carries straight on in a new chunk.
  if (free < DISK_CUT_BYTES) {
    // Only cut a chunk with something in it. Without this, a disk that stays
    // full would end the call every 30 seconds and shred it into slivers, each
    // one short enough to be thrown away as too brief to keep.
    const active = slots.filter((s) => s.session && s.session.durationMs > 120_000);
    if (active.length) {
      log.warn(`only ${human(free)} free - closing the current chunk early to reclaim space`);
      for (const slot of active) {
        finishRecording(slot, 'low disk space').catch((err) => log.error(err.message));
      }
    }
  }

  // 2. Getting tight. Say so, early and repeatedly, and delete nothing. A
  //    recording nobody has collected yet is not something to trade away for
  //    room; that decision belongs to whoever owns the calls.
  if (free < DISK_WARN_BYTES && Date.now() - lastDiskWarn > 6 * 3600_000) {
    lastDiskWarn = Date.now();
    const days = Math.max(0, Math.floor((free - DISK_STOP_BYTES) / 300_000_000));
    log.warn(`disk down to ${human(free)} free - roughly ${days} more day(s) of recording`);
    await announce(null, {
      title: 'Recorder is running low on space',
      description:
        `${human(free)} left on the server, roughly **${days} more day(s)** of recording at ` +
        `ten hours a day.\nNothing has been deleted and nothing will be. Finish the Google Drive ` +
        `setup and finished calls will clear themselves off the server automatically.`,
      color: 0xd9822b,
    }).catch(() => {});
  }

  // 3. Deleting the oldest calls, only if someone deliberately turned it on.
  if (free < DISK_PRUNE_BYTES && config.pruneWhenFull) {
    const dirs = await finishedSessionDirs();
    let reclaimedFrom = [];
    for (const d of dirs) {
      if ((await freeBytes()) >= DISK_PRUNE_BYTES) break;
      await fs.rm(d.dir, { recursive: true, force: true }).catch(() => {});
      reclaimedFrom.push(d.name);
    }
    if (reclaimedFrom.length) {
      log.warn(`deleted ${reclaimedFrom.length} old recording(s) to free space: ${reclaimedFrom.join(', ')}`);
      if (Date.now() - lastDiskWarn > 3600_000) {
        lastDiskWarn = Date.now();
        await announce(null, {
          title: 'Deleted old recordings to make room',
          description:
            `The recorder was down to ${human(free)} of disk, so it removed the ` +
            `${reclaimedFrom.length} oldest recording(s). Set up the Drive upload and finished ` +
            `calls will clear themselves off the server instead.`,
          color: 0xd9822b,
        }).catch(() => {});
      }
    }
  }

  // 4. Full. Stop starting new calls rather than delete old ones or write a
  //    broken file. This is the deliberate end of the line, and it is loud.
  const now = await freeBytes();
  const shouldPause = now < DISK_STOP_BYTES;
  if (shouldPause && !diskPaused) {
    log.error(`only ${human(now)} free - not starting new recordings until there is room`);
  } else if (!shouldPause && diskPaused) {
    log.info(`disk recovered (${human(now)} free) - recording again`);
    await announce(null, {
      title: 'Recording again',
      description: `There is ${human(now)} of room on the server, so recording has resumed.`,
      color: 0x2f6b4f,
    }).catch(() => {});
  }
  if (shouldPause && Date.now() - lastPauseWarn > 3600_000) {
    lastPauseWarn = Date.now();
    await announce(null, {
      title: 'RECORDING STOPPED - the server is full',
      description:
        `Only ${human(now)} left, and nothing is being deleted, so new calls are **not** being ` +
        `recorded. Every recording made so far is safe on the server.\nFinish the Google Drive ` +
        `setup, or pull the files off, and recording restarts on its own within a minute.`,
      color: 0xcc3333,
    }).catch(() => {});
  }
  diskPaused = shouldPause;
}

// ─── the loop ─────────────────────────────────────────────────────────────

function scheduleEvaluate() {
  if (evaluateQueued) return;
  evaluateQueued = true;
  setTimeout(() => {
    evaluateQueued = false;
    evaluate().catch((err) => log.error(`evaluate failed: ${err.stack ?? err.message}`));
  }, 400);
}

async function evaluate() {
  for (const channel of watchedChannels()) {
    const until = abandonedUntil.get(channel.id);
    if (until) {
      if (Date.now() < until) continue;
      // The hour is up - give it a genuinely fresh round rather than just
      // "one more try", in case whatever caused the original failure (a
      // permissions sync, a Discord outage) is long gone by now.
      abandonedUntil.delete(channel.id);
      joinRounds.delete(channel.id);
    }
    const people = humansIn(channel);
    if (diskPaused && !slotRecording(channel.id)) continue;
    const active = slotRecording(channel.id);

    if (people >= config.minHumans && !active) {
      // A channel we just failed to join gets a rest. Without this, a permission
      // problem or a blocked voice path turns into hundreds of attempts a minute.
      const until = joinCooldown.get(channel.id) ?? 0;
      if (Date.now() < until) continue;

      const timer = graceTimers.get(channel.id);
      if (timer) {
        clearTimeout(timer);
        graceTimers.delete(channel.id);
      }
      await beginRecording(channel);
      continue;
    }

    if (active && people < config.minHumans) {
      if (graceTimers.has(channel.id)) continue;
      // Somebody may just be reconnecting - don't split the call in two.
      const timer = setTimeout(() => {
        graceTimers.delete(channel.id);
        const still = slotRecording(channel.id);
        if (still && humansIn(channel) < config.minHumans) {
          finishRecording(still, 'everyone left').catch((err) =>
            log.error(`finish failed: ${err.stack ?? err.message}`)
          );
        }
      }, config.leaveGraceSec * 1000);
      timer.unref?.();
      graceTimers.set(channel.id, timer);
      continue;
    }

    if (active && people >= config.minHumans) {
      const timer = graceTimers.get(channel.id);
      if (timer) {
        clearTimeout(timer);
        graceTimers.delete(channel.id);
      }
    }
  }
}

async function beginRecording(channel) {
  // Joining takes seconds, and the scheduler keeps ticking while it does. Without
  // this guard a slow join stacks up a dozen concurrent attempts on the same
  // guild, and they trample each other's handshake so none of them ever lands.
  if (joinInFlight.has(channel.id)) return;
  joinInFlight.add(channel.id);
  try {
    await attemptRecording(channel);
  } finally {
    joinInFlight.delete(channel.id);
  }
}

async function attemptRecording(channel) {
  const slot = freeSlotFor(channel.guild.id);
  if (!slot) {
    log.warn(
      `#${channel.name} is active but every bot is busy - add another token (DISCORD_TOKEN_2) ` +
        `to record ${slots.length + 1} calls at once`
    );
    await announce(channel, {
      title: 'Not recording',
      description:
        `Someone started a call in **#${channel.name}**, but every recorder bot is already ` +
        `in another channel. Add a second bot token to cover simultaneous calls.`,
      color: 0xd9822b,
    });
    return;
  }

  const liveChannel = slot.client.channels.cache.get(channel.id) ?? channel;
  const guild = liveChannel.guild;

  let session = null;
  let lastErr = null;

  for (let attempt = 1; attempt <= JOIN_ATTEMPTS; attempt++) {
    // Always drop any voice session of our own first. See leaveVoice().
    await leaveVoice(guild, slot.log);

    const candidate = new RecordingSession({
      channel: liveChannel,
      dataDir: config.dataDir,
      log: slot.log,
      minDurationSec: config.minDurationSec,
      maxSessionHours: config.maxSessionHours,
    });

    try {
      await candidate.start();
      session = candidate;
      break;
    } catch (err) {
      lastErr = err;
      await candidate.discard(); // don't leave an empty session folder behind
      if (attempt < JOIN_ATTEMPTS) {
        slot.log.warn(`${err.message}`);
        slot.log.warn(`clearing and trying again (attempt ${attempt + 1} of ${JOIN_ATTEMPTS})`);
        await sleep(3_000);
      }
    }
  }

  if (!session) {
    slot.log.error(lastErr.message);
    describeJoinFailure(slot, channel);
    await leaveVoice(guild, slot.log); // leave nothing behind in the channel

    const round = (joinRounds.get(channel.id) ?? 0) + 1;
    joinRounds.set(channel.id, round);

    if (round >= MAX_JOIN_ROUNDS) {
      abandonedUntil.set(channel.id, Date.now() + ABANDON_MS);
      slot.log.error(
        `giving up on #${channel.name} for an hour - repeatedly appearing and vanishing in the ` +
          `channel is worse than not recording. Will try again after that.`
      );
      await announce(channel, {
        title: 'Recording disabled for this channel',
        description:
          `**#${channel.name}** — could not be joined: ${lastErr.message}\n` +
          `Will try again in an hour.`,
        color: 0xcc3333,
      });
      return;
    }

    const wait = JOIN_BACKOFF_MS[Math.min(round - 1, JOIN_BACKOFF_MS.length - 1)];
    joinCooldown.set(channel.id, Date.now() + wait);
    slot.log.warn(
      `will try #${channel.name} once more in ${Math.round(wait / 1000)}s, then stop trying`
    );
    setTimeout(() => scheduleEvaluate(), wait + 500).unref?.();
    return;
  }

  joinRounds.delete(channel.id);
  joinCooldown.delete(channel.id);
  slot.session = session;
  session.once('connection-lost', () => {
    finishRecording(slot, 'connection lost').catch((err) => log.error(err.message));
  });
  session.once('cap-reached', () => {
    slot.log.info('session length cap reached - splitting the recording');
    finishRecording(slot, 'length cap').then(() => scheduleEvaluate()).catch((err) => log.error(err.message));
  });

  if (config.announceStart) {
    await announce(channel, {
      title: 'Recording started',
      description: `**#${channel.name}** is being recorded. The file lands in Drive when the call ends.`,
      color: 0xbf2f27,
    });
  }
}

async function finishRecording(slot, reason) {
  const session = slot.session;
  if (!session) return;
  slot.session = null;
  slot.finalising = true;

  let result;
  try {
    result = await session.stop(reason);
  } catch (err) {
    slot.log.error(`failed to close ${session.id}: ${err.stack ?? err.message}`);
    slot.finalising = false;
    scheduleEvaluate();
    return;
  }

  // The bot is out of the channel the moment stop() returns, but mixing hours of
  // audio takes minutes. Holding the slot across that turns every length-cap
  // split into a gap in the call, and tells the channel every recorder is busy.
  // Hand the slot back now; the mixdown finishes on its own time.
  slot.finalising = false;
  scheduleEvaluate();

  try {
    if (session.isDiscardable(result)) {
      slot.log.info(`discarding ${session.id} (too short or no audio)`);
      await fs.rm(session.dir, { recursive: true, force: true });
      return;
    }

    const { manifest, tracks, dir, durationMs } = result;
    const outFile = path.join(dir, `${session.fileStem()}.mp3`);

    slot.log.info(`mixing ${tracks.length} speaker track(s)`);
    const { main, perSpeaker } = await mixSession({
      tracks,
      workDir: dir,
      outFile,
      durationMs,
      keepUserTracks: config.keepUserTracks,
      bitrate: config.audioBitrate,
      channels: config.audioChannels,
    });

    // These are finished and complete, but nothing will upload them until the
    // end of this block. Hold them so the backlog sweep, which by then may
    // well consider them old enough to have been abandoned, leaves them to us
    // rather than uploading and deleting them mid-transcription.
    const releaseHold = reserveUploads([main, ...perSpeaker.map((p) => p.file)]);

    let transcript = null;
    try {
      if (config.transcribe !== 'off') {
        try {
          transcript = await transcribeSession({
            mode: config.transcribe,
            tracks,
            manifest,
            outFile: path.join(dir, `${session.id}.txt`),
            config,
            log: slot.log,
          });
        } catch (err) {
          slot.log.warn(`transcription failed: ${err.message}`);
        }
      }

      // The raw per-speaker PCM has served its purpose.
      for (const t of tracks) await fs.rm(t.file, { force: true });
    } finally {
      // Handed straight over to our own uploadFiles() below, which does its
      // own claiming - holding past this point would make it skip them.
      releaseHold();
    }

    const files = [main, ...perSpeaker.map((p) => p.file), transcript].filter(Boolean);
    let uploaded = { uploaded: [], skipped: true };
    try {
      uploaded = await uploadFiles({
        files,
        remote: config.rcloneRemote,
        rcloneConfig: config.rcloneConfig,
        startedAt: session.startedAt,
        retries: config.uploadRetries,
        log: slot.log,
      });
    } catch (err) {
      slot.log.error(`upload failed, keeping local copy: ${err.message}`);
      // This is the disk-fill mechanism: if uploads keep failing (a dead
      // token, a network outage) recordings just pile up locally. See
      // announceUploadFailure() - shared with the backlog sweep, so the same
      // dead token doesn't produce two separate streams of notices.
      await announceUploadFailure(
        `**#${session.channel.name}** could not be uploaded: ${err.message}\n` +
          `Nothing is lost - recordings stay on the server - but this will fill the disk if it ` +
          `keeps happening. Check the rclone / Google Drive setup. It will retry automatically ` +
          `once that's fixed.`
      );
    }

    if (config.deleteLocalAfterUpload && uploaded.uploaded.length >= files.length) {
      await fs.rm(dir, { recursive: true, force: true });
    }

    if (config.announceEnd) {
      const mins = Math.max(1, Math.round(durationMs / 60000));
      const names = manifest.speakers.map((s) => s.label).join(', ') || 'nobody audible';
      await announce(session.channel, {
        title: 'Recording saved',
        description: `**#${session.channel.name}** — ${mins} min\n${names}`,
        footer: uploaded.skipped ? 'saved on the server' : `saved to ${config.rcloneRemote}`,
        color: 0x2f6b4f,
      });
    }

    slot.log.info(`done: ${session.id} (${Math.round(durationMs / 1000)}s, reason: ${reason})`);
  } catch (err) {
    slot.log.error(`failed to finalise ${session.id}: ${err.stack ?? err.message}`);
    await announce(session.channel, {
      title: 'Recording failed to save',
      description: `**#${session.channel.name}** — ${err.message}\nThe raw audio is still on the server.`,
      color: 0xcc3333,
    }).catch(() => {});
  }
}

// ─── what the video companion asks about ──────────────────────────────────

function companionState() {
  const active = slots.find((s) => s.session);
  if (!active) {
    return { recording: false, shouldRecordVideo: false, sessionId: null, channel: null, sharers: [], videoMode: config.videoMode };
  }
  const session = active.session;
  const sharers = sharersIn(session.channel);
  return {
    recording: true,
    sessionId: session.id,
    channel: session.channel.name,
    startedAt: session.startedAt.toISOString(),
    sharers,
    videoMode: config.videoMode,
    // The single field the companion actually acts on.
    shouldRecordVideo: config.videoMode === 'call' ? true : sharers.length > 0,
  };
}

/**
 * A voice connection stuck in "signalling" means Discord received our request and
 * declined to answer. It never says why, so print the things that cause it.
 */
function describeJoinFailure(slot, channel) {
  try {
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    const need = ['ViewChannel', 'Connect', 'Speak', 'UseVAD'];
    const held = need.map((p) => `${p}=${perms?.has(p) ? 'yes' : 'NO'}`).join('  ');
    const humans = channel.members.filter((m) => !m.user.bot).size;

    slot.log.warn(`  channel type: ${channel.type} (2 = voice, 13 = stage)`);
    slot.log.warn(`  bot permissions here: ${held}`);
    slot.log.warn(
      `  user limit: ${channel.userLimit || 'none'}   currently in channel: ${channel.members.size} (${humans} human)`
    );
    if (channel.userLimit && channel.members.size >= channel.userLimit) {
      slot.log.warn('  >> THE CHANNEL IS FULL. Raise the user limit or the bot cannot get in.');
    }
    if (!perms?.has('Connect')) {
      slot.log.warn('  >> THE BOT LACKS CONNECT on this channel. Fix its role permissions.');
    }
    if (channel.type === 13) {
      slot.log.warn('  >> This is a Stage channel. The bot needs to be invited to speak.');
    }
    slot.log.warn(`  bot is server-deafened: ${me?.voice?.serverDeaf ? 'YES - undo that' : 'no'}`);
    const stale = me?.voice?.channelId;
    slot.log.warn(
      `  bot's own voice state: ${stale ? `STALE - Discord thinks it is in ${stale}` : 'clean'}`
    );
    if (stale === channel.id) {
      slot.log.warn(
        '  >> Discord put us in the channel but never sent a voice server. The VOICE_SERVER_UPDATE'
      );
      slot.log.warn(
        '     line above says which: present = the media path failed, absent = Discord never answered.'
      );
    } else if (stale) {
      slot.log.warn(`  >> We are still held in ${channelLabel(channel.guild, stale)}. That blocks this join.`);
    }
  } catch (err) {
    slot.log.warn(`  (could not inspect the channel: ${err.message})`);
  }
}

// ─── notices ──────────────────────────────────────────────────────────────

/** @returns {Promise<boolean>} true only when a notice actually reached Discord. */
async function announce(sourceChannel, { title, description, color, footer }) {
  if (!config.logChannelId) return false;
  const client = slots[0]?.client;
  if (!client) return false;
  try {
    const channel = await client.channels.fetch(config.logChannelId);
    if (!channel?.isTextBased()) return false;
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
    if (footer) embed.setFooter({ text: footer });
    embed.setTimestamp(new Date());
    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    log.warn(`could not post to the notices channel: ${err.message}`);
    return false;
  }
}

/**
 * One throttled notice for "uploads are failing," shared by a live chunk's
 * own upload (finishRecording, above) and the backlog sweep (backlog.js, via
 * runBacklogSweep's onUploadFailure below) - a dead token or a Drive outage
 * fails both the same way, and nobody needs two separate streams of notices
 * about the same underlying problem every few hours.
 */
async function announceUploadFailure(description) {
  if (Date.now() - lastUploadFailWarn <= 6 * 3600_000) return;
  // Claim the window before awaiting, so two failures landing together can't
  // both post; hand it back if nothing was actually delivered. The backlog
  // sweep runs once at boot, before any slot has logged in, and a notice that
  // never reached Discord must not buy six hours of silence from the next one
  // that could have.
  const previous = lastUploadFailWarn;
  lastUploadFailWarn = Date.now();
  const posted = await announce(null, {
    title: 'Uploads to Google Drive are failing',
    description,
    color: 0xcc3333,
  }).catch(() => false);
  if (!posted) lastUploadFailWarn = previous;
}

// ─── housekeeping ─────────────────────────────────────────────────────────

async function pruneOldSessions() {
  if (config.retentionDays <= 0) return;
  const root = path.join(config.dataDir, 'sessions');
  const cutoff = Date.now() - config.retentionDays * 86400 * 1000;
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(dir, { recursive: true, force: true });
      log.info(`pruned ${entry.name}`);
    }
  }
}

// ─── boot ─────────────────────────────────────────────────────────────────

/**
 * login() resolves before the gateway has sent us any guilds, so waiting on it
 * alone means enumerating an empty cache. discord.js is renaming this event
 * from "ready" to "clientReady", so listen for both and take whichever comes.
 */
function waitUntilReady(client, timeoutMs = 30_000) {
  if (client.isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      client.off('ready', done);
      client.off('clientReady', done);
      resolve();
    };
    const timer = setTimeout(
      () => reject(new Error('the gateway never became ready within 30s')),
      timeoutMs
    );
    client.once('ready', done);
    client.once('clientReady', done);
  });
}

/**
 * Nothing matched. Rather than just saying so, print the categories and voice
 * channels the bot can actually see - a one-character difference in the
 * category name is by far the most common cause, and this makes it obvious.
 */
function describeWhatWeCanSee() {
  log.warn('nothing matched. Here is everything this bot can see:');
  let sawAnything = false;
  for (const slot of slots) {
    for (const guild of slot.client.guilds.cache.values()) {
      const voice = [...guild.channels.cache.values()].filter(
        (ch) => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice
      );
      log.warn(`  server "${guild.name}" (GUILD_ID=${guild.id}) - ${voice.length} voice channel(s)`);
      for (const ch of voice) {
        sawAnything = true;
        const perms = ch.permissionsFor(guild.members.me);
        const ok = perms?.has('ViewChannel') && perms?.has('Connect');
        log.warn(
          `    #${ch.name}  (id ${ch.id})  category: ${ch.parent?.name ?? '(none)'}` +
            `${ok ? '' : '   <- NO ACCESS: the bot lacks View or Connect here'}`
        );
      }
    }
  }
  if (!sawAnything) {
    log.warn('  ...nothing at all. The bot is not in any server, or cannot see any voice channels.');
  }
  log.warn(`WATCH_CATEGORY_NAMES is currently: ${JSON.stringify(config.watchCategoryNames)}`);
  log.warn('Category names must match exactly, apart from capitalisation.');
}


async function main() {
  const problems = validate();
  if (problems.length) {
    for (const p of problems) log.error(p);
    // Exiting instantly on a container host produces a restart storm - the
    // platform relaunches us, we fail again, and the log fills with the same
    // two lines several times a second. Pause first so the reason stays
    // readable and the restarts stay cheap.
    log.error('configuration is incomplete - pausing 30s so this does not restart in a loop');
    await new Promise((r) => setTimeout(r, 30_000));
    process.exit(1);
  }

  await fs.mkdir(path.join(config.dataDir, 'sessions'), { recursive: true });

  // Salvage anything a crash or a hard kill left half-finished, before logging
  // in - nothing can start a new recording until login happens below, so
  // there is no live session for this to collide with.
  await recoverOrphanedSessions({
    dataDir: config.dataDir,
    log: log.child('recover'),
    rcloneRemote: config.rcloneRemote,
    rcloneConfig: config.rcloneConfig,
    uploadRetries: config.uploadRetries,
    deleteLocalAfterUpload: config.deleteLocalAfterUpload,
    bitrate: config.audioBitrate,
    channels: config.audioChannels,
  }).catch((err) => log.error(`recovery failed: ${err.stack ?? err.message}`));

  // If the native audio or encryption modules failed to build in this image,
  // voice cannot work and nothing else in the log will say so.
  for (const line of generateDependencyReport().split('\n')) {
    if (line.trim()) log.info(`deps | ${line}`);
  }

  const remote = await checkRemote({
    remote: config.rcloneRemote,
    rcloneConfig: config.rcloneConfig,
  });
  if (!remote.ok) {
    log.warn(`rclone remote is not reachable yet: ${remote.note}`);
    log.warn('recordings will be kept on disk until that is fixed');
  }

  const backlogLog = log.child('backlog');
  const runBacklogSweep = () =>
    sweepBacklog({
      dataDir: config.dataDir,
      log: backlogLog,
      rcloneRemote: config.rcloneRemote,
      rcloneConfig: config.rcloneConfig,
      uploadRetries: config.uploadRetries,
      deleteLocalAfterUpload: config.deleteLocalAfterUpload,
      // A backlog file failing to upload again is the same silent-disk-fill
      // risk as a live chunk's own upload failing - see announceUploadFailure().
      onUploadFailure: (name, err) =>
        announceUploadFailure(
          `A previously finished recording (**${name}**) failed to upload again: ${err.message}\n` +
            `Nothing is lost - it stays on the server - but this will fill the disk if it keeps ` +
            `happening. Check the rclone / Google Drive setup. It will retry automatically once ` +
            `that's fixed.`
        ),
    }).catch((err) => {
      backlogLog.warn(`sweep failed: ${err.message}`);
      announceUploadFailure(
        `The backlog upload sweep itself failed to run: ${err.message}\nRecordings already on the ` +
          `server are safe; this will be retried on the next sweep.`
      ).catch(() => {});
    });

  // Once at boot - only worth trying if the remote actually answered above -
  // and then on a timer regardless, so a token fixed an hour from now (or a
  // network blip that clears itself) drains the backlog on its own instead
  // of needing a restart.
  if (remote.ok) await runBacklogSweep();
  setInterval(runBacklogSweep, BACKLOG_SWEEP_MS).unref?.();

  startStatusServer({
    port: config.statusPort,
    secret: config.companionSecret,
    getState: companionState,
    // /health's readiness signal: at least one bot slot has actually logged
    // in and its gateway connection is up. gatewayReady() reads the same
    // Client#isReady() waitUntilReady() uses below, live on each request,
    // with the short grace described where it is defined.
    isReady: gatewayReady,
    log,
  });

  for (const slot of slots) {
    slot.client.on('voiceStateUpdate', (before, after) => {
      // A share starting or stopping is not a join or a leave, but the video
      // companion is polling on it, so log it where it can be seen.
      if (
        config.companionSecret &&
        !after.member?.user?.bot &&
        (before.streaming !== after.streaming || before.selfVideo !== after.selfVideo)
      ) {
        const who = after.member?.displayName ?? after.id;
        const on = after.streaming || after.selfVideo;
        log.info(`${who} ${on ? 'started' : 'stopped'} sharing`);
      }
      scheduleEvaluate();
    });
    // The handshake needs VOICE_STATE_UPDATE *and* VOICE_SERVER_UPDATE back from
    // Discord. Watching the raw packets is the only way to tell "Discord never
    // answered" apart from "it answered and we could not use the answer".
    slot.client.on('raw', (packet) => {
      const d = packet?.d;
      if (packet?.t === 'VOICE_SERVER_UPDATE') {
        slot.log.info(`gateway: VOICE_SERVER_UPDATE endpoint=${d?.endpoint ?? 'null'}`);
      } else if (packet?.t === 'VOICE_STATE_UPDATE' && d?.user_id === slot.client.user?.id) {
        slot.log.info(
          `gateway: our VOICE_STATE_UPDATE channel=${d?.channel_id ?? 'null'} ` +
            `session=${d?.session_id ? String(d.session_id).slice(-8) : 'none'}`
        );
      }
    });
    slot.client.on('error', (err) => slot.log.warn(`gateway error: ${err.message}`));
    let announced = false;
    const announceLogin = () => {
      if (announced) return; // both event names may fire; say it once
      announced = true;
      slot.log.info(`logged in as ${slot.client.user?.tag ?? 'the bot'}`);
    };
    slot.client.once('ready', announceLogin);
    slot.client.once('clientReady', announceLogin);
    try {
      await slot.client.login(slot.token);
      await waitUntilReady(slot.client);
    } catch (err) {
      log.error(
        /token/i.test(err.message)
          ? `Discord rejected the bot token for slot ${slot.index + 1}. Regenerate it in the developer portal.`
          : `login failed for slot ${slot.index + 1}: ${err.message}`
      );
      // Same reasoning as the config-validation exit above: a bad or revoked
      // token doesn't fix itself on the next restart, so pause first rather
      // than hand Railway a crash loop to spend its restart budget on.
      log.error('pausing 30s before exiting so this does not restart in a loop');
      await new Promise((r) => setTimeout(r, 30_000));
      process.exit(1);
    }
  }

  const channels = watchedChannels();
  log.info(
    `watching ${channels.length} voice channel(s): ${
      channels.map((c) => `#${c.name} (in "${c.parent?.name ?? 'no category'}")`).join(', ') || '(none)'
    }`
  );
  if (channels.length === 0) describeWhatWeCanSee();

  await pruneOldSessions();
  setInterval(() => pruneOldSessions().catch(() => {}), 6 * 3600 * 1000).unref?.();

  const startFree = await freeBytes();
  log.info(`${human(startFree)} free on ${config.dataDir}`);
  await checkDisk();
  setInterval(() => checkDisk().catch((err) => log.warn(`disk check failed: ${err.message}`)), DISK_CHECK_MS).unref?.();

  // Whatever the last container left behind, we are not in a call now. Clear it
  // before the first join attempt rather than discovering it 15s into a timeout.
  for (const slot of slots) {
    for (const guild of slot.client.guilds.cache.values()) {
      await leaveVoice(guild, slot.log);
    }
  }

  // Catch calls that were already running when the bot started.
  scheduleEvaluate();

  // Events can be missed - a dropped gateway resume, a join during a restart, a
  // cooldown that expired while the channel sat unchanged. A cheap sweep over
  // the cache makes every one of those self-correcting instead of permanent.
  setInterval(() => {
    // Also the sampler behind /health's grace window - see gatewayReady().
    gatewayReady();
    scheduleEvaluate();
  }, IDLE_SWEEP_MS).unref?.();

  const shutdown = async (signal) => {
    log.info(`${signal} received - finishing any live recording before exit`);
    // Do this first. If the platform kills us during the mixdown, this is what
    // stops the next container inheriting a voice session it can never join over.
    for (const slot of slots) {
      for (const guild of slot.client.guilds.cache.values()) {
        try {
          guild.shard.send({
            op: 4,
            d: { guild_id: guild.id, channel_id: null, self_mute: false, self_deaf: false },
          });
        } catch {}
      }
    }
    await sleep(500);
    await Promise.all(
      slots.filter((s) => s.session).map((s) => finishRecording(s, `shutdown (${signal})`))
    );
    for (const s of slots) s.client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // A rejected promise with nothing to catch it is left running - logging and
  // continuing is deliberate here, so one bad await somewhere doesn't take a
  // live recording down with it.
  process.on('unhandledRejection', (err) => log.error(`unhandled: ${err?.stack ?? err}`));
  // A *synchronous* throw with nothing to catch it means Node is about to exit
  // on its own anyway, in an unknown state - the safest thing this can do is
  // log clearly and exit deliberately rather than let something already
  // half-broken keep running. Only a short pause, not the 30s used above:
  // this is meant to be rare, not a persistent misconfiguration.
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception - exiting: ${err?.stack ?? err}`);
    setTimeout(() => process.exit(1), 5_000).unref?.();
  });
}

main().catch((err) => {
  log.error(err.stack ?? err.message);
  process.exit(1);
});
