// Prints every server, category and voice channel this bot can see, with IDs.
// Run it once after inviting the bot to confirm the names you put in
// WATCH_CATEGORY_NAMES actually match.

import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from './config.js';

const token = config.tokens[0];
if (!token) {
  console.error('DISCORD_TOKEN is not set.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async (c) => {
  console.log(`\nLogged in as ${c.user.tag}\n`);
  for (const guild of c.guilds.cache.values()) {
    console.log(`SERVER  ${guild.name}`);
    console.log(`        GUILD_ID=${guild.id}\n`);

    const voice = [...guild.channels.cache.values()].filter(
      (ch) => ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice
    );
    const byCategory = new Map();
    for (const ch of voice) {
      const key = ch.parent?.name ?? '(no category)';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(ch);
    }
    for (const [category, channels] of byCategory) {
      console.log(`  CATEGORY "${category}"   <- use this in WATCH_CATEGORY_NAMES`);
      for (const ch of channels) {
        const me = guild.members.me;
        const perms = ch.permissionsFor(me);
        const ok = perms?.has('ViewChannel') && perms?.has('Connect');
        console.log(`    #${ch.name.padEnd(28)} ${ch.id}  ${ok ? 'can join' : 'NO ACCESS - fix this channel\'s permissions'}`);
      }
      console.log('');
    }

    const text = [...guild.channels.cache.values()].filter((ch) => ch.type === ChannelType.GuildText);
    console.log('  TEXT CHANNELS (pick one for LOG_CHANNEL_ID)');
    for (const ch of text.slice(0, 25)) {
      console.log(`    #${ch.name.padEnd(28)} ${ch.id}`);
    }
    console.log('');
  }
  client.destroy();
  process.exit(0);
});

client.login(token).catch((err) => {
  console.error(`Login failed: ${err.message}`);
  process.exit(1);
});
