/**
 * 编码器：把一段对话翻译成"要不要记、记成什么"
 *
 * P1 用启发式（离线、零依赖、可测）；P2 换 LLM 时实现同一个接口即可。
 */

const GREETING = /^(在吗|在不在|你好|您好|hi|hello|哈+|嗯+|哦+|好|好的|收到|ok|行|没事|谢谢|晚安|早安|午安|拜拜|再见)[\s!！。.~～]*$/i;

const EMOTION_RULES = [
  { emotion: 'sad', re: /难过|伤心|委屈|想哭|失落|沮丧|emo|抑郁/ },
  { emotion: 'anxiety', re: /焦虑|紧张|担心|害怕|压力|失眠|睡不着|慌/ },
  { emotion: 'angry', re: /生气|愤怒|烦死|气死|讨厌|受不了|郁闷|火大/ },
  { emotion: 'happy', re: /开心|高兴|爽|兴奋|太好了|哈哈|笑死|幸福/ },
  { emotion: 'tired', re: /累|疲惫|加班|熬夜|困/ },
];

const CLASS_RULES = [
  { contentClass: 'secret', re: /秘密|别告诉|只跟你说|不要外传|保密/ },
  { contentClass: 'feeling', re: /难过|焦虑|委屈|开心|生气|害怕|孤独|压力|失眠|情绪|心情/ },
  { contentClass: 'status', re: /辞职|跳槽|面试|入职|离职|裁员|搬家|生病|住院|分手|复合|结婚|离婚|考研|上岸|毕业|换工作|换城市/ },
  { contentClass: 'preference', re: /喜欢|讨厌|爱吃|不吃|最爱|受不了|迷上|入坑|安利/ },
  { contentClass: 'commitment', re: /答应|约好|说好|明天|后天|下周|下个月|记得|提醒我|别忘了|约定/ },
];

const SELF_HINT = /你(自己|觉得|怎么想|是AI|是不是ai)|你是(谁|什么)|机器人|小鲸鱼|大肥鱼/;
const OWNER_HINT = /主人|你老板|owner/i;
const COLLECTIVE_HINT = /大家|群里|咱们|我们群|一起|组团/;

function pickEmotion(text) {
  for (const rule of EMOTION_RULES) if (rule.re.test(text)) return rule.emotion;
  return 'neutral';
}

export function detectContentClass(text) {
  for (const rule of CLASS_RULES) if (rule.re.test(text)) return rule.contentClass;
  return 'event';
}

function makeGist(text, max = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function extractTags(text, max = 3) {
  const hits = [];
  for (const rule of CLASS_RULES) if (rule.re.test(text)) hits.push(rule.contentClass);
  for (const rule of EMOTION_RULES) if (rule.re.test(text)) hits.push(rule.emotion);
  return [...new Set(hits)].slice(0, max);
}

function extractFacts(text, contentClass) {
  // 只对"可能长期有用"的类别抽事实（P1 直接截句；P2 交给 LLM）
  if (!['preference', 'status', 'commitment'].includes(contentClass)) return [];
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  return [flat.length > 40 ? `${flat.slice(0, 39)}…` : flat];
}

/**
 * @param {object} input
 * @param {string} input.text
 * @param {'direct'|'public'} input.channelKind
 * @param {string} input.tier
 * @param {string} input.contactId
 * @returns {object} 编码结果（未过门控）
 */
export function encodeHeuristic({ text, channelKind = 'direct', tier = 'L0', contactId, flags = {} }) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return { worth: false, reason: '空消息', contentClass: 'event', salience: 0 };
  }
  if (GREETING.test(raw)) {
    return { worth: false, reason: '纯寒暄', contentClass: 'event', salience: 0.05 };
  }
  if (raw.length < 4) {
    return { worth: false, reason: '过短且无信息量', contentClass: 'event', salience: 0.05 };
  }

  const contentClass = detectContentClass(raw);
  const emotion = pickEmotion(raw);
  const isSelf = SELF_HINT.test(raw);
  const isOwner = OWNER_HINT.test(raw);
  const isCollective = COLLECTIVE_HINT.test(raw);

  let salience = 0.3;
  if (emotion !== 'neutral') salience += 0.3;
  if (raw.length > 24) salience += 0.15;
  if (contentClass === 'secret' || contentClass === 'commitment') salience += 0.2;
  if (isSelf || isOwner) salience += 0.1;
  salience = Math.max(0, Math.min(1, salience));

  // 隐私级别：默认留在本 channel；熟人以上的公开信息才提到 contact
  let sensitivity = 'channel';
  if (['preference', 'status'].includes(contentClass) && ['L2', 'L3', 'L4'].includes(tier)) {
    sensitivity = 'contact';
  }

  return {
    worth: true,
    contentClass,
    scene: makeGist(raw, 12),
    gist: makeGist(raw),
    emotion,
    salience: Number(salience.toFixed(3)),
    sensitivity,
    tags: extractTags(raw),
    facts: extractFacts(raw, contentClass),
    flags: { aboutSelf: isSelf, aboutOwner: isOwner, collective: isCollective },
    relationSignals: {
      depth: Math.min(1, raw.length / 80),
      emotion: emotion !== 'neutral' ? 0.6 : 0.2,
    },
  };
}

export const encode = encodeHeuristic;
