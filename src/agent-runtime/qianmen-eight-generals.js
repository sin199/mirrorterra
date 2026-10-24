import { readFileSync } from 'node:fs';

const SKILL_NAME = 'qianmen-eight-generals-108';
const FAMILIES = new Set([
  '入口与接触', '信任与验证', '议价与交换', '联盟与群体', '信息与叙事',
  '压力与诱导识别', '冲突与反制', '退出与止损', '制度与元博弈'
]);

function loadPatterns() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./skills/qianmen-eight-generals-108/patterns.json', import.meta.url), 'utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 108) return null;
    const ids = new Set();
    const familyCounts = new Map();
    for (const pattern of parsed) {
      if (!pattern || !/^QM\d{3}$/.test(pattern.id) || ids.has(pattern.id)
          || !FAMILIES.has(pattern.family_zh)
          || typeof pattern.name_zh !== 'string' || pattern.name_zh.length > 80
          || typeof pattern.summary_zh !== 'string' || pattern.summary_zh.length > 240
          || !['low', 'medium'].includes(pattern.risk)
          || !Array.isArray(pattern.allowed_moves) || pattern.allowed_moves.length === 0 || !pattern.allowed_moves.every((move) =>
            typeof move === 'string' && move.length <= 180)
          || !Array.isArray(pattern.counterplay) || pattern.counterplay.length === 0 || !pattern.counterplay.every((move) =>
            typeof move === 'string' && move.length <= 180)) return null;
      ids.add(pattern.id);
      familyCounts.set(pattern.family_zh, (familyCounts.get(pattern.family_zh) || 0) + 1);
    }
    if (ids.size !== 108 || Array.from({ length: 108 }, (_, index) => `QM${String(index + 1).padStart(3, '0')}`)
      .some((id) => !ids.has(id)) || familyCounts.size !== FAMILIES.size
        || [...familyCounts.values()].some((count) => count !== 12)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const PATTERNS = loadPatterns();

function safeText(value, limit = 500) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function contextList(value, limit = 8) {
  return Array.isArray(value) ? value.slice(0, limit).map((item) => safeText(item, 160)).filter(Boolean) : [];
}

function relevantFamily(context) {
  const goalText = [safeText(context.goal), ...contextList(context.observations, 4)].join(' ').toLowerCase();
  const text = `${goalText} ${contextList(context.claims, 4).join(' ')}`.toLowerCase();
  const rules = [
    [/(冲突|争议|报复|仲裁|调解|conflict|dispute|retaliat|arbitrat|mediat)/, '冲突与反制'],
    [/(紧迫|稀缺|权威|从众|压力|诱导|urgency|scarcity|authority|pressure|coercion)/, '压力与诱导识别'],
    [/(传闻|消息|叙事|来源|信息|研究|学习|核验|证据|rumou?r|narrative|source|information|research|learn|verify|evidence)/, '信息与叙事'],
    [/(交易|交换|议价|报价|财富|薪酬|business|wealth|price|exchange|bargain|trade)/, '议价与交换'],
    [/(联盟|组织|成员|群体|合作|关系|community|relationship|cooperat|alliance|group|socialize)/, '联盟与群体'],
    [/(制度|规则|审计|权限|治理|institution|rule|audit|permission|governance)/, '制度与元博弈'],
    [/(退出|止损|终止|离开|撤回|exit|withdraw|leave|stop)/, '退出与止损'],
    [/(接触|介绍|邀约|陌生|联系|contact|introduction|invite|meet)/, '入口与接触']
  ];
  return rules.find(([pattern]) => pattern.test(goalText))?.[1]
    || rules.find(([pattern]) => pattern.test(text))?.[1]
    || '信任与验证';
}

function compactPattern(pattern) {
  return {
    id: pattern.id,
    name: pattern.name_zh,
    family: pattern.family_zh,
    summary: pattern.summary_zh,
    allowedMoves: pattern.allowed_moves.slice(0, 2),
    counterplay: pattern.counterplay.slice(0, 2)
  };
}

// Return a small, read-only reasoning reference. This selector never creates an action.
export function selectQianmenPatterns(context = {}) {
  if (!PATTERNS) return { enabled: false, skill: SKILL_NAME, patternIds: [], patterns: [] };

  const consentState = ['clear', 'unclear', 'revoked'].includes(context.consent_state)
    ? context.consent_state : 'unclear';
  let selected;
  if (consentState === 'revoked') {
    const exits = PATTERNS.filter((pattern) => pattern.family_zh === '退出与止损').slice(0, 2);
    const institutions = PATTERNS.filter((pattern) => pattern.family_zh === '制度与元博弈').slice(0, 1);
    selected = [...exits, ...institutions];
  } else {
    const family = relevantFamily(context);
    selected = PATTERNS.filter((pattern) => pattern.family_zh === family).slice(0, 2);
    if (context.stakes === 'high' && family !== '信任与验证') {
      const verification = PATTERNS.find((pattern) => pattern.family_zh === '信任与验证');
      if (verification) selected.push(verification);
    }
  }

  selected = selected.slice(0, 3);
  return {
    enabled: selected.length > 0,
    skill: SKILL_NAME,
    patternIds: selected.map((pattern) => pattern.id),
    patterns: selected.map(compactPattern)
  };
}

// gambit1: read-only access to the validated 108 patterns (null when patterns.json fails validation).
export function qianmenPatterns() { return PATTERNS; }
