# 发布与登记状态

核对时间（UTC）：2026-10-24

本文件记当前事实。`publication-status.json` 仍是 2026-10-20 那次恢复草稿的快照，不随本页刷新。

## 主干

- `origin/main`：`926a34b7041e51ad25d9425a62b1b06e7dbdd680`
- 该提交是 PR #457 的合并。PR #443 第 3 批第 6 轮收口记录 `batch-3-20261024-r6`，verdict `clean`，仍有效。第 3 批收口通过。
- 第 4 批按前置和收口闸门解锁。本页的遗留 issue 不进入原批次，不改写该收口记录的任务集合。

## 已合入 main

| 登记 | PR | 合并提交 | 状态 |
|---|---|---|---|
| DEP-AUDIT-1 | #420 | `950b63c235a3ce945fa6140dedf0bfad7a946bc3` | 已落地 |
| DEPLOY-FIX-1 | #421 | `40b2eb5c52361ac57390530c7347498e3b2e07b1` | 已落地 |
| DOCKER-UPLOADS-1 | #422 | `0b71952e7c0e15b2cc5cc0549167561e57789fc5` | 已落地 |
| GATE-PATHS-1 | #423 | `78f535ec43e68cb6619a012270f878fdf4e3b954` | 已落地 |
| GATE-PATHS-2 | #435 | `c8ebb9c6d3bf3fe230aae757bf187bfaef3c6d5c` | 已落地 |
| SEO-1 | #445 | `55a5a7111c81d3938b0528c5567b3b50c878f0d7` | 已落地。issue #425 |
| SEO-7 | #445 | `55a5a7111c81d3938b0528c5567b3b50c878f0d7` | 已落地。issue #446，随 #445 合入 |
| CITY-STILL-WEBP | #448 | `369c2e90a2ea92096896e0126f579d61bfe553ea` | 已落地。没有单独 issue |
| #347 前端 | #388 | `2e27ef531bc5f686bf653c132a07db43d4a594e1` | 已合入。线上核对是 FE-347（#424），尚未做完 |

M7-T10 仍是 19 节里的 zod 升级任务，在第 22 批，待派。#420 的合入不把它改成已落地。

## 交接台里的 10/24 登记

源文件是 `04-执行/遗留issue-20261024.md`。状态：

| 登记 | GitHub | 状态 |
|---|---|---|
| FE-347 | #424 | 待派。核对用任务 |
| FE-378 | 待开 issue | 暂不派。线上 `3c45e699` 于 2026-10-24 上线并复验通过，缓存上线前提已满足。现在只剩等 GATE-HARDEN（#438）合入。改 AboutSettings.tsx；合入后要全栈安全审查 |
| SEO-1 | #425 | 已落地。PR #445，合并提交 `55a5a7111c81d3938b0528c5567b3b50c878f0d7`。x-default 用 aboutLanguages()：只发布一种语言时不输出，两种及以上并包含 en 时指向 en |
| SEO-2 | #426 | 已落地。PR #450，合并提交 `6161329671e6e03e47f387643c3772633e2ce673`。issue #426 已关闭 |
| SEO-3 | #427 | 暂不派。等文案和图片定稿 |
| SEO-4 | #428 | 暂不派。等运维确认 APP_ENV=production 的检查 PASS，再走全栈审查 |
| SEO-5 | #429 | 已落地。PR #456，合并提交 `466c8f65eed72fe96db8b9aa5cc7eb30407d2dcd`。合入日按 PT 为 2026-10-24。issue #429 已关闭。fix2 069412f0 已在这次合并里，/de 断言和 canonical/hreflang 注释不是待办 |
| SEO-6 | #444 | 已落地。PR #453，合并提交 `151724cb74ae876c97d6297b169dc7ce49590af9`。issue #444 已关闭 |
| SEO-7 | #446 | 已落地。随 PR #445 合入，合并提交 `55a5a7111c81d3938b0528c5567b3b50c878f0d7`。issue #446 已关闭 |
| CITY-STILL-WEBP | 待开 issue | 已落地。PR #448，合并提交 `369c2e90a2ea92096896e0126f579d61bfe553ea` |
| BE-I18N-P0 | #430 | 已落地。PR #449，合并提交 `a761b058de8bc45c87d19207a411b1cfc204ab82`。issue #430 已关闭。这次不发布新语言 |
| BE-RESET-TTY | #431 | 已落地。PR #455，合并提交 `e12d00e7e384316854e4e04584a57dfcf4108a53`。合入日按 PT 为 2026-10-24。issue #431 已关闭 |
| BE-RESET-STDIN-TTY | 没有单独的 GitHub issue | 已落地。PR #457，合并提交 `926a34b7041e51ad25d9425a62b1b06e7dbdd680`。合入日按 PT 为 2026-10-24。#455 的 P3 跟进 |
| BE-RATELIMIT-P3 | #432 | 已落地。PR #454，合并提交 `3c45e699c41c0e0c01efbba5f4d2e58746193944`。issue #432 已关闭。剩余 P3 见 POST-LAUNCH-P3 |
| BE-350A | #433 | 代码已落地。PR #452，合并提交 `009860c2f28c51f01a1e710f8f5b823b04f20de9`。issue #433 仍开着。运维清单见 BE-350B |
| BE-350B | #433 | 运维执行，未完成。issue #433 仍开着 |
| GATE-HARDEN | #438 | 待合入。等仓库管理员合并 |
| GATE-HARDEN-2 | 待开 issue | 待派。#438 合入后才派。只登记，不实施 |
| POST-LAUNCH-P3 | 待开 issue | 待派。上线后小任务，本次只登记。第 9 条含 VERCEL_ENV。第 2 条保留并放宽 GIF 断言。第 3 条用 curl 验收 404 no-store。另有城市场景 video 的 error 路径先 load() 再 play()。实施时按条目由前端、后端、SEO、UX 审查，敏感路径走全栈安全审，合入后需要部署 |
| FE-404-TITLE | 待开 issue | 待派。P3。404 页标题进 head。不得把 Googlebot 加进 htmlLimitedBots。实施需前端、SEO 审 |

## 审查

自 2026-10-24 起，交接台里各任务的「审查提示词」不再派发。实施由 grok cli 完成后直接开 PR，团队 bot 在 GitHub PR 上审查。审查状态显示为「由 PR 上 bot 审查替代」。

## 待理顺

about 和 privacy 在 11 节仍写 publicBrand。实际实现是 1240，随产品列表和品类页是否铺满一起定。设计结论和其他宽度数值未改。
