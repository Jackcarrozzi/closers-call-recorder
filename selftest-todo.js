// Proves the to-do lists round-trip through Discord's message format: what the
// bot renders, it can read back exactly, toggles hit the right task even from
// a stale copy, and nothing ever breaks Discord's size limits.
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import {
  MAX_ITEMS,
  addTasks,
  clearDone,
  cleanTask,
  fingerprint,
  parseList,
  render,
  setupTodo,
  toggle,
} from './todo.js';

const embedOf = (list) => render(list).embeds[0].toJSON();
const roundTrip = (list) => parseList(embedOf(list));

// 1. Render -> parse is lossless, including nasty markdown.
const nasty = ['Call **seller** on Oak St', '~~already~~ crossed', 'under_score *star* `tick` > quote', '1. numbered paste', '- dashed paste', '[ ] box paste', '   ', 'x'.repeat(500)];
const list = { title: 'Monday', items: [] };
const skipped = addTasks(list, nasty);
assert.equal(skipped.length, 0);
assert.equal(list.items.length, 7, 'blank line dropped');
assert.equal(list.items[3].text, 'numbered paste');
assert.equal(list.items[4].text, 'dashed paste');
assert.equal(list.items[5].text, 'box paste');
assert.ok(list.items[6].text.endsWith('…'));
assert.deepEqual(roundTrip(list), list);

// 2. Toggle, round trip, toggle back.
toggle(list, 1, fingerprint(list.items[1].text));
assert.equal(list.items[1].done, true);
assert.deepEqual(roundTrip(list), list);
assert.match(embedOf(list).description.split('\n')[1], /^✅ \*\*2\.\*\* ~~.*~~$/u);
toggle(list, 1, fingerprint(list.items[1].text));
assert.equal(list.items[1].done, false);
assert.deepEqual(roundTrip(list), list);

// 3. A stale click (index shifted by Clear done) still hits the right task, and
//    a click for a task that's gone does nothing.
const a = { title: 'T', items: [] };
addTasks(a, ['one', 'two', 'three']);
const fpThree = fingerprint(a.items[2].text);
const fpOne = fingerprint(a.items[0].text);
toggle(a, 0, fpOne);
clearDone(a); // "one" removed; "three" now index 1
assert.equal(toggle(a, 2, fpThree), true);
assert.equal(a.items[1].text, 'three');
assert.equal(a.items[1].done, true);
assert.equal(toggle(a, 0, fpOne), false, 'removed task cannot be toggled');

// 4. Limits: 20 tasks max, Discord component and length limits respected.
const big = { title: 'Big', items: [] };
const over = addTasks(big, Array.from({ length: 30 }, (_, i) => `task ${i + 1}`));
assert.equal(big.items.length, MAX_ITEMS);
assert.equal(over.length, 10);
const payload = render(big);
const rows = payload.components.map((r) => r.toJSON());
assert.ok(rows.length <= 5, 'at most 5 rows');
for (const r of rows) assert.ok(r.components.length <= 5, 'at most 5 buttons per row');
const ids = rows.flatMap((r) => r.components.map((c) => c.custom_id));
assert.equal(new Set(ids).size, ids.length, 'custom ids unique');
for (const id of ids) assert.ok(id.length <= 100);
assert.equal(rows.at(-1).components[0].disabled, true, 'Add disabled when full');

const worst = { title: 'Worst', items: [] };
const worstSkipped = addTasks(worst, Array.from({ length: 20 }, () => '*_~`|>'.repeat(40)));
assert.ok(embedOf(worst).description.length <= 4096);
assert.ok(worst.items.length + worstSkipped.length === 20);
assert.deepEqual(roundTrip(worst), worst);

// 5. Duplicate task text: toggling one copy toggles that copy only.
const dup = { title: 'D', items: [] };
addTasks(dup, ['same', 'same']);
toggle(dup, 1, fingerprint('same'));
assert.deepEqual(dup.items.map((i) => i.done), [false, true]);

// 6. Empty list and non-list messages.
const empty = { title: 'E', items: [] };
assert.deepEqual(roundTrip(empty), empty);
assert.equal(parseList(undefined), null);
assert.equal(cleanTask('  \n '), '');

// 7. End to end with a fake Discord client: /todo, submit, two simultaneous
//    clicks, ➕ Add, Clear done. Nothing may be lost to the race.
const client = new EventEmitter();
client.guilds = { cache: new Map() };
const silent = { info() {}, warn(m) { throw new Error(`unexpected warn: ${m}`); } };
setupTodo(client, silent);

const message = { id: 'm1', embeds: [] };
const fake = (props) => ({
  isChatInputCommand: () => false,
  isButton: () => false,
  isModalSubmit: () => false,
  isRepliable: () => true,
  deferred: false,
  replied: false,
  async deferUpdate() { this.deferred = true; },
  async editReply(p) {
    await new Promise((r) => setTimeout(r, 5)); // let the race actually overlap
    message.embeds = [p.embeds[0].toJSON()];
    message.components = p.components.map((c) => c.toJSON());
  },
  async followUp() {},
  ...props,
});
const emit = async (i) => {
  client.emit('interactionCreate', i);
  await new Promise((r) => setTimeout(r, 60));
};

let shown;
await emit(fake({ isChatInputCommand: () => true, commandName: 'todo', async showModal(m) { shown = m.toJSON(); } }));
assert.equal(shown.custom_id, 'todo:new');

await emit(fake({
  isModalSubmit: () => true,
  customId: 'todo:new',
  fields: { getTextInputValue: (k) => (k === 'title' ? 'Deals' : 'one\ntwo\nthree') },
  async reply(p) {
    message.embeds = [p.embeds[0].toJSON()];
    message.components = p.components.map((c) => c.toJSON());
    return { resource: { message: { id: message.id } } };
  },
}));
assert.equal(parseList(message.embeds[0]).items.length, 3);

const btn = (n) => message.components.flatMap((r) => r.components)[n].custom_id;
const id1 = btn(0);
const id3 = btn(2);
// Both people saw the same original message - the classic lost-update race.
const stale = { ...message, embeds: [...message.embeds] };
client.emit('interactionCreate', fake({ isButton: () => true, customId: id1, message: stale }));
client.emit('interactionCreate', fake({ isButton: () => true, customId: id3, message: stale }));
await new Promise((r) => setTimeout(r, 100));
assert.deepEqual(parseList(message.embeds[0]).items.map((i) => i.done), [true, false, true], 'both clicks kept');

await emit(fake({ isModalSubmit: () => true, customId: 'todo:more', message, fields: { getTextInputValue: () => 'four' } }));
assert.deepEqual(parseList(message.embeds[0]).items.map((i) => i.text), ['one', 'two', 'three', 'four']);

await emit(fake({ isButton: () => true, customId: 'todo:clear', message }));
assert.deepEqual(parseList(message.embeds[0]).items.map((i) => i.text), ['two', 'four']);

// After a restart (fresh handler, empty memory) the list still works from the message alone.
const client2 = new EventEmitter();
client2.guilds = { cache: new Map() };
setupTodo(client2, silent);
client2.emit('interactionCreate', fake({ isButton: () => true, customId: message.components[0].components[1].custom_id, message }));
await new Promise((r) => setTimeout(r, 60));
assert.deepEqual(parseList(message.embeds[0]).items.map((i) => i.done), [false, true]);

console.log('todo selftest passed');

// 8. Truncation never splits an emoji.
const emo = cleanTask('x'.repeat(198) + '😀yy');
assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emo), 'no lone surrogate');
assert.equal(cleanTask('​​'), '');
console.log('todo edge cases passed');
