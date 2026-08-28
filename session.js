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
    this.ready = false;
    this.net = null;
    this.capTimer = null;
  }

  /** Throw away a session that never got off the ground, dir and all. */
  async discard() {
    this.#destroyQuietly();
    this.connection = null;
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  get durationMs() {
    return (this.stoppedAt ? this.stoppedAt.getTime() : Date.now()) - this.startMs;
  }

  async start() {
    await fs.mkdir(this.dir, { recursive: true });

    // Clearing a leftover voice session is the caller's job now - it has to
    // happen before we get this far, and it needs the gateway rather than the
    // REST call this used to make.
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false, // deafened bots receive nothing
      selfMute: true,  // the bot never speaks
    });

    // Attach this BEFORE waiting, not after. The handshake is the part that
    // fails, so a listener registered once it has succeeded can never describe
    // it - which is exactly why the previous build logged nothing.
    this.#watchStates();

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      // Report the connection's own state too. "timed out" alone doesn't say
      // whether we were refused, disconnected, or never got a UDP path at all.
      const state = this.connection?.state?.status ?? 'unknown';
      const code = this.connection?.state?.closeCode;
      this.#destroyQuietly();
      this.connection = null;
      const failure = new Error(
        `could not join #${this.channel.name} (voice connection state: ${state}` +
          `${code === undefined ? '' : `, closeCode=${code}`}): ${err.message}`
      );
      failure.voiceState = state;
      throw failure;
    }

    this.ready = true;
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

  /** destroy() throws if the connection already tore itself down. That is not an error. */
  #destroyQuietly() {
    try {
      if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        this.connection.destroy();
      }
    } catch {}
  }

  #watchStates() {
    const conn = this.connection;
    conn.on('stateChange', (oldS, newS) => {
      // The connection only reports "connecting"; the networking instance under
      // it is what knows whether we are opening the socket, identifying, doing
      // the UDP handshake, or being hung up on. That distinction is the whole
      // diagnosis, so follow each networking instance as it appears.
      const net = newS.networking;
      if (net && net !== this.net) {
        this.net = net;
        this.#watchNetworking(net);
      }

      // The path should be signalling -> connecting -> ready. Printing every hop,
      // with the close code when there is one, is the only way to see where it
      // actually stops.
      let detail = '';
      if (newS.reason !== undefined) detail += ` reason=${newS.reason}`;
      if (newS.closeCode !== undefined) detail += ` closeCode=${newS.closeCode}`;
      this.log.info(`voice: ${oldS.status} -> ${newS.status}${detail}`);

      // Only meaningful once the call is actually up; during the initial
      // handshake a disconnect is the failure itself, which start() reports.
      if (this.ready && newS.status === VoiceConnectionStatus.Disconnected && !this.stopping) {
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

  /** Names for @discordjs/voice's internal networking states. */
  #watchNetworking(net) {
    const NAMES = [
      'opening socket',
      'identifying',
      'udp handshake',
      'selecting protocol',
      'ready',
      'resuming',
      'closed',
    ];
    const name = (code) => NAMES[code] ?? `state ${code}`;

    net.on('stateChange', (o, n) => {
      if (o.code !== n.code) this.log.info(`voice net: ${name(o.code)} -> ${name(n.code)}`);
    });
    // This close code is the single number that names the cause. 4004 means our
    // credentials were refused, 4006 that the gateway session behind them is no
    // longer the live one - which is what a second copy of this bot running on
    // the same token does to us.
    net.on('close', (code) => this.log.warn(`voice socket closed: code=${code}`));
    net.on('error', (err) => this.log.warn(`voice net error: ${err?.message ?? err}`));
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

    this.#destroyQuietly();
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
