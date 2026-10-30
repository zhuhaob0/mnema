import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gateContent } from '../src/core/gate.js';
import { detectContentClass, encodeHeuristic } from '../src/core/encoder.js';

test('关系等级内容矩阵：L0 不记偏好，L2 记', () => {
  const low = gateContent({ channelKind: 'direct', tier: 'L0', contentClass: 'preference' });
  assert.equal(low.allow, false);

  const mid = gateContent({ channelKind: 'direct', tier: 'L2', contentClass: 'preference' });
  assert.equal(mid.allow, true);
});

test('私事/秘密只有 L4 才允许', () => {
  assert.equal(gateContent({ channelKind: 'direct', tier: 'L3', contentClass: 'secret' }).allow, false);
  assert.equal(gateContent({ channelKind: 'direct', tier: 'L4', contentClass: 'secret' }).allow, true);
});

test('情绪/近况只有 L3 及以上才允许', () => {
  assert.equal(gateContent({ channelKind: 'direct', tier: 'L2', contentClass: 'feeling' }).allow, false);
  assert.equal(gateContent({ channelKind: 'direct', tier: 'L3', contentClass: 'feeling' }).allow, true);
});

test('公共场景：不熟的人不记', () => {
  const r = gateContent({ channelKind: 'public', tier: 'L1', contentClass: 'event', flags: {} });
  assert.equal(r.allow, false);
});

test('公共场景例外：与 Actor 自己相关', () => {
  const r = gateContent({ channelKind: 'public', tier: 'L0', contentClass: 'event', flags: { aboutSelf: true } });
  assert.equal(r.allow, true);
});

test('公共场景例外：熟人以上只记事件与公开偏好', () => {
  assert.equal(gateContent({ channelKind: 'public', tier: 'L2', contentClass: 'event' }).allow, true);
  assert.equal(gateContent({ channelKind: 'public', tier: 'L2', contentClass: 'preference' }).allow, true);
  assert.equal(gateContent({ channelKind: 'public', tier: 'L3', contentClass: 'secret' }).allow, false);
  assert.equal(gateContent({ channelKind: 'public', tier: 'L3', contentClass: 'feeling' }).allow, false);
});

test('编码器：纯寒暄不值得记', () => {
  for (const text of ['在吗', '哈哈哈哈哈', '好的', '晚安']) {
    const coded = encodeHeuristic({ text, channelKind: 'direct', tier: 'L3' });
    assert.equal(coded.worth, false, `"${text}" 不应被记录`);
  }
});

test('编码器：内容分类', () => {
  assert.equal(detectContentClass('我准备跳槽了'), 'status');
  assert.equal(detectContentClass('我特别喜欢猫'), 'preference');
  assert.equal(detectContentClass('我今天好焦虑'), 'feeling');
  assert.equal(detectContentClass('只跟你说个秘密'), 'secret');
  assert.equal(detectContentClass('明天记得提醒我'), 'commitment');
});

test('编码器：隐私级别默认 channel，熟人的公开信息升为 contact', () => {
  const low = encodeHeuristic({ text: '我喜欢吃火锅', channelKind: 'direct', tier: 'L1' });
  assert.equal(low.sensitivity, 'channel');
  const mid = encodeHeuristic({ text: '我喜欢吃火锅', channelKind: 'direct', tier: 'L2' });
  assert.equal(mid.sensitivity, 'contact');
});

test('编码器：显著度随情绪与长度提升', () => {
  const calm = encodeHeuristic({ text: '我今天去超市买了点东西', channelKind: 'direct', tier: 'L2' });
  const emotive = encodeHeuristic({ text: '我今天真的好焦虑，感觉要崩溃了', channelKind: 'direct', tier: 'L2' });
  assert.ok(emotive.salience > calm.salience);
});
