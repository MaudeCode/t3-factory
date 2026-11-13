import test from 'node:test';
import assert from 'node:assert/strict';

const { nowSections } = await import('../web/lib/format.js');

const job = (id: string, state: string, extra = {}) => ({ id, state, ...extra });
const ids = (list: { id: string }[]) => list.map(item => item.id);

test('Now lists each source in exactly one section and nothing else', () => {
  const failed = { id: 'op-failed', state: 'done', kind: 'dispatch', input: { ticket: 'APP-9' } };
  const fromSessions = { id: 'op-session', state: 'done', kind: 'dispatch', origin: 'session-tickets', input: { ticket: 'APP-8' } };
  const s = nowSections({
    jobs: [
      job('waiting', 'waiting'), job('working', 'running'), job('starting', 'dispatching'), job('ci', 'running', { prUrls: ['https://github.com/example/app/pull/1'] }),
      job('done', 'complete'), job('settled', 'dismissed'), job('archived', 'running', { historyOnly: true }), job('archived-waiting', 'waiting', { historyOnly: true }),
    ],
    plans: [
      { id: 'chain', state: 'active', target: { key: 'APP-1' }, tickets: [] }, { id: 'epic', state: 'active', epic: { id: 'e', title: 'Epic' }, tickets: [] },
      { id: 'cancelled', state: 'cancelled', target: { key: 'APP-2' }, tickets: [] }, { id: 'finished-epic', state: 'complete', epic: { id: 'f', title: 'Old' }, tickets: [] },
    ],
    operations: [{ id: 'op-queued', state: 'queued', input: {} }, { id: 'op-running', state: 'running', input: {} }, failed, fromSessions],
    reports: [{ data: { ticketId: 'owner', stage: 'owner' } }, { data: { ticketId: 'working', stage: 'working' } }],
    issues: [
      { source: 'Session tickets', href: '/session-tickets', error: { message: 'read failed' } },
      { source: 'Session ticket starts', href: '/session-tickets', error: { problems: [{ title: "Couldn't start APP-8", op: fromSessions }] } },
    ],
  });
  assert.deepEqual(ids(s.needs), ['waiting', 'report-owner', 'problem-Session tickets-read failed', 'problem-Session ticket starts-op-session', 'op-failed']);
  assert.deepEqual(s.needs.map((item: { kind: string }) => item.kind), ['run', 'report', 'problem', 'problem', 'request']);
  assert.deepEqual(ids(s.working), ['working', 'starting']);
  assert.deepEqual(ids(s.ci), ['ci']);
  assert.deepEqual(ids(s.queue), ['op-queued', 'op-running', 'chain', 'epic']);
  assert.deepEqual(s.queue.map((item: { kind: string }) => item.kind), ['request', 'request', 'plan', 'epic']);
});

test('Now is empty when nothing is running, waiting or queued', () => {
  assert.deepEqual(nowSections({}), { needs: [], working: [], ci: [], queue: [] });
});
