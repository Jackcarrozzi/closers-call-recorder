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

// How often the burst index is checkpointed to disk while a call is live. It
// is the only copy of "which bytes of speaker-*.pcm go where on the
// timeline" that survives a crash - session.json only gets written once, at
// a clean stop() - so a hard kill between checkpoints can only ever cost
// this many seconds of index, never the whole chunk. See recover.js.
const CHECKPOINT_MS = 30_000;

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
    this.dataDir = dataDir;
    this.id = buildSessionId(this.startedAt, channel.name);
    this.dir = path.join(dataDir, 'sessions', this.id);
    this.tracks = new Map(); // userId -> SpeakerTrack
    this.subscribed = new Set();
    this.connection = null;
    this.stopping = false;
    this.ready = false;
    this.net = null;
    this.capTimer = null;
    this.checkpointTimer = null;
    this.checkpointFile = path.join(this.dir, 'checkpoint.json');
    this.checkpointing = false;
    // Only true once #claimDir() has actually reserved this.dir for us. Until
    // then the path is just a guess at a name, and may well belong to another
    // session - discard() must not delete a directory this session never
    // created.
    this.dirClaimed = false;
  }

  /**
   * Name for the finished file: date, the span it covers, and the channel -
   * 2026-08-28_1603-1805_CLOSERS.mp3. A ten-hour day arrives as a handful of
   * these, and you can see at a glance which one holds the moment you want
   * without opening any of them.
   */
  fileStem() {
    const pad = (n) => String(n).padStart(2, '0');
    const s = this.startedAt;
    const e = this.stoppedAt ?? new Date();
    const date = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
    const from = `${pad(s.getHours())}${pad(s.getMinutes())}`;
    const to = `${pad(e.getHours())}${pad(e.getMinutes())}`;
    return `${date}_${from}-${to}_${safeLabel(this.channel.name)}`;
  }

  /** Throw away a session that never got off the ground, dir and all. */
  async discard() {
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.#destroyQuietly();
    this.connection = null;
    // Never remove a directory we did not reserve: if the claim itself failed,
    // this.dir still holds the un-claimed name, which on a same-second
    // collision is another, live session's directory.
    if (this.dirClaimed) await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  get durationMs() {
    return (this.stoppedAt ? this.stoppedAt.getTime() : Date.now()) - this.startMs;
  }

  /**
   * Reserve this session's directory, exclusively - see claimSessionDir()
   * below for why and how. Broken out into a standalone export rather than
   * kept entirely inline so the collision behaviour can be exercised
   * directly, without needing a real voice connection to reach it.
   */
  async #claimDir() {
    const { id, dir } = await claimSessionDir(this.dataDir, this.id, this.log);
    this.id = id;
    this.dir = dir;
    this.checkpointFile = path.join(dir, 'checkpoint.json');
    this.dirClaimed = true;
  }

  async start() {
    await this.#claimDir();

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

    this.checkpointTimer = setInterval(() => this.#checkpoint(), CHECKPOINT_MS);
    this.checkpointTimer.unref?.();

    this.log.info(`recording #${this.channel.name} -> ${this.id}`);
    return this;
  }

  /**
   * Write the current burst index to disk so a crash loses at most this much
   * of it. Runs on its own timer, off to the side of the audio path: it never
   * touches track.write(), and any failure here is logged and swallowed
   * rather than allowed to interrupt a live recording.
   */
  async #checkpoint() {
    if (this.stopping || this.checkpointing) return;
    this.checkpointing = true;
    try {
      const speakers = [...this.tracks.values()]
        .filter((t) => t.totalBytes > 0)
        .map((t) => t.toJSON());
      if (speakers.length === 0) return; // nobody has said anything yet

      const checkpoint = {
        id: this.id,
        guild: { id: this.guild.id, name: this.guild.name },
        channel: { id: this.channel.id, name: this.channel.name },
        startedAt: this.startedAt.toISOString(),
        checkpointedAt: new Date().toISOString(),
        durationMs: Math.round(this.durationMs),
        speakers,
      };

      // Temp file + rename: a reader (recover.js, or us on the next tick)
      // never sees a half-written checkpoint, and a crash mid-write leaves
      // last checkpoint intact rather than a corrupt one.
      //
      // Not pretty-printed, unlike session.json. The burst index of a long
      // call runs to tens of thousands of entries and this rewrites all of it
      // every 30 seconds; indenting costs about a gigabyte of extra writes to
      // the volume over a six-hour call, for a file only recover.js reads.
      const tmp = `${this.checkpointFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(checkpoint));
      await fs.rename(tmp, this.checkpointFile);
    } catch (err) {
      this.log.warn(`checkpoint failed (recording continues): ${err.message}`);
    } finally {
      this.checkpointing = false;
    }
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

    // Re-subscribing after a stream error (see forgetSubscription below) has
    // to reuse this speaker's existing track. A second SpeakerTrack for the
    // same user reopens speaker-<id>.pcm with 'w', which truncates every byte
    // they had already said in this chunk, and replaces the burst index that
    // says where that speech belongs - losing both the audio and the record
    // of where it went. Carrying on with the same track is correct as well as
    // safe: its stream is still open and appending, and burst offsets are
    // measured from the session start, so the gap lands on the timeline by
    // itself.
    let track = this.tracks.get(userId);
    if (!track) {
      track = new SpeakerTrack({
        userId,
        label,
        dir: this.dir,
        sessionStart: this.startMs,
      });
      this.tracks.set(userId, track);
    }

    // Manual end keeps one subscription open for the whole call; the stream
    // simply goes quiet between bursts of speech.
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });

    // Let go of the previous subscription, if this is a re-subscribe. When the
    // receiver hands back the very same opus stream (it does, while that
    // stream is still open) its listeners would otherwise accumulate a pair
    // per re-subscribe - and only then, so a stream we are not about to
    // re-arm is never left without an 'error' listener. A decoder still
    // draining is destroyed either way: left running it would keep writing
    // into this track alongside the new one, interleaving two streams of
    // audio in the same file.
    try {
      if (track._opus === opus) track._detach?.();
      track._decoder?.destroy();
    } catch {}
    track._detach = null;
    track._decoder = null;

    const decoder = new prism.opus.Decoder({
      rate: PCM.sampleRate,
      channels: PCM.channels,
      frameSize: 960,
    });

    // Letting this user go on a later 'speaking start' is what fixes them
    // going silent for the rest of the chunk if either stream errors or
    // closes mid-call. It never causes churn on a clean stop(): stop()
    // destroys these same streams on purpose, but #subscribe() bails out on
    // this.stopping before it would ever act on the deleted entry.
    //
    // Only the newest subscription for a user may release the guard. A
    // 'close' arriving late from a superseded stream would otherwise unlock a
    // user who is already subscribed again, and the next 'speaking start'
    // would attach a second decoder beside the live one - two copies of the
    // same speech written into one track.
    const generation = {};
    track._generation = generation;
    const forgetSubscription = () => {
      if (track._generation !== generation) return;
      this.subscribed.delete(userId);
    };
    const onOpusError = (err) => {
      this.log.warn(`opus stream error for ${label}: ${err.message}`);
      forgetSubscription();
    };
    opus.on('error', onOpusError);
    opus.on('close', forgetSubscription);
    track._detach = () => {
      opus.off('error', onOpusError);
      opus.off('close', forgetSubscription);
    };
    decoder.on('error', (err) => {
      this.log.warn(`decode error for ${label}: ${err.message}`);
      forgetSubscription();
    });
    decoder.on('close', forgetSubscription);
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
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);

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
    // session.json is now the authoritative index; the checkpoint that led
    // up to it would only cause recover.js to double-guess a clean chunk.
    await fs.rm(this.checkpointFile, { force: true }).catch(() => {});

    return { manifest, tracks: withAudio, dir: this.dir, durationMs };
  }

  /** True when the call was too short or too quiet to be worth keeping. */
  isDiscardable(result) {
    if (!result) return true;
    if (result.tracks.length === 0) return true;
    return result.durationMs < this.minDurationSec * 1000;
  }
}

/**
 * Reserve dataDir/sessions/<id> for a new session, exclusively. Two chunks -
 * the tail of one ending and the head of the next starting - can still land
 * in the same clock second on a fast machine even with buildSessionId()'s
 * seconds resolution; a bare mkdir({recursive:true}) would silently hand the
 * new chunk the old one's directory, and the old chunk's post-upload fs.rm()
 * would then delete the live one out from under it. Plain mkdir() (no
 * recursive) fails with EEXIST on a collision instead of succeeding
 * quietly, so a taken name gets a numeric suffix and is tried again until
 * one lands.
 *
 * The one thing a plain mkdir() gives up is creating sessions/ itself, which
 * the old recursive call did for free. main() makes it at boot, but if it
 * ever goes missing while we are running - a volume remount, a stray rm - a
 * bare ENOENT here would fail every join until the next redeploy. So that one
 * case rebuilds the parent and tries again, once.
 */
export async function claimSessionDir(dataDir, id, log) {
  const root = path.join(dataDir, 'sessions');
  let candidate = id;
  let n = 2;
  let rebuiltRoot = false;
  for (;;) {
    const dir = path.join(root, candidate);
    try {
      await fs.mkdir(dir);
      if (candidate !== id) {
        log?.warn?.(`session id ${id} was already in use - recording as ${candidate} instead`);
      }
      return { id: candidate, dir };
    } catch (err) {
      if (err.code === 'EEXIST') {
        candidate = `${id}-${n++}`;
        continue;
      }
      if (err.code === 'ENOENT' && !rebuiltRoot) {
        rebuiltRoot = true;
        log?.warn?.(`${root} was missing - recreating it`);
        await fs.mkdir(root, { recursive: true });
        continue;
      }
      throw err;
    }
  }
}

export function buildSessionId(date, channelName) {
  const pad = (n) => String(n).padStart(2, '0');
  // Seconds, not just minutes: two chunks landing in the same clock minute
  // (one ending, the next starting) used to build the identical id and
  // therefore the identical directory. #claimDir() still uniquifies on a
  // literal collision, but seconds make that a rare fallback instead of the
  // normal case. Any old-format ("_HHmm_") id already on disk still parses
  // fine everywhere it's read back - see backlog.js's startedAtFor().
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}_${safeLabel(channelName)}`;
}
