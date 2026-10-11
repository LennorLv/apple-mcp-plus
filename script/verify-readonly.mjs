// Opt-in local integration checks. Never writes to apps, opens a target, sends
// messages, or requests EventKit authorization. Raw app results stay in memory.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.argv.includes('--bun');
const runtime = source ? 'bun' : 'node';
const expected = ['contacts', 'notes', 'messages', 'mail', 'reminders', 'calendar'];
const hash = value => createHash('sha256').update(value).digest('hex');
const records = [];
const reportDir = path.join(root, '.cache', 'verification');
mkdirSync(reportDir, {recursive: true});
const reportFile = path.join(reportDir, `readonly-${runtime}.json`);
const revision = {
  bundleSha256: hash(readFileSync(path.join(root, 'dist/index.js'))),
  helperSha256: hash(readFileSync(path.join(root, 'dist/eventkit-helper'))),
};
const save = () => writeFileSync(reportFile, JSON.stringify({
  recordedAt: new Date().toISOString(), runtime, revision,
  scope: 'MCP protocol, permissions and read-only calls; not full acceptance',
  counts: Object.fromEntries(['PASS', 'PARTIAL', 'FAIL', 'SKIP'].map(s => [s, records.filter(r => r.status === s).length])),
  records,
}, null, 2) + '\n');
const transport = new StdioClientTransport({
  command: source ? (process.env.APPLE_MCP_BUN || 'bun') : process.execPath,
  args: [path.join(root, source ? 'index.ts' : 'dist/index.js')], cwd: root, stderr: 'pipe',
});
// Legacy stderr can contain app contents. Do not persist or display it.
transport.stderr?.on('data', () => {});
const client = new Client({name: 'apple-mcp-plus-readonly-check', version: '1.0.0'});
const check = async (id, name, args, verify = () => {}, publicArgs = args) => {
  const start = Date.now();
  const row = {id, call: {name, arguments: publicArgs}, durationMs: 0};
  try {
    const r = await client.callTool({name, arguments: args}, undefined, {timeout: 60000});
    row.resultSha256 = hash(JSON.stringify(r));
    const data = r.structuredContent || {};
    if (r.isError) row.errorCode = data.error?.code || 'operation_failed';
    assert(!r.isError, 'MCP returned an error');
    row.arrayCounts = Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
    const state = await verify(data, r);
    row.status = state === 'PARTIAL' ? 'PARTIAL' : 'PASS';
    if (data.meta) row.meta = data.meta;
    if (data.nativeChecklistStatus) row.nativeChecklistStatus = data.nativeChecklistStatus;
    row.durationMs = Date.now() - start; records.push(row); save();
    console.log(JSON.stringify({id, status: row.status, durationMs: row.durationMs}));
    return data;
  } catch (e) {
    // Exception strings may embed personal values. Only store an error digest.
    row.status = 'FAIL'; row.errorSha256 = hash(String(e));
    row.durationMs = Date.now() - start; records.push(row); save();
    console.log(JSON.stringify({id, status: row.status, durationMs: row.durationMs}));
    return null;
  }
};
const array = key => data => assert(Array.isArray(data[key]), `Missing ${key} array`);
const skip = (id, reason) => {records.push({id, status: 'SKIP', reason}); save(); console.log(JSON.stringify({id, status: 'SKIP', reason}));};
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'Apple MCP Plus');
  await client.ping(); records.push({id: 'protocol.initialize-ping', status: 'PASS'});
  const inventory = await client.listTools();
  assert.deepEqual(inventory.tools.map(t => t.name).sort(), [...expected].sort());
  records.push({id: 'protocol.listTools', status: 'PASS', tools: expected}); save();
  for (const name of expected) for (const operation of ['status', 'diagnose']) {
    await check(`${name}.${operation}`, name, {operation}, d => {
      assert.equal(d.tool, name); assert.equal(d.permissionProbePrompts, false);
      assert.equal(typeof d.automation, 'string');
    });
  }
  await check('contacts.list', 'contacts', {}, (d, r) => {
    // Legacy empty address books have text only.
    if (d.contacts) array('contacts')(d); else assert(r.content.some(c => c.type === 'text' && c.text.includes('No contacts found')));
  });
  await check('contacts.search', 'contacts', {name: 'AMCP'}, array('contacts'));
  await check('notes.list', 'notes', {operation: 'list', limit: 3}, d => {
    array('notes')(d); assert(d.notes.length <= 3);
    assert(d.notes.every((n, i, a) => i === 0 || Date.parse(a[i-1].modificationDate) >= Date.parse(n.modificationDate)));
  });
  await check('notes.search', 'notes', {operation: 'search', searchText: 'AMCP', limit: 1}, array('notes'));
  await check('notes.todos', 'notes', {operation: 'todos', limit: 1}, d => {
    array('notes')(d); assert(['available', 'partial', 'unavailable'].includes(d.nativeChecklistStatus));
    return d.nativeChecklistStatus === 'available' ? undefined : 'PARTIAL';
  });
  await check('messages.unread', 'messages', {operation: 'unread', limit: 1}, array('messages'));
  if (process.env.APPLE_MCP_TEST_HANDLE) await check('messages.read', 'messages', {
    operation: 'read', phoneNumber: process.env.APPLE_MCP_TEST_HANDLE, limit: 1,
  }, array('messages'), {operation: 'read', phoneNumber: '<private test handle>', limit: 1});
  else skip('messages.read', 'Set APPLE_MCP_TEST_HANDLE to query an explicitly chosen conversation.');
  await check('mail.accounts', 'mail', {operation: 'accounts'}, array('accounts'));
  await check('mail.mailboxes', 'mail', {operation: 'mailboxes'}, array('mailboxes'));
  await check('mail.latest', 'mail', {operation: 'latest', limit: 3}, array('emails'));
  await check('mail.unread', 'mail', {operation: 'unread', limit: 1}, array('emails'));
  await check('mail.search', 'mail', {operation: 'search', searchTerm: 'AMCP', mailbox: 'inbox', limit: 1}, array('emails'));
  const lists = await check('reminders.lists', 'reminders', {operation: 'lists'}, array('lists'));
  await check('reminders.list.eventkit', 'reminders', {operation: 'list', backend: 'eventkit', completed: false, limit: 2}, d => {
    array('reminders')(d); assert(d.reminders.every(r => r.completed === false)); assert.equal(d.meta.backend, 'eventkit');
  });
  await check('reminders.search.eventkit', 'reminders', {operation: 'search', backend: 'eventkit', searchText: 'AMCP', limit: 1}, array('reminders'));
  if (lists?.lists.length) await check('reminders.listById.eventkit', 'reminders', {
    operation: 'listById', backend: 'eventkit', listId: lists.lists[0].id, props: ['id', 'completed'], limit: 1,
  }, array('reminders'), {operation: 'listById', backend: 'eventkit', listId: '<selected at runtime>', props: ['id', 'completed'], limit: 1});
  else skip('reminders.listById.eventkit', 'No readable native container was available.');
  await check('reminders.list.jxa', 'reminders', {operation: 'list', limit: 1}, d => {
    array('reminders')(d); assert.equal(d.meta.backend, 'jxa');
  });
  const fromDate = new Date().toISOString(), toDate = new Date(Date.now() + 7*86400000).toISOString();
  await check('calendar.calendars', 'calendar', {operation: 'calendars'}, array('calendars'));
  const events = await check('calendar.list.eventkit', 'calendar', {operation: 'list', backend: 'eventkit', limit: 2, fromDate, toDate}, d => {
    array('events')(d); assert.equal(d.meta.backend, 'eventkit');
  });
  await check('calendar.search.eventkit', 'calendar', {operation: 'search', backend: 'eventkit', searchText: 'AMCP', limit: 1, fromDate, toDate}, array('events'));
  if (events?.events.length) {
    const event = events.events[0];
    const args = {operation: 'getById', eventId: event.id, ...(event.isRecurring ? {occurrenceDate: event.occurrenceDate || event.startDate} : {})};
    await check('calendar.getById', 'calendar', args, d => assert.equal(d.event.id, event.id), {
      operation: 'getById', eventId: '<selected at runtime>', ...(args.occurrenceDate ? {occurrenceDate: args.occurrenceDate} : {}),
    });
  } else skip('calendar.getById', 'No native event occurred in the read-only test window.');
  await check('calendar.list.jxa', 'calendar', {operation: 'list', limit: 2, fromDate, toDate}, d => {
    array('events')(d); assert.equal(d.meta.backend, 'jxa');
  });
} finally {await client.close(); save();}
const counts = Object.fromEntries(['PASS', 'PARTIAL', 'FAIL', 'SKIP'].map(s => [s, records.filter(r => r.status === s).length]));
console.log(JSON.stringify({runtime, counts, report: `.cache/verification/readonly-${runtime}.json`}));
if (counts.FAIL) process.exitCode = 1;
