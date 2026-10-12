// Checklists in any text channel. Type /todo, list the tasks one per line,
// and the bot posts the list with a numbered button per task. Tapping a
// button crosses the task out; tapping it again brings it back.
//
// There is no database. The list IS the Discord message: every click reads
// the tasks back out of the message it was made on and writes the new state
// into that same message. A restart, a redeploy or a wiped volume cannot lose
// a list, and nothing here can affect recording - every handler is fenced off
// with its own try/catch.
//
// Replies go back through the interaction itself, not a normal channel
// message, so the bot needs no Send Messages / Embed Links permission in the
// channel. It works in any text channel the person typing /todo can use.

import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  escapeMarkdown,
} from 'discord.js';

export const MAX_ITEMS = 20; // 4 rows of 5 buttons; the 5th row is Add / Clear
export const MAX_TEXT = 200; // per task, before escaping
const MAX_DESCRIPTION = 4000; // Discord's limit is 4096; keep a margin
const MAX_TITLE = 100;
const DEFAULT_TITLE = 'To-Do';

const OPEN = '⬜';
const DONE = '✅';
const LINE = /^(⬜|✅) \*\*(\d+)\.\*\* (.*)$/u;

const COLOR_OPEN = 0x5865f2;
const COLOR_DONE = 0x57f287;

// ─── pure state: parse / render / edit ──────────────────────────────────────

/** Short fingerprint of a task, carried in its button so a stale click can
 *  never tick the wrong task after the list has been reshuffled. */
export function fingerprint(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/** User text -> one stored task: single line, trimmed, capped, markdown-safe. */
export function cleanTask(raw) {
  const flat = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s+/, '') // pasted "- ", "1. ", "[ ] "
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // invisible characters
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  // Cut by character, not UTF-16 unit, so an emoji is never split in half.
  const cps = Array.from(flat);
  const capped = cps.length > MAX_TEXT ? `${cps.slice(0, MAX_TEXT - 1).join('')}…` : flat;
  return escapeMarkdown(capped);
}

export function cleanTitle(raw) {
  const flat = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return flat || DEFAULT_TITLE;
}

/** Reads a list back out of the embed the bot posted. Returns null if the
 *  message isn't one of ours. */
export function parseList(embed) {
  if (!embed) return null;
  const title = embed.title ?? DEFAULT_TITLE;
  const items = [];
  const desc = embed.description ?? '';
  for (const line of desc.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const done = m[1] === DONE;
    let text = m[3];
    if (done && text.startsWith('~~') && text.endsWith('~~') && text.length >= 4) {
      text = text.slice(2, -2);
    }
    items.push({ done, text });
  }
  return { title, items };
}

export function describe(items) {
  if (items.length === 0) return '_Nothing on this list. Tap **➕ Add** to add tasks._';
  return items
    .map((it, i) => `${it.done ? DONE : OPEN} **${i + 1}.** ${it.done ? `~~${it.text}~~` : it.text}`)
    .join('\n');
}

/** Adds tasks until the list or the message is full. Returns what didn't fit. */
export function addTasks(list, rawLines) {
  const skipped = [];
  for (const raw of rawLines) {
    const text = cleanTask(raw);
    if (!text) continue;
    if (list.items.length >= MAX_ITEMS) {
      skipped.push(text);
      continue;
    }
    list.items.push({ done: false, text });
    if (describe(list.items).length > MAX_DESCRIPTION) {
      list.items.pop();
      skipped.push(text);
    }
  }
  return skipped;
}

/** Toggles the task a button points at. Matches on fingerprint first so a
 *  click from an out-of-date copy of the message still hits the right task -
 *  or nothing at all, never a different one. */
export function toggle(list, index, fp) {
  const at = list.items[index];
  if (at && fingerprint(at.text) === fp) {
    at.done = !at.done;
    return true;
  }
  const match = list.items.find((it) => fingerprint(it.text) === fp);
  if (match) {
    match.done = !match.done;
    return true;
  }
  return false;
}

export function clearDone(list) {
  const before = list.items.length;
  list.items = list.items.filter((it) => !it.done);
  return before - list.items.length;
}

export function render(list) {
  const doneCount = list.items.filter((it) => it.done).length;
  const total = list.items.length;
  const allDone = total > 0 && doneCount === total;

  const embed = new EmbedBuilder()
    .setTitle(list.title)
    .setDescription(describe(list.items))
    .setColor(allDone ? COLOR_DONE : COLOR_OPEN)
    .setFooter({ text: total ? `${doneCount} of ${total} done${allDone ? ' 🎉' : ''}` : 'Empty list' });

  const rows = [];
  for (let start = 0; start < list.items.length; start += 5) {
    const row = new ActionRowBuilder();
    list.items.slice(start, start + 5).forEach((it, j) => {
      const i = start + j;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`todo:t:${i}:${fingerprint(it.text)}`)
          .setLabel(it.done ? `✓ ${i + 1}` : `${i + 1}`)
          .setStyle(it.done ? ButtonStyle.Success : ButtonStyle.Secondary)
      );
    });
    rows.push(row);
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('todo:add')
        .setLabel('➕ Add')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(list.items.length >= MAX_ITEMS),
      new ButtonBuilder()
        .setCustomId('todo:clear')
        .setLabel('🧹 Clear done')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(doneCount === 0)
    )
  );
  return { embeds: [embed], components: rows };
}

