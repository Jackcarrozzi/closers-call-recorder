// One recording of one voice channel, from the moment the bot joins until the
// last person leaves.

import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  joinVoiceChannel,
  entersState,
  EndBehaviorType,
  VoiceConnectionStatus,
  VoiceReceiver,
} from '@discordjs/voice';
import prism from 'prism-media';
import { PCM } from './config.js';
import { SpeakerTrack } from './tracks.js';
import { safeLabel } from './mixer.js';

export class RecordingSession extends EventEmitter {
  constructor({ channel, dataDir, log, minDurationSec, maxSessionHours }) {
    super();
    this.channel = channel;
    this.guild = channel.guild;
    this.log = log;
    this.minDurationSec = minDurationSec;
    this.maxSessionHours = maxSessionHours;

    this.startedAt = new Date();
    this.startMs = Date.now();
    this.stoppedAt = null;
    this.id = buildSessionId(this.startedAt, channel.name);
    this.dir = path.join(dataDir, 'sessions', this.id);
    this.tracks = new Map(); // userId -> SpeakerTrack
    this.subscribed = new Set();
    this.connection = null;
    this.stopping = false;
    this.capTimer = null;
  }

  get durationMs() {
    return (this.stoppedAt ? this.stoppedAt.getTime() : Date.now()) - this.startMs;
  }

  async start() {
    await fs.mkdir(this.dir, { recursive: true });

    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false, // deafened bots receive nothing
      selfMute: true,  // the bot never speaks
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      this.connection.destroy();
      this.connection = null;
      throw new Error(`could not join #${this.channel.name}: ${err.message}`);
    }

    this.#watchConnection();
    this.#watchSpeakers();

    if (this.maxSessionHours > 0) {
      this.capTimer = setTimeout(
        () => this.emit('cap-reached'),
        this.maxSessionHours * 3600 * 1000
      );
      this.capTimer.unref?.();
    }

    this.log.info(`recording #${this.channel.name} -> ${this.id}`);
    return this;
  }

  #watchConnection() {
    const conn = this.connection;
    conn.on('stateChange', (oldS, newS) => {
      if (newS.status === VoiceConnectionStatus.Disconnected && !this.stopping) {
        // A move or a network blip. Give it a moment to reconnect on its own
        // before giving up on the call.
        Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]).catch(() => {
          this.log.warn(`voice connection lost in #${this.channel.name}`);
          this.emit('connection-lost');
        });
      }
    });
    conn.on('error', (err) => this.log.warn(`voice error: ${err.message}`));
  }

  #watchSpeakers() {
    /** @type {VoiceReceiver} */
    const receiver = this.connection.receiver;
    receiver.speaking.on('start', (userId) => this.#subscribe(receiver, userId));
  }

  #subscribe(receiver, userId) {
    if (this.subscribed.has(userId) || this.stopping) return;
    this.subscribed.add(userId);

    const member = this.channel.members.get(userId) ?? this.guild.members.cache.get(userId);
    if (member?.user?.bot) return; // never record other bots
    const label = member?.displayName ?? member?.user?.username ?? `user-${userId}`;

    const track = new SpeakerTrack({
      userId,
      label,
      dir: this.dir,
      sessionStart: this.startMs,
    });
    this.tracks.set(userId, track);

    // Manual end keeps one subscription open for the whole call; the stream
    // simply goes quiet between bursts of speech.
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new prism.opus.Decoder({
      rate: PCM.sampleRate,
      channels: PCM.channels,
      frameSize: 960,
    });

    opus.on('error', (err) => this.log.warn(`opus stream error for ${label}: ${err.message}`));
    decoder.on('error', (err) => this.log.warn(`decode error for ${label}: ${err.message}`));
    decoder.on('data', (chunk) => track.write(chunk));
    opus.pipe(decoder);

    track._opus = opus;
    track._decoder = decoder;
    this.log.info(`capturing ${label}`);
  }

  /** Everyone who could still be recorded, excluding bots. */
  humanCount() {
    return this.channel.members.filter((m) => !m.user.bot).size;
  }

  async stop(reason = 'ended') {
    if (this.stopping) return null;
    this.stopping = true;
    this.stoppedAt = new Date();
    if (this.capTimer) clearTimeout(this.capTimer);

    for (const track of this.tracks.values()) {
      try {
        track._opus?.destroy();
        track._decoder?.destroy();
      } catch {}
      await track.close();
    }

    try {
      this.connection?.destroy();
    } catch {}
    this.connection = null;

    const withAudio = [...this.tracks.values()].filter((t) => t.totalBytes > 0);
    const durationMs = Math.max(
      this.durationMs,
      ...withAudio.map((t) => t.endMs()),
      0
    );

    const manifest = {
      id: this.id,
      reason,
      guild: { id: this.guild.id, name: this.guild.name },
      channel: { id: this.channel.id, name: this.channel.name },
      startedAt: this.startedAt.toISOString(),
      stoppedAt: this.stoppedAt.toISOString(),
      durationMs: Math.round(durationMs),
      speakers: withAudio.map((t) => t.toJSON()),
    };
    await fs.writeFile(
      path.join(this.dir, 'session.json'),
      JSON.stringify(manifest, null, 2)
    );

    return { manifest, tracks: withAudio, dir: this.dir, durationMs };
  }

  /** True when the call was too short or too quiet to be worth keeping. */
  isDiscardable(result) {
    if (!result) return true;
    if (result.tracks.length === 0) return true;
    return result.durationMs < this.minDurationSec * 1000;
  }
}

export function buildSessionId(date, channelName) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${stamp}_${safeLabel(channelName)}`;
}
