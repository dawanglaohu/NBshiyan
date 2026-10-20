# 本地 main 合并前规格路由复核

范围：以文档工作树 `D:/xiangmu/NBshiyan-docs-s2-s6` 的已提交 `aa2be53` 为基线，仅复核 `LOCAL-MAIN-CLOSEOUT-20261020` 规格输入路由补丁；不执行 verify、commit、merge、push 或删除。

- 可编辑源仅 README 第20行、19节第5行及M1-T1输入/验收3、presentation 的 `handoff.conventions`。`task-contracts.json` 与基线完全一致。未修改生成器、产品代码、布局、素材或生产数据。
- 19节84项任务中，83项源行逐字不变；M1-T1只有输入与验收3变更，验收1/2在 `3)` 前逐字不变。8个token、真实standalone、SSR目录及独立HTTP校验、RUM204与CI冒烟均保留。
- 基线路由为：M1-T1先按既定方式从 `origin/main` 建工作树；远端尚无规格则从已合并的本地 `main` 导入文档和AGENTS/CLAUDE；已有规格则沿用，其他任务等首PR落地。这区分本地合并与远端发布，不再依赖待删临时分支。换机器仍须先传送已提交基线。
- 84个新实施提示均含新约定；所有任务四类实时提示中旧临时分支引用为零，提示内版本与当前contractHash相等。精确归一化公共conventions和各自contractHash后，83项全部四类提示逐字相同；M1-T1四类提示仅含预期输入/验收3差异。
- 旧84项证据的contractHash与aa2be53中的dispatch逐值一致且均为pass；本轮逐项登记当前hash和有限delta继承范围。旧真实模型调用/校准仅作为历史证据，未对新提示hash伪称再调用。
- 实际执行 `python -B .../_run/review.py ... --json`：退出0，0阻断/28既有警告，条目与基线完全相同；`python -B .../_run/build_vault.py ... --check`：退出0，7模块/84任务/111边界，无问题，实施沉淀0/84。生成器未改，未重跑214项工具测试。
- `review` sourceVersion：`678aa6b3d94a79146d19989bb69134e830ae21a1df9ddedbe597fb36c178c5cb`。三项源SHA256见下。本报告不确认尚待主代理执行的Git合并/清理状态；用户最终的“已合并”必须由合并后main实际引用与祖先关系再验证。

| 源 | SHA256 |
|---|---|
| 04-执行/19-模块任务拆分.md | `7b8bb2e82917688c456f8a3aa8758824225be9278b85de70c25f0fb9ab7caa6c` |
| README.md | `4ddd86786548662362e5a171152765e814f5ae6e06bffafdb9b62dd87b895b31` |
| _run/presentation.json | `b8b3b241f8312ce92cc3a7ef2537a6c4d12800b02c44f9ca6561973792773037` |

84项当前契约的逐项证据在同目录 `evidence.json`，可交维护工具登记。产品任务仍未落地。

VERDICT: PASS
