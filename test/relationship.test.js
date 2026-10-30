import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDecay, blendScore, deriveSignals, scoreFromSignals, tierFromScore,
} from '../src/core/relationship.js';

const NOW = new Date('2026-10-30T12:00:00Z').getTime();

function ev(daysAgo, participants = ['user:1'], extra = {}) {
  const at = new Date(NOW - daysAgo * 86400000).toISOString();
  return { at, participants, gist: extra.gist ?? '一条普通消息', emotion: extra.emotion ?? 'neutral' };
}

test('等级阈值', () => {
  assert.equal(tierFromScore(0.05), 'L0');
  assert.equal(tierFromScore(0.2), 'L1');
  assert.equal(tierFromScore(0.4), 'L2');
  assert.equal(tierFromScore(0.7), 'L3');
  assert.equal(tierFromScore(0.9), 'L4');
});

test('信号：互动多 + 情绪多 → 分数更高', () => {
  const few = deriveSignals({ events: [ev(1)], contactId: 'user:1', now: NOW });
  const many = deriveSignals({
    events: Array.from({ length: 40 }, (_, i) => ev(i % 20, ['user:1'], { emotion: 'sad', gist: '我今天很难过，压力很大' })),
    contactId: 'user:1',
    now: NOW,
  });
  const low = scoreFromSignals(few);
  const high = scoreFromSignals(many);
  assert.ok(high > low, `期望 ${high} > ${low}`);
});

test('信号：只统计该联系人的事件', () => {
  const events = [ev(1, ['user:1']), ev(1, ['user:2']), ev(1, ['user:2'])];
  const s = deriveSignals({ events, contactId: 'user:1', now: NOW });
  assert.equal(s.eventCount, 1);
});

test('滑动平均：不会因一次长谈暴涨', () => {
  const sudden = blendScore(0.1, 1, 0.7);
  assert.ok(sudden < 0.5, `平滑后应远小于 1，实际 ${sudden}`);
  assert.ok(sudden > 0.1);
});

test('首次无历史时直接采用信号值', () => {
  assert.equal(blendScore(null, 0.6), 0.6);
});

test('降温：30 天内不衰减，之后每周 ×0.9，且有下限', () => {
  const cfg = { decayAfterDays: 30, decayPerWeek: 0.9, floor: 0.05 };
  const recent = applyDecay({ score: 0.8, lastInteract: new Date(NOW - 10 * 86400000).toISOString(), now: NOW, cfg });
  assert.equal(recent, 0.8);

  const month = applyDecay({ score: 0.8, lastInteract: new Date(NOW - 37 * 86400000).toISOString(), now: NOW, cfg });
  assert.ok(month < 0.8 && month > 0.7, `一周应衰减约 10%，实际 ${month}`);

  const longIdle = applyDecay({ score: 0.5, lastInteract: new Date(NOW - 365 * 86400000).toISOString(), now: NOW, cfg });
  assert.ok(longIdle >= 0.05, `不应低于下限，实际 ${longIdle}`);
});
