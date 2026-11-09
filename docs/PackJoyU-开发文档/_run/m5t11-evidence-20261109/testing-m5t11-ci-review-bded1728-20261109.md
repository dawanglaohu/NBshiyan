# B9-M5T11-CI-DIFF-REVIEW 非作者差量审查

- 执行：2026-11-09 03:11–03:40 PST（UTC-08:00），测试工程师（非作者）
- 任务树：`D:/xiangmu/NBshiyan-m5-t11`，本单**全程只读**（未写任何仓库文件；开始时 HEAD 未变、0 dirty）
- 未运行：`status`/`verify`/`build` 等会写派生的命令、数据库、e2e、远端 CI；未启停 PG/WSL/服务
- 只写：本任务 planning `testing-m5t11-ci-review-20261109/`（报告、提取脚本、合成夹具、日志）
- **并发写入提示（非本单行为）**：审查收尾时（03:36 PST 起）另一窗口在同一任务树写入批量单位补丁 `m5t11-batch-units-20261109`（status `syncing`，`head=bded1728`），工作树随后出现 4 个文档修改 + 1 个未跟踪补丁记录。本单证据绑定 Git 对象 `bded1728`，不依赖工作树清洁；该写入与本次 CI 差量无文件重叠，但后续推送/落地需串行。

## 1. 对象绑定

| 项 | 值 |
|---|---|
| 提交 | `bded172836790da6bcf6c929d9e59435e38fdeb7` |
| tree | `ddfe4249b797de70f4113f9f96cdaf4418b7be2f` |
| 父 | `c843874110979abb19045482d6699488522dab45` |
| 分支 | `task/M5-T11`（无 upstream） |
| 工作树 | 开始干净；结束有运维已授权的批量文档 WIP，审查始终绑定 `bded1728` |
| 差量 | 12 文件 **+27,246/−71** |
| 产品面 | `src tests deploy prisma package.json pnpm-lock.yaml tsconfig.json` 相对 `c8438741` **零差量** |

CI 文件 blob：`99a79d05686009c8b2cac76e74bc7fa0df8315b7`（从 Git 对象提取后 `git hash-object` 复核一致）。

其余 11 个文件均为契约/派生/补丁记录：`task-contracts.json`、`task-reviews.json`、`M5-T11.evidence-template.json`、`build-manifest.json`、`build-state.json`、`review.json`、`dispatch.json`、`docs-data.js`、`patches/m5t11-ci-support-path.{json,md,evidence.json}`。

## 2. 结论：**限定 PASS，无阻断**

### 2.1 范围登记

- `task-contracts.json` 85 个任务块逐字段深比较：**仅 `M5-T11.supportPaths` 2→3**（新增 `.github/workflows/ci.yml`），其余 84 个任务定义完全不变。
- `effectivePaths` **9→10**，10 项与派单列出的完全一致（5 output + 3 support + 2 container 注册点，jobs 注册点与 outputPaths 同文件去重）：
  1. `.github/workflows/ci.yml`（新增，support）
  2. `deploy/cron.nbshiyan`（output）
  3. `src/auth.ts`（container 注册点）
  4. `src/lib/server/analytics/aggregate.ts`（support）
  5. `src/lib/server/analytics/retention.ts`（output）
  6. `src/lib/server/composition.ts`（output）
  7. `src/lib/server/db.ts`（container 注册点）
  8. `src/lib/server/jobs/registry.ts`（output）
  9. `tests/analytics-retention.db.test.ts`（output）
  10. `tests/jobs-runtime.http.test.ts`（support）
- 影响 5 项：`M5-T11` + `M7-T3`→`M7-T8`→`M7-T9`→`M7-T10`；四者任务定义未变，只有契约哈希传播（`patch.changes` 的 `affected` 与之一致）。
- `revalidation.json` 仍 `{}`，无已落地任务被标待复验；`review.json` 深比较仅 `sourceVersion` 变，issues 与 `warn=28` 未变。
- 契约哈希 `6a8c38d793c917a451ea54465a64eb0a24b66986211ac42313d0e5e9704b00e2` 在 5 处生成物一致（`task-reviews`、`evidence-template`、`docs-data.handoff.contracts`、`docs-data.handoff.readiness`、`dispatch`）；我未运行生成器重算哈希，只核一致性。
- **范围证据未冒充实现/CI**：`task-reviews.M5-T11` 末条明写「只证明契约范围与 CI 接线静态一致，不代表 PG17 或远端 CI 已执行通过」；补丁记录 `status=verified`、`pr=None`、`verifiedTasks=['M5-T11']`；证据模板 5 项 verdict 仍 `pending`。

