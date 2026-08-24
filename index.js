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
import { startStatusServer } from './status-server.js';

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
const joinInFlight = new Set(); // channelIds we are mid-join on, right now
const JOIN_COOLDOWN_MS = 30_000;
let evaluateQueued = false;

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
  const session = new RecordingSession({
    channel: liveChannel,
    dataDir: config.dataDir,
    log: slot.log,
    minDurationSec: config.minDurationSec,
    maxSessionHours: config.maxSessionHours,
  });

  try {
    await session.start();
    joinCooldown.delete(channel.id);
  } catch (err) {
    slot.log.error(err.message);
    joinCooldown.set(channel.id, Date.now() + JOIN_COOLDOWN_MS);
    slot.log.warn(`will not retry #${channel.name} for ${JOIN_COOLDOWN_MS / 1000}s`);
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

  const remote = await checkRemote({
    remote: config.rcloneRemote,
    rcloneConfig: config.rcloneConfig,
  });
  if (!remote.ok) {
    log.warn(`rclone remote is not reachable yet: ${remote.note}`);
    log.warn('recordings will be kept on disk until that is fixed');
  }

  startStatusServer({
    port: config.statusPort,
    secret: config.companionSecret,
    getState: companionState,
    log,
  });

  for (const slot of slots) {
    slot.client.on('voiceStateUpdate', (before, after) => {
      // A share starting or stopping is not a join or a leave, but the video
      // companion is polling on it, so log it where it can be seen.
      if (config.companionSecret && (before.streaming !== after.streaming || before.selfVideo !== after.selfVideo)) {
        const who = after.member?.displayName ?? after.id;
        const on = after.streaming || after.selfVideo;
        log.info(`${who} ${on ? 'started' : 'stopped'} sharing`);
      }
      scheduleEvaluate();
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
