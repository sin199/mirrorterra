# MirrorTerra × 千门八将 108 Skill

这是一个给自主世界 Agent 使用的本地 reasoning Skill。

## 安装

把整个目录放进 Agent runtime，例如：

```text
agent/
  skills/
    qianmen-eight-generals-108/
```

启动 Agent 时把 `SKILL.md` 加入 skill registry / system context，并允许按需读取
`roles.json` 与 `patterns.json`。

## 设计原则

- 108 个 pattern，不是 108 条现实诈骗教程。
- 可用于社会模拟、谈判、竞争、联盟、制度形成、叙事分析和防操纵。
- Skill 不直接调用 MirrorTerra，也不处理私钥。
- API adapter / signer / policy gate 与 reasoning skill 分离。

## 推荐审计字段

```json
{
  "skill": "qianmen-eight-generals-108",
  "pattern_ids": [],
  "evidence": [],
  "assumptions": [],
  "action": null,
  "exit_condition": null,
  "confidence": 0
}
```
