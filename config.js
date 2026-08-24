// Central configuration. Everything is driven by environment variables so the
// same image runs unchanged on Railway, a VPS, or a laptop.

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : String(v).trim();
}

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function list(name) {
  return str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// One token per channel we can record at the same time. Discord only lets a
// single bot user hold one voice connection per server, so a second concurrent
// call needs a second bot token.
function tokens() {
  const out = [];
  const primary = str('DISCORD_TOKEN');
  if (primary) out.push(primary);
  for (let i = 2; i <= 8; i++) {
    const t = str(`DISCORD_TOKEN_${i}`);
    if (t) out.push(t);
  }
  return out;
}

export const config = {
  tokens: tokens(),

  // What to watch. Category names catch every voice channel inside them,
  // including ones added later. Channel IDs are an explicit override.
  watchCategoryNames: list('WATCH_CATEGORY_NAMES').map((s) => s.toLowerCase()),
  watchChannelIds: list('WATCH_CHANNEL_IDS'),
  watchChannelNames: list('WATCH_CHANNEL_NAMES').map((s) => s.toLowerCase()),
  guildId: str('GUILD_ID'),

  // Where the bot posts its notices.
  logChannelId: str('LOG_CHANNEL_ID'),
  announceStart: bool('ANNOUNCE_START', true),
  announceEnd: bool('ANNOUNCE_END', true),

  // Recording behaviour.
  minHumans: num('MIN_HUMANS', 1),
  leaveGraceSec: num('LEAVE_GRACE_SEC', 20),
  minDurationSec: num('MIN_DURATION_SEC', 20),
  maxSessionHours: num('MAX_SESSION_HOURS', 6),
  ignoreBots: bool('IGNORE_BOTS', true),

  // Output.
  dataDir: str('DATA_DIR', '/data'),
  audioBitrate: str('AUDIO_BITRATE', '64k'),
  audioChannels: num('AUDIO_CHANNELS', 1), // 1 = mono mixdown, 2 = stereo
  keepUserTracks: bool('KEEP_USER_TRACKS', false),
  deleteLocalAfterUpload: bool('DELETE_LOCAL_AFTER_UPLOAD', false),
  retentionDays: num('RETENTION_DAYS', 0),

  // Upload.
  rcloneRemote: str('RCLONE_REMOTE'), // e.g. "gdrive:Discord Recordings"
  rcloneConfig: str('RCLONE_CONFIG'),
  uploadRetries: num('UPLOAD_RETRIES', 3),

  // Transcription. "off" | "openai" | "local"
  transcribe: str('TRANSCRIBE', 'off').toLowerCase(),
  openaiApiKey: str('OPENAI_API_KEY'),
  openaiModel: str('OPENAI_TRANSCRIBE_MODEL', 'whisper-1'),
  whisperBin: str('WHISPER_BIN', 'whisper-cli'),
  whisperModel: str('WHISPER_MODEL', '/models/ggml-base.en.bin'),

  timezone: str('TZ', 'America/New_York'),

  // Screen-share capture. The bot can't see video - Discord doesn't give bots
  // access to it - but it can see that a share is happening, and tell the
  // companion running on the sharer's own machine to record the screen.
  companionSecret: str('COMPANION_SECRET'),
  statusPort: num('PORT', 8080),
  // "share" = roll video only while somebody is actually sharing a screen or camera.
  // "call"  = roll for the whole call, share or not. Much larger files.
  videoMode: str('VIDEO_MODE', 'share').toLowerCase(),
};

export function validate() {
  const problems = [];
  if (config.tokens.length === 0) problems.push('DISCORD_TOKEN is not set.');
  if (
    config.watchCategoryNames.length === 0 &&
    config.watchChannelIds.length === 0 &&
    config.watchChannelNames.length === 0
  ) {
    problems.push(
      'Nothing to watch: set WATCH_CATEGORY_NAMES (e.g. "Closers"), WATCH_CHANNEL_NAMES, or WATCH_CHANNEL_IDS.'
    );
  }
  if (!['share', 'call'].includes(config.videoMode)) {
    problems.push(`VIDEO_MODE must be share or call (got "${config.videoMode}").`);
  }
  if (!['off', 'openai', 'local'].includes(config.transcribe)) {
    problems.push(`TRANSCRIBE must be off, openai, or local (got "${config.transcribe}").`);
  }
  if (config.transcribe === 'openai' && !config.openaiApiKey) {
    problems.push('TRANSCRIBE=openai needs OPENAI_API_KEY.');
  }
  return problems;
}

// Audio format used everywhere internally: 48kHz signed 16-bit little-endian stereo.
export const PCM = {
  sampleRate: 48000,
  channels: 2,
  bytesPerSample: 2,
  get bytesPerSecond() {
    return this.sampleRate * this.channels * this.bytesPerSample; // 192000
  },
  get frameBytes() {
    return 960 * this.channels * this.bytesPerSample; // 3840 = 20ms
  },
};