// ─── Discord wiring ─────────────────────────────────────────────────────────

const COMMAND = {
  name: 'todo',
  description: 'Post a checklist in this channel - tap a number to cross a task off',
};

function itemsModal(customId, title, { withTitle }) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  if (withTitle) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('List name (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(MAX_TITLE)
          .setPlaceholder(DEFAULT_TITLE)
      )
    );
  }
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('items')
        .setLabel('Tasks - one per line')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setPlaceholder('Call the seller on Oak St\nSend contract to title\nUpdate the CRM')
    )
  );
  return modal;
}

function lines(text) {
  return String(text ?? '').split(/\r?\n/);
}

function skippedNote(skipped) {
  if (!skipped.length) return null;
  return `${skipped.length} task(s) didn't fit - a list holds up to ${MAX_ITEMS}. Start another with \`/todo\`.`;
}

export function setupTodo(client, log) {
  // Every click on a list is applied one at a time, against the newest copy
  // of that list, so two people tapping at once can't overwrite each other.
  const latest = new Map(); // messageId -> list (newest state we wrote)
  const queues = new Map(); // messageId -> promise chain

  function remember(id, list) {
    latest.delete(id);
    latest.set(id, list);
    if (latest.size > 1000) latest.delete(latest.keys().next().value);
  }

  function serial(id, fn) {
    const prev = queues.get(id) ?? Promise.resolve();
    // If an edit fails we can't know whether Discord applied it, so forget
    // our copy and let the next click read the message itself.
    const run = () =>
      fn().catch((err) => {
        latest.delete(id);
        throw err;
      });
    const next = prev.then(run, run);
    const tail = next.catch(() => {});
    queues.set(id, tail);
    tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return next;
  }

  function current(message) {
    const cached = latest.get(message.id);
    if (cached) return structuredClone(cached);
    return parseList(message.embeds?.[0]);
  }

  async function registerIn(guild) {
    try {
      await guild.commands.create(COMMAND);
      log.info(`/todo ready in "${guild.name}"`);
    } catch (err) {
      log.warn(`could not register /todo in "${guild.name}": ${err.message}`);
    }
  }

  for (const guild of client.guilds.cache.values()) registerIn(guild);
  client.on('guildCreate', (guild) => registerIn(guild));

  client.on('interactionCreate', async (interaction) => {
    try {
      // /todo -> ask for the tasks
      if (interaction.isChatInputCommand() && interaction.commandName === 'todo') {
        await interaction.showModal(itemsModal('todo:new', 'New to-do list', { withTitle: true }));
        return;
      }

      // ➕ Add -> ask for more tasks for this list
      if (interaction.isButton() && interaction.customId === 'todo:add') {
        await interaction.showModal(itemsModal('todo:more', 'Add tasks', { withTitle: false }));
        return;
      }

      // New list submitted -> post it
      if (interaction.isModalSubmit() && interaction.customId === 'todo:new') {
        const list = { title: cleanTitle(interaction.fields.getTextInputValue('title')), items: [] };
        const skipped = addTasks(list, lines(interaction.fields.getTextInputValue('items')));
        if (list.items.length === 0) {
          await interaction.reply({ content: 'That list was empty - type at least one task.', flags: MessageFlags.Ephemeral });
          return;
        }
        const reply = await interaction.reply({ ...render(list), withResponse: true });
        const msgId = reply?.resource?.message?.id;
        if (msgId) remember(msgId, list);
        const note = skippedNote(skipped);
        if (note) await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral });
        return;
      }

      // More tasks submitted from a list's ➕ Add button
      if (interaction.isModalSubmit() && interaction.customId === 'todo:more' && interaction.message) {
        const message = interaction.message;
        await interaction.deferUpdate();
        let skipped = [];
        await serial(message.id, async () => {
          const list = current(message);
          if (!list) return;
          skipped = addTasks(list, lines(interaction.fields.getTextInputValue('items')));
          await interaction.editReply(render(list));
          remember(message.id, list);
        });
        const note = skippedNote(skipped);
        if (note) await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral });
        return;
      }

      // A task's number, or 🧹 Clear done
      if (interaction.isButton() && interaction.customId.startsWith('todo:')) {
        const message = interaction.message;
        await interaction.deferUpdate();
        await serial(message.id, async () => {
          const list = current(message);
          if (!list) return;
          let changed = false;
          if (interaction.customId === 'todo:clear') {
            changed = clearDone(list) > 0;
          } else {
            const [, kind, idx, fp] = interaction.customId.split(':');
            if (kind === 't') changed = toggle(list, Number(idx), fp);
          }
          if (!changed) return;
          await interaction.editReply(render(list));
          remember(message.id, list);
        });
      }
    } catch (err) {
      log.warn(`to-do interaction failed: ${err?.message ?? err}`);
      try {
        const msg = { content: "Couldn't update that list - try once more.", flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
        else if (interaction.isRepliable()) await interaction.reply(msg);
      } catch {}
    }
  });
}
