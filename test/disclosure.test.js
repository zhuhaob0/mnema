import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeDisclosure, LEVELS, disclosureInstruction } from '../src/core/disclosure.js';

const rel = (score, tier = 'L2') => ({ score, tier });

test('主体在场：可以说细节（共同经历）', () => {
  const d = computeDisclosure({
    memory: { subject: ['user:b'], participants: ['user:b'], contentClass: 'event', sensitivity: 'channel' },
    audience: ['self', 'user:b'],
    relationships: { 'user:b': rel(0.5) },
  });
  assert.equal(d.level, LEVELS.FULL);
  assert.equal(d.subjectPresent, true);
});

test('主体在场但内容是秘密：降为概括', () => {
  const d = computeDisclosure({
    memory: { subject: ['user:b'], participants: ['user:b'], contentClass: 'secret', sensitivity: 'channel' },
    audience: ['self', 'user:b'],
  });
  assert.equal(d.level, LEVELS.SUMMARY);
});

test('主体不在场：基线只承认知道', () => {
  const d = computeDisclosure({
    memory: { subject: ['user:b'], participants: ['user:b'], contentClass: 'event', sensitivity: 'channel' },
    audience: ['self', 'user:a'],
    relationships: { 'user:a': rel(0.35), 'user:b': rel(0.35) },
  });
  assert.equal(d.level, LEVELS.HINT);
});

test('共享记忆：主体不在场也能说概括', () => {
  const d = computeDisclosure({
    memory: { subject: ['user:b'], sensitivity: 'shared', contentClass: 'preference' },
    audience: ['self', 'user:a'],
  });
  assert.equal(d.level, LEVELS.SUMMARY);
});

test('第三方秘密：最多承认知道（即使听众很熟）', () => {
  const d = computeDisclosure({
    memory: { subject: ['user:b'], sensitivity: 'shared', contentClass: 'secret' },
    audience: ['self', 'user:a'],
    relationships: { 'user:a': rel(0.95) },
  });
  assert.ok(d.level <= LEVELS.HINT, `期望 ≤1，实际 ${d.level}`);
});

test('和主体更亲近：倾向保护他，压低披露', () => {
  const closeAudience = computeDisclosure({
    memory: { subject: ['user:b'], sensitivity: 'shared', contentClass: 'status' },
    audience: ['self', 'user:a'],
    relationships: { 'user:a': rel(0.8), 'user:b': rel(0.3) },
  });
  const closeSubject = computeDisclosure({
    memory: { subject: ['user:b'], sensitivity: 'shared', contentClass: 'status' },
    audience: ['self', 'user:a'],
    relationships: { 'user:a': rel(0.3), 'user:b': rel(0.8) },
  });
  assert.ok(closeSubject.level <= closeAudience.level, '更亲近主体时应更保守');
  assert.equal(closeSubject.level, LEVELS.HINT);
});

test('性格：谨慎的人进一步压低；爱聊的人抬高', () => {
  const base = {
    memory: { subject: ['user:b'], sensitivity: 'shared', contentClass: 'preference' },
    audience: ['self', 'user:a'],
    relationships: { 'user:a': rel(0.4) },
  };
  const discreet = computeDisclosure({ ...base, traits: { discretion: 0.9 } });
  const gossipy = computeDisclosure({ ...base, traits: { gossip: 0.9, discretion: 0.2 } });
  assert.ok(gossipy.level > discreet.level, `爱聊(${gossipy.level}) 应大于 谨慎(${discreet.level})`);
});

test('性格：护短的人替不在场者保留', () => {
  const base = {
    memory: { subject: ['user:b'], sensitivity: 'shared', contentClass: 'status' },
    audience: ['self', 'user:a'],
    relationships: { 'user:a': rel(0.4) },
  };
  const protective = computeDisclosure({ ...base, traits: { protectiveness: 0.95, gossip: 0.2 } });
  const neutral = computeDisclosure({ ...base, traits: { protectiveness: 0.1, gossip: 0.2 } });
  assert.ok(protective.level < neutral.level);
});

test('配置可设硬上限', () => {
  const d = computeDisclosure({
    memory: { subject: ['user:a'], sensitivity: 'channel', contentClass: 'event' },
    audience: ['self', 'user:a'],
    config: { maxLevel: 2 },
  });
  assert.equal(d.level, 2);
});

test('指令文案：等级越低越保守', () => {
  assert.equal(disclosureInstruction(3), null);
  assert.match(disclosureInstruction(2), /概括/);
  assert.match(disclosureInstruction(1), /只承认/);
  assert.match(disclosureInstruction(0), /不要/);
});