### 2.2 CI 接线（唯一改动 step）

base/head 两份 YAML 结构化比对（PyYAML）结果：

- 4 个 job 集合不变（build-and-audit / e2e / posix-storage-security / mail-evidence）；各 job 的非 `steps` 字段无变化；步骤数 21 / 20 / 10 / 6 **均未变**。
- 唯一差异：`e2e` 的 `step[6]`「Analytics, chat, and other PostgreSQL regressions」
  - `env` 仅新增 2 键（无删除、无改写）：
    `M5T11_TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/e2e`、`M5T11_REQUIRE_DATABASE: 'true'`
  - `run` 仅新增 3 行：`wanted` 数组、实跑命令、`files` 数组各加 `tests/analytics-retention.db.test.ts`
- 全文件 `M5T11_TEST_DATABASE_URL`、`M5T11_REQUIRE_DATABASE` 各出现 **1 次**（仅该 step）；专属 URL 只指向 `localhost:5432/e2e`，未回退通用 `DATABASE_URL`。
- `e2e.timeout-minutes=35`、`services.postgres.image=postgres:17`、A3 四段 step、生产构建开关均未变（由「仅 step[6] 变化」直接覆盖）。
- 三清单：**22 / 22 / 22 同序、无重复**，逐项文件全部存在；`analytics-retention.db.test.ts` 三处各 1 次，`jobs-runtime.http.test.ts` 仍在实跑名单。
- 口径核对：本 step 21→22；device step（`step[5]`「Device session protocol and PostgreSQL regressions」）为 3 个文件，与这 22 个**无交集**，合计 25。运维回执的勘误正确。

### 2.3 测试侧契约对齐

`tests/analytics-retention.db.test.ts`：

- `:670` 读 `M5T11_TEST_DATABASE_URL`、`:672` 读 `M5T11_REQUIRE_DATABASE`（与 CI 设置同名）
- `:674` `REQUIRE=true` 且缺 URL 时直接抛错（不允许静默 skip）
- `:676-680` host 只接受 `127.0.0.1` / `localhost` / `::1`（CI 的 `localhost` 通过）
- `:684` 自建随机 `m5t11_<hex>` schema 并追加 `?schema=`；`:690` 只把该 URL 注入本测试的 PrismaClient，不把通用 `DATABASE_URL` 当作该库来源

结论：CI 的正向设置与测试的读取/拒绝语义一致；缺地址或非 loopback 都会红，不会静默绿。

### 2.4 语法与门禁负控（合成输入，非真实 CI/PG 结果）

从 `bded1728` 的 blob 原样提取的脚本：

| 检查 | 命令 | 结果 |
|---|---|---|
| YAML | PyYAML 6.0.3 `safe_load` | 通过，jobs=4 |
| 报告器 | `node --check gate.cjs` | exit 0（1,969 B） |
| 逐文件门禁 | `node --check gate-check.mjs` | exit 0（1,864 B） |
| step 脚本 | `bash -n pg-step.sh` | exit 0（5,540 B） |

19 条合成负控 **19/19 符合预期**（`run-controls.sh`，`SUMMARY pass=19 fail=0`）：

- gate2（逐文件门禁）：合法 22 条 → exit 0；新文件缺失 → exit 1 `GATE MISSING tests/analytics-retention.db.test.ts`；零 pass → exit 1；skip=1 / fail=1 / todo=1 → exit 1；缺计数字段 → exit 1 `GATE … missing count fields: skipped (absent is not 0)`；计数被截断 → exit 1；完全无 summary → exit 1（22 条 GATE MISSING）
- 报告器（gate.cjs）：22 条完整事件 → 22 行 pass=；缺 1 个文件 → 输出 `MISSING`；某文件缺计数键 → 输出 `MISSING_COUNT`
- 组合（报告器输出直接喂 gate2）：合法 → 0；缺失 → 非 0；缺计数 → 非 0
- TAP 汇总 grep：`pass>0 + 四个 0` → 0；`# skipped 1` / `# fail 1` / `# pass 0` / `# todo 1` → 均非 0

