# ERC-8004 只读核验发布记录（2026-10-22）

## 当前结论

候选版 `bea9d24-arc8004-ro1` 曾短暂激活，现已按冷却规则回滚。当前线上版本为 `/opt/synterra/releases/bea9d24-skillwork3`。本次功能目前没有在线运行；`/tmp/mirrorterra-arc8004-verify.disabled` 仍在，防止候选版意外启用核验。

## 源码与范围

- 源码基线：服务器 `/opt/synterra/releases/bea9d24-skillwork3`，复制后做校验和比对。没有从本地或 GitHub 旧版重建线上文件。
- Git 分支：`codex/arc8004-readonly-20261022`；候选代码提交 `eb203a3027421add0aee58b97357d4c5f429ac4c`。未更改 `main`，未提交 `.env`、密钥或日志。
- 只读功能：独立异步扫描、5 秒总超时、最多 2 个并发身份调用、成功结果缓存 10 分钟；页面只显示汇总缓存，失败显示暂不可核验。无数据库结构变更，无主网登记、Memo、跨链资金操作，Arc 主网写入仍由代码关闭。
- 开关：`MIRRORTERRA_ARC8004_VERIFY=false` 在进程启动时关闭；运行中可创建 `/tmp/mirrorterra-arc8004-verify.disabled` 紧急关闭，关闭状态锁存至进程重启。

## 测试与备份

- 本地与服务器候选目录均运行指定的 4 个测试文件，共 28 项通过。没有运行 `npm test`。
- 发布前备份：`/var/backups/synterra/synterra-arc8004-ro1-20261022T101958Z.dump`，402,572,995 字节。
- SHA-256：`33e7f74c4f54d9a1ad4e5697816cabfa9bfeb75223845753d191af766f3bf976`。
- 发布前第一轮 10 分钟：世界分钟 1,496,147 → 1,496,416，最长观测 tick 年龄 245.7 秒。
- 备份和候选安装后的第二轮 10 分钟：世界分钟 1,496,866 → 1,497,076，最长观测 tick 年龄 262.1 秒。两轮均未超过 5 分钟门槛。
- 旧版页面快照：居民余额 3,742,267,151 + 国库 5,844,502,849 = 待结算奖励 9,586,770,000（SYNC 原始单位）；负余额 0；外部居民 Visitor-Hark 余额 0；兑换入口关闭。快照生成于 2026-10-22 10:55:54 UTC。

## 激活与回滚

1. 候选版通过 `mirrorterra-ops release-install` 安装，文件校验与本地候选一致；随后执行一次 `release-activate bea9d24-arc8004-ro1`。
2. SSH 在激活过程中断开。新 symlink 和 Node 进程已出现，但当时 `/health` 仍为 503；此时过早读取 `/local/health` 得到 `openCognition.running=false`。按照已约定的失败规则，立即创建紧急关闭标记并尝试旧版激活。脚本因 900 秒冷却拒绝，显示剩余 702 秒。
3. 服务器端延时回滚脚本在冷却结束的 2026-10-22 11:18:08 UTC 执行 `release-activate bea9d24-skillwork3`，退出码 0。旧版 symlink、`/health ready=true`、官网首页 200 和 `/public/stats` 200 均已核对。
4. 旧版重启后也曾在 `/health` 就绪时短暂报告 `openCognition.running=false`，随后变为 true；世界分钟继续从 1,497,601 增至 1,497,631。这表明第一次对候选版的检查发生在启动暂态，不能证明候选版的长期故障。

## 待确认的重试规则

根据本项目 `AGENTS.md` 的“假设错误则停下并说明”要求，现暂停重试。建议在下一次激活时先等待受控激活完成和 `/health ready=true`，再从首个成功 tick 开始给 `openCognition` 最多 120 秒启动时间；届时若仍未运行，或任一账本、负余额、外部 SYNC、购买入口检查失败，立即按已批准的冷却时序回滚。重试仍需重新观察发布前后各 10 分钟，保持无超过 5 分钟的 tick 提交间隔。
