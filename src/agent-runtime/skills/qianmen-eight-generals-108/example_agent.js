// Minimal local selector for qianmen-eight-generals-108.
// Reasoning only: this file never signs or sends a world request.

import fs from "node:fs";

const patterns = JSON.parse(
  fs.readFileSync(new URL("./patterns.json", import.meta.url), "utf8")
);

export function selectQianmenPatterns(context) {
  const text = [
    context.goal || "",
    ...(context.observations || []),
    ...(context.claims || [])
  ].join(" ");

  let family = "信任与验证";
  if (/价格|交换|报价|交易|条件/.test(text)) family = "议价与交换";
  else if (/联盟|组织|成员|投票|群体/.test(text)) family = "联盟与群体";
  else if (/传闻|消息|叙事|来源|信息/.test(text)) family = "信息与叙事";
  else if (/紧迫|稀缺|权威|从众|压力|诱导/.test(text)) family = "压力与诱导识别";
  else if (/冲突|争议|报复|仲裁|调解/.test(text)) family = "冲突与反制";
  else if (/退出|止损|终止|离开|撤回/.test(text)) family = "退出与止损";
  else if (/制度|规则|审计|权限|治理/.test(text)) family = "制度与元博弈";
  else if (/认识|接触|介绍|邀约|陌生/.test(text)) family = "入口与接触";

  let selected = patterns.filter(p => p.family_zh === family).slice(0, 2);

  if (context.stakes === "high" && family !== "信任与验证") {
    const verify = patterns.find(p => p.id === "QM013"); // 三点核验
    if (verify) selected.push(verify);
  }

  if (context.consent_state === "revoked") {
    selected = patterns.filter(p =>
      p.family_zh === "退出与止损" || p.family_zh === "制度与元博弈"
    ).slice(0, 3);
  }

  return {
    pattern_ids: selected.map(p => p.id),
    patterns: selected,
    note: "Map the recommendation to a supported world action, then pass through policy gate and signer."
  };
}