说明：TAP 层依赖 runner 默认的 `bash -eo pipefail`（GitHub Actions 的 bash 默认带 `-e`）；我按同等语义复现。首次运行出现假红是我的夹具用了 CRLF，改 LF 后全部符合预期——属夹具问题，不是门禁缺陷。

### 2.5 对运维回执的两处精确化（均非阻断）

1. **`dispatch.json` 不是「仅哈希」**：实测 51/51 行变化、14 个任务提示词被改写。其中 5 个受影响任务只换了提示词内的 `contractHash`（等长替换）；另外 9 个（M1-T1、M2-T6、M3-T21、M3-T22、M3-T23、M3-T24、M5-T5、R3-T09233008、R3-T22883505）在「这些路径也会被以下任务碰到」清单里各插入 `、M5-T11`（净 +7 字符），原因是 M5-T11 新增共享路径 `.github/workflows/ci.yml` 后由生成器传播。**没有任何任务的定义、状态或自身路径清单被改**（`task-contracts.json` 只有 M5-T11 变）。
2. **计数口径已核**：本 step 21→22、device 3、合计 25，回执勘误正确（原派单「24→25」指的是含 device 的合计）。

## 3. 未证与边界（不扩大结论）

- **CI/PG17 未执行**：本单不 push、不触发，静态接线通过不等于运行通过；retention 文件在 `postgres:17` 上从未跑过，PG12 的 41/41 不能替代。
- 未测新增文件在 35 分钟预算内的耗时，也未测 22 文件串行的总时长。
- 未执行 `node --test`（真实 TAP 由 CI 产生）；门禁只用合成输入证明「该拒的拒、该过的过」。
- 契约哈希未由我重算（不运行生成器），只核 5 处生成物一致。
- 不证明远端 PR 检查、不构成推送/合并/落地授权；批量 500/5000 与任务卡回填不在本单范围。

## 4. 判定

- 范围只新增 CI 支持路径、其他任务定义未变、10 项 effectivePaths 正确：**通过**
- 三清单 22/22/22 同序无重复、专属 URL/REQUIRE 仅限该 step 且与测试读取一致：**通过**
- YAML 与嵌入脚本可解析、4 job/35 分钟/PG17/A3 与产品开关未变：**通过**
- 合成负控按预期拒绝/通过：**通过**
- 无阻断项；两条非阻断（回执措辞、TAP 夹具 LF）已在 §2.5 记录

**交回后停写，不推送。**

## 5. 命令与证据

关键命令（完整输出见 `check-log.txt`）：`git rev-parse`/`git diff --stat`/`git diff -- .github/workflows/ci.yml`/`git diff --numstat`；`python check-lists.py`、`check-structure.py`、`check-generated.py`、`check-advisory.py`、`check-docsdata2.py`、`check-device.py`、`check-hash-consistency.py`；`node --check`×2、`bash -n`、PyYAML 解析；`bash run-controls.sh`、`bash show-errors.sh`。

运行环境：git/python 在 Windows 侧（Python 3.13.7、PyYAML 6.0.3）；bash/node/grep 在 WSL Ubuntu（Linux 5.10、node v22.17.0、GNU grep 3.4）。CI 配置为 Node 22（major 一致）。

证据文件（均为本任务 planning 内、可复跑）：
- `check-log.txt`：全部检查输出（含 base/head 结构对比、19 条负控、拒绝报文）
- `ci-blob.yml`（blob `99a79d05…`）、`gate.cjs`、`gate-check.mjs`、`pg-step.sh`（从该 blob 原样提取）
- `lists.txt`、`tap-greps.sh`、`fixtures/`（22 个合成夹具）
- 提取与检查脚本：`extract.py`、`gen-lists.py`、`gen-fixtures.py`、`check-*.py`、`run-controls.sh`、`show-errors.sh`、`run-checks-win.ps1`、`run-checks-bash.sh`
