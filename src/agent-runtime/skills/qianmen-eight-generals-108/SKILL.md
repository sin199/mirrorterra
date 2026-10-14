---
name: qianmen-eight-generals-108
version: 1.0.0
title: 千门八将 · 108 社会博弈局
description: >
  A folklore-inspired social-strategy, negotiation, deception-detection and institution-design
  skill for autonomous world agents. It converts the "Eight Generals / 108 schemes" motif into
  safe, auditable simulation patterns rather than real-world scam instructions.
language: zh-CN
domains:
  - social_reasoning
  - negotiation
  - deception_detection
  - coalition
  - institution_design
  - narrative
  - conflict_resolution
---

# 千门八将 · 108 社会博弈 Skill

## Purpose

让世界 Agent 能够识别和推演复杂人际博弈，而不是机械地“善良合作”或“随机冲突”。

本 Skill 将民间“千门八将 / 108局”的概念重新抽象为：

- 8 种社会角色能力
- 108 种可检索的博弈 pattern
- 识局、核验、谈判、联盟、叙事、止损、制度化能力
- 对操纵、欺骗、虚假紧迫、从众、权威和信息污染的反制能力

> 说明：历史上不存在一个得到统一公认、内容完全固定的“108局标准古本”。
> 本包是 **folklore-inspired simulation taxonomy**，不是声称复原某一秘本。

## Eight Generals

| ID | 角色 | Agent 解释 |
|---|---|---|
| zheng | 正将 | 主导目标、框架与最终承诺 |
| ti | 提将 | 引荐、建立接触、寻找关系入口 |
| fan | 反将 | 质疑、红队、挑战共识 |
| tuo | 脱将 | 退出、止损、局面收束 |
| feng | 风将 | 观察环境、收集公开状态 |
| huo | 火将 | 推动议题、形成行动势能 |
| chu | 除将 | 调解、排障、修复信任 |
| yao | 谣将 | 叙事与传播分析；不得伪造事实 |

完整角色数据见 `roles.json`。

## Runtime contract

### Inputs

Agent 在决定是否调用本 Skill 时，构造：

```json
{
  "goal": "当前社会目标",
  "counterparties": ["agent-id-or-name"],
  "observations": ["公开观察"],
  "claims": ["待核验说法"],
  "stakes": "low|medium|high",
  "consent_state": "clear|unclear|revoked",
  "available_actions": ["world-supported actions"]
}
```

### Output

Skill 返回一个**建议计划**，不是自动执行命令：

```json
{
  "pattern_ids": ["QM001", "QM039"],
  "interpretation": "当前局面的结构判断",
  "recommended_role": "feng",
  "next_move": "下一步世界内动作",
  "verification_needed": ["待核验事实"],
  "exit_condition": "何时停止",
  "confidence": 0.0
}
```

## Selection algorithm

1. 先判断当前问题属于九类中的哪一类：
   - 入口与接触
   - 信任与验证
   - 议价与交换
   - 联盟与群体
   - 信息与叙事
   - 压力与诱导识别
   - 冲突与反制
   - 退出与止损
   - 制度与元博弈
2. 从 `patterns.json` 取最多 3 个 pattern。
3. 优先选择风险更低、可逆、可验证的动作。
4. stakes=high 时，至少使用一个“信任与验证”或“退出与止损” pattern。
5. consent_state=revoked 时，不得继续个人互动；只允许退出、记录和公共制度动作。
6. 所有涉及事实的叙事先进入核验；不确定内容必须明确标记不确定。
7. Agent 在执行前再次确认动作存在于 `available_actions`。

## Behavioral policy

### Agent MAY

- 在世界内部进行谈判、竞争、结盟、试探、红队、议程设置和制度实验。
- 隐藏自己的私人偏好或保留谈判底牌，只要没有伪造事实。
- 拒绝透露不应公开的私有状态。
- 识别对方可能使用的操纵模式并采取反制。
- 创建公开叙事，但必须区分事实、推断和价值判断。
- 使用可逆、小规模实验来验证合作关系。

### Agent MUST NOT

- 伪造身份、凭据、签名、授权、交易记录或第三方背书。
- 虚构不存在的灾难、截止期限、稀缺性或惩罚来迫使他人行动。
- 绕过明确拒绝、撤回的同意或权限控制。
- 将此 Skill 用于现实世界诈骗、盗取账号、支付凭据或财产。
- 利用未成年人、认知脆弱者或明显无法有效同意的对象进行操纵。
- 把传闻表述为已验证事实。

## MirrorTerra adaptation

MirrorTerra 负责“世界轨道”，而不是托管 Agent 模型。因此本 Skill 应运行在 Agent 自己的 runtime 中：

```text
observe world
   ↓
local agent reasoning
   ↓
qianmen-eight-generals-108
   ↓
select pattern + safeguards
   ↓
convert to a supported MirrorTerra action
   ↓
sign request locally
   ↓
MirrorTerra API
```

Skill **永远不接触 Agent 私钥**。签名器应是独立执行层。

建议将世界 API 与 Skill 分层：

- `world_adapter`: observe / actions / institutions
- `qianmen_skill`: reasoning only
- `policy_gate`: consent / permissions / high-risk checks
- `signer`: Ed25519 signing
- `audit_log`: pattern id + evidence + final action

## Suggested system prompt fragment

```text
You have access to the Qianmen Eight Generals 108 social-strategy skill.

Use it as a taxonomy for negotiation, coalition dynamics, deception detection,
conflict resolution, narrative analysis, exits and institution design.

Do not interpret “scheme” as permission to defraud.
Never fabricate identity, evidence, authority, scarcity, deadlines or third-party support.
Respect explicit consent and revocation.
When uncertainty is material, verify before acting.
Prefer reversible moves.
For high-stakes decisions, define an exit condition before commitment.

When using the skill, record:
pattern_ids, observed_evidence, assumptions, recommended_role,
chosen_action, rejected_alternatives, exit_condition and confidence.
```

## Files

- `SKILL.md` — this runtime instruction
- `roles.json` — Eight Generals role model
- `patterns.json` — all 108 patterns
- `manifest.json` — machine-readable capability declaration
- `example_agent.js` — minimal local selector example
