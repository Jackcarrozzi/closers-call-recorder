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
import { uploadFiles, checkRemote } from './upload.js';
import { transcribeSession } from './transcribe.js';

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
let evaluateQueued = false;

// ─── channel matching ─────────────────────────────────────────────────────

function isWatched(channel) {
  if (!channel) return false;
  if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
    return false;
  }
  if (config.guildId && channel.guild.id !== config.guildId) return false;

  if (config.watchChannelIds.includes(channel.id)) return true;
  if (config.watchChannelNames.includes(channel.name.toLowerCase())) return true;

  const category = channel.parent?.name?.toLowerCase();
  if (category && config.watchCategoryNames.includes(category)) return true;

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

function slotRecording(channelId) {
  return slots.find((s) => s.session && s.session.channel.id === channelId) ?? null;
}

/** A slot that is free and whose bot is actually a member of this guild. */
function freeSlotFor(guildId) {
  return slots.find((s) => !s.busy && s.client.guilds.cache.has(guildId)) ?? null;
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
    const people = humansIn(channel);
    const active = slotRecording(channel.id);

    if (people >= config.minHumans && !active) {
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
  const session = new RecordingSession({
    channel: liveChannel,
    dataDir: config.dataDir,
    log: slot.log,
    minDurationSec: config.minDurationSec,
    maxSessionHours: config.maxSessionHours,
  });

  try {
    await session.start();
  } catch (err) {
    slot.log.error(err.message);
    await announce(channel, {
      title: 'Could not start recording',
      description: `**#${channel.name}** — ${err.message}`,
      color: 0xcc3333,
    });
    return;
  }

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

  try {
    const result = await session.stop(reason);
    if (session.isDiscardable(result)) {
      slot.log.info(`discarding ${session.id} (too short or no audio)`);
      await fs.rm(session.dir, { recursive: true, force: true });
      return;
    }

    const { manifest, tracks, dir, durationMs } = result;
    const outFile = path.join(dir, `${session.id}.mp3`);

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

    let transcript = null;
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
  } finally {
    slot.finalising = false;
    scheduleEvaluate();
  }
}

// ─── notices ──────────────────────────────────────────────────────────────

async function announce(sourceChannel, { title, description, color, footer }) {
  if (!config.logChannelId) return;
  const client = slots[0]?.client;
  if (!client) return;
  try {
    const channel = await client.channels.fetch(config.logChannelId);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
    if (footer) embed.setFooter({ text: footer });
    embed.setTimestamp(new Date());
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn(`could not post to the notices channel: ${err.message}`);
  }
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

async function main() {
  const problems = validate();
  if (problems.length) {
    for (const p of problems) log.error(p);
    process.exit(1);
  }

  await fs.mkdir(path.join(config.dataDir, 'sessions'), { recursive: true });

  const remote = await checkRemote({
    remote: config.rcloneRemote,
    rcloneConfig: config.rcloneConfig,
  });
  if (!remote.ok) {
    log.warn(`rclone remote is not reachable yet: ${remote.note}`);
    log.warn('recordings will be kept on disk until that is fixed');
  }

  for (const slot of slots) {
    slot.client.on('voiceStateUpdate', () => scheduleEvaluate());
    slot.client.on('error', (err) => slot.log.warn(`gateway error: ${err.message}`));
    slot.client.once('ready', (c) => {
      slot.log.info(`logged in as ${c.user.tag}`);
    });
    try {
      await slot.client.login(slot.token);
    } catch (err) {
      log.error(
        /token/i.test(err.message)
          ? `Discord rejected the bot token for slot ${slot.index + 1}. Regenerate it in the developer portal.`
          : `login failed for slot ${slot.index + 1}: ${err.message}`
      );
      process.exit(1);
    }
  }

  const channels = watchedChannels();
  log.info(`watching ${channels.length} voice channel(s): ${channels.map((c) => '#' + c.name).join(', ') || '(none matched yet)'}`);
  if (channels.length === 0) {
    log.warn('nothing matched - check WATCH_CATEGORY_NAMES and that the bot can see the channels');
  }

  await pruneOldSessions();
  setInterval(() => pruneOldSessions().catch(() => {}), 6 * 3600 * 1000).unref?.();

  // Catch calls that were already running when the bot started.
  scheduleEvaluate();

  const shutdown = async (signal) => {
    log.info(`${signal} received - finishing any live recording before exit`);
    await Promise.all(
      slots.filter((s) => s.session).map((s) => finishRecording(s, `shutdown (${signal})`))
    );
    for (const s of slots) s.client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error(`unhandled: ${err?.stack ?? err}`));
}

main().catch((err) => {
  log.error(err.stack ?? err.message);
  process.exit(1);
});
