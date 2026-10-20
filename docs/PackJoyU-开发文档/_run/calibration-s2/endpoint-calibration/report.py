import collections
import hashlib
import json
from pathlib import Path

ROOT = Path('D:/xiangmu/NBshiyan-docs-s2-s6')
OUT = Path('D:/xiangmu/.codex-plans/NBshiyan-docs-s2-s6/endpoint-calibration')
manifest = json.loads((OUT / 'manifest.json').read_text(encoding='utf-8'))
results = json.loads((OUT / 'results.json').read_text(encoding='utf-8'))
assert len(results) == 37 and len(manifest['endpoints']) == 37
assert all(item['status'] == 'ok' and not item['language_warning'] for item in results)
assert all(item['model'] == 'jev-1.13.0' for item in results)
for item in manifest['endpoints']:
    state = json.loads((OUT / item['state']).read_text(encoding='utf-8'))
    record = json.loads((OUT / item['log']).read_text(encoding='utf-8').strip())
    state_hash = hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()[:16]
    assert record['state_sha256'] == state_hash
    assert record['model'] == 'jev-1.13.0' and record['template'] == 'endpoint'

non_idempotent = [r['index'] for r in results if r['verdicts']['mutating']['verdict'] == 'yes' and r['verdicts']['idempotent']['verdict'] == 'no']
assert non_idempotent == [7, 9, 10, 15, 16, 17, 18, 29, 34, 35, 36]

checks = {
7: ('部分覆盖', '10:83 的“恢复permit签发”及 10:72 一次性响应失败不盲重试覆盖语义；缺精确路径及该旧接口已变为签发permit的逐行条目。超时不可重发同grant，也不可重新造第二份。'),
9: ('缺失，需返修', '10:82–86 未列 activity；09:41 仅约定真实活动节流、CAS和Set-Cookie。空对象重放会使用新的服务器时间推进lastActivityAt，并非普通幂等写。应明确超时/429/503是否停止自动重试、何时允许下一次真实活动调用及先读哪个状态。'),
10: ('已覆盖语义，缺逐行清单', '10:83 明列 reauth，禁止自动重试，超时先读状态且已消费不能造第二份；10:72 单次秘密失败不盲重试。应写明最终实际路由及未获得grant时只能按当前状态重新做新鲜验证，不能重放已用TOTP。'),
15: ('已覆盖语义，缺逐行清单', '10:83 明列恢复permit签发；10:72 说明一次性秘密失败不盲重试；09:18/47 约束15min一次性、目标绑定与不能自授权。需明确该路径与别名路径各自同一规则。'),
16: ('已覆盖语义，缺逐行清单', '10:83 明列 recovery/start，禁止自动重试，响应丢失须新恢复凭据/授权且不回传旧秘密；09:44–45 要求当前凭据同事务最多核销一次。'),
17: ('泛称有歧义，需具体化', '10:83 的 enroll/confirm 可指初次绑定或受限恢复，未逐路由区分；09:19/46 对restricted/pendingSecret有状态机，但没有单列本路由超时后如何恢复。应明确不可自动重新生成pendingSecret，以及读取/重入规则。'),
18: ('泛称有歧义，需具体化', '10:83 的 enroll/confirm 与10:72的一次性响应规则基本覆盖；09:46最终核销、恢复码只返一次且回普通登录。应具体列恢复confirm路径和响应丢失时恢复码不重返、不能生成第二次成功。'),
29: ('缺失，需返修', '10:82–86 未列consent。09:67 约定同意生成随机ID、撤回清cookie、重新同意生成新ID，未定相同true请求重放是否保留原cookie/身份或重新生成。需定幂等分支和客户端重试策略，避免同意重试造成身份重建。'),
34: ('缺失，需返修', '10:85 只有“cron按租约拒绝重叠”；09:84–85作业批次/租约与SMTP有界重试不是HTTP请求幂等。串行重复仍可触发下一批或外部副作用。需说明调用方超时/429/503不自动重发、以JobState核实后等下一计划/显式恢复的规则，或给出其他明确去重方案。'),
35: ('缺失，需返修', '既有GET会消费邮件队列并发信，不能套安全GET可重试；10:82仅称“安全GET”而未明确排除该worker路由。10:85重叠租约不防串行重触发。应明确遗留GET为副作用接口及其调度/超时/重试，与SMTP稳定Message-ID有界重试分层。'),
36: ('缺失，需返修', '10:85及09作业条款只处理worker租约与SMTP投递，未说明HTTP POST触发重试。应与GET别名共用明确策略，保留原stale/sent/failed/deferred/dropped协议。'),
}

lines = [
'# S2 endpoint 真实 TypeSafe 校准报告',
'',
'范围：仅校准正式第10节及 `_run/endpoints-contract.json` 的37个方法记录；未修改规范、契约、产品代码或主 `_run/judgments.jsonl`。',
'',
'结果：37/37 `status=ok`；37次均 `model=jev-1.13.0`；37份英文state均无CJK且无 `language_warning`。每次由工作树既有 `typesafe_ask.py run endpoint` 发真实请求，最多3并发；每行独立 `.jsonl`、`.state.json`、完整 `.stdout.json` 和 `.stderr.txt`。日志state哈希已与对应输入逐一复核。',
'',
'校准用途：模型给第二意见，不直接修改权限或替代架构师决定。未对低置信或不一致结果重问刷绿。`authenticated_self`只代表当前有效后台账号对本人安全设置的权限，不能用于聊天业务；带初次绑定/独立恢复凭据但无后台角色的调用者始终为`anonymous`，其凭据限制完整写入state。',
'',
'## 阻断与需返修',
'',
'1. 权限分歧已经交回架构方确认：第27行 `POST /api/admin/chat/conversations/[id]/read`（10快照表第40行）。模型选 `authenticated_self`（confidence 0.42，probability 0.49；SALES probability 0.47），与原文 ADMIN/SALES 不同。即使 `declared_ok=yes(0.78)` 也不能据此降权为所有本人后台账号；own cursor 只限制写入对象，并不取消共享聊天的角色范围。主会话依既定D7/C01及09的共享聊天范围确认保留ADMIN/SALES；authenticated_self包含EDITOR，不能调用。保留原日志与低置信分歧，不反复重跑刷绿；此项按原范围明确执行后不构成文档权限返修。',
'2. 幂等与重试小节不足：11条 mutating=yes+idempotent=no 逐行对照如下。activity、consent、operations、mail-queue GET/POST 尚无明确HTTP重试策略；recovery/enroll、recovery/confirm仅被泛称 enroll/confirm，需明列路径和响应丢失规则。',
'3. 正式10:83称“每行都在非幂等写清单”，但该快照不存在对应清单；需补真实逐行清单或删除不实引用并写足路由规则。不能把POST、GET、租约或数据库CAS一概当作可自动重试。',
'',
'没有 `declared_ok=no`。第5/10/35行 `declared_ok=unsure` 是保留疑点，详见后文；不能写成全绿。',
'',
'## 37行真实结果',
'',
'表中 `line` 为helper原样输出；日志名均相对此报告目录。模型每行单列，未用历史marker替代。',
'',
'| 行 | 方法与路径 | 第10节源行 | 真实model | 原样line | 证据 |',
'|---|---|---:|---|---|---|',
]
for item, result in zip(manifest['endpoints'], results):
    number = f'{item["index"]:02d}'
    lines.append(f'| {number} | `{item["method"]} {item["path"]}` | {item["source_table_line"]} | `{result["model"]}` | `{result["line"]}` | [{number}.state.json]({number}.state.json) / [{number}.jsonl]({number}.jsonl) / [{number}.stdout.json]({number}.stdout.json) |')

lines += ['', '## 非幂等11行对照', '', '本表只列真实校准同时返回 `mutating=yes` 与 `idempotent=no` 的11行；其他未定/语义上的一次性写仍在后文保留。', '', '| 行 | 方法与路径 | 当前第10节处理情况 | 核对与返修要求 |', '|---|---|---|---|']
for index in non_idempotent:
    item = manifest['endpoints'][index - 1]
    status, detail = checks[index]
    lines.append(f'| {index:02d} | `{item["method"]} {item["path"]}` | {status} | {detail} |')

lines += [
'',
'## 其他疑点与语义说明',
'',
'- 第01/02行是Auth.js兼容族，GET可匿名读CSRF/session，POST登录/退出有不同副作用。state保留同源、CSRF、POST登录、GET session、redirect、cookie、CredentialsSignin，不伪称统一JSON；因此族级 `mutating/idempotent=unsure` 不应被改写成自定义REST保证。',
'- 第03/04/16/17/18行均正确选择anonymous，并不表示无需凭据。初始绑定必须email/password/当前一次性token，独立恢复必须有效恢复码/permit或专属restricted cookie与新TOTP，不能建立或升级ADMIN/SALES/EDITOR session。当前state与原文无“把恢复cookie当普通后台session”的歧义。',
'- 第05行改密 `declared_ok=unsure(0.62)`，但 permission=authenticated_self(high 0.99)。源文已要求本人、同源、当前密码+新TOTP、最终事务grant消费和全会话撤销；不是模型报告明确权限矛盾。仍需后端核实旧兼容路径与新grant路径确实同一最终验证，不据本校准替实现背书。',
'- 第10行reauth `declared_ok=unsure(0.59)`。基本self路径可用authenticated_self；RECOVERY_AUTHORIZE的target必须他人且当前角色ADMIN，DEVICE_REVOKE只可本人设备；这些purpose分支已在state完整保留，不能把最低入口角色当作每个purpose通行证。正式权限表的“target规则由purpose决定”需与09:17/43/47一起执行。',
'- 第19行chat/session返回idempotent=yes(0.75)，但09:61明确仅已有有效cookie时幂等；无cookie重试可产生空session并TTL清理。保留该模型过度概括，不承诺端到端无cookie幂等；10:82“新会话携UUID”的措辞还应明确是conversation创建，不能暗示cookie bootstrap从客户端UUID恢复授权。',
'- 第27行own cursor 与聊天权限的关系是实质分歧，已明确交回并收到架构确认，见上。英文role_definitions原本就说明authenticated_self覆盖所有后台角色且不含SALES-only业务授权，无需改state；未静默解释掉或追问模型刷绿。',
'- 第30行Analytics idempotent=unsure(0.64)，源10:82和09:69已双唯一+payload hash，原样重试不重计；不因模型unsure取消真实约束。应继续区分raw event去重和按日重新聚合。',
'- 第33行选EDITOR是最小可调用角色，只适用于公开流量/产品/3D请求；SALES inquiry按既有scope，ADMIN系统来源。state包含完整来源/字段/服务端查询前过滤/403/隐藏字段省略，不把least role误写成所有来源EDITOR可见。',
'- 第35行legacy mail-queue GET `declared_ok=unsure(0.59)`，但cron高置信且源明确是worker触发。保留GET旧协议是兼容决策；必须显式声明副作用和重试限制，不把该遗留兼容接口算“安全GET”。',
'- 第37行ops-report idempotent=yes(0.65)仅在同一报告重放覆盖同一测量状态的理解下成立；源09:29只定义快照字段，未明确旧measuredAt乱序拒绝条件。建议后端确认不会以旧报告倒退最近成功时间；这不是本轮判定的明确权限阻断。',
'',
'## 英文state与来源完整性',
'',
'已忠实翻译每行 method/path/input/output/permissions；补充09相关英文上下文只用于还原实际鉴权、事务、凭据限制、来源范围及副作用，没有新增权限。模型输入不包含配置、数据库、真实账号、私密资料或密钥。未安装库。',
'',
'roles固定为`anonymous、visitor_session、authenticated_self、EDITOR、SALES、ADMIN、cron`，各有英文定义；helper另附`public`。没有把账号ID当权限标签。',
'',
'| 输入源 | 校准快照SHA256 | 校准后当前文件SHA256 | 一致 |',
'|---|---|---|---|',
]
live_changes = []
for relative, expected in manifest['source_sha256'].items():
    path = ROOT / 'docs/PackJoyU-开发文档' / relative
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f'| `{relative}` | `{expected}` | `{actual}` | {"是" if expected == actual else "否"} |')
    if expected != actual:
        live_changes.append(relative)
lines += ['', '源码快照保存在本目录 `source-*`；表内源行均指校准时快照。共享文档在并行架构工作中可能继续变化，后续修改须重新核对受影响英文state。', '', '校准结束时主会话只澄清Auth.js两行的LoginMode=password/totp和rememberDevice表单字符串严格映射；已对比快照与当前diff，返回/权限/副作用未改变。因此本37次结果仍明确标为针对原快照；字段解释变化不需要重跑37次。主会话后续新增重试逐行清单后，由主会话再按上方11行对照人工核对。', '', '幂等判断关注业务状态和预期动作；普通访问日志或独立统计记录的差异不能单独证明业务非幂等。上表activity关注真实会话期限变化，consent关注匿名身份/cookie变更，作业关注实际下一批工作或SMTP外部副作用。安全敏感一次性授权的自动重试限制独立保留。', '', '## 可合并证据', '', '主会话可按01..37顺序合并本目录37份 `.jsonl`；不要合并 `.stdout.json` 冒充主日志。每份日志恰好一条，model/哈希/label/usage俱全；`results.json`可机器读取全部结论，`manifest.json`保留方法顺序及源表行。', '']
(OUT / 'report.md').write_text('\n'.join(lines), encoding='utf-8')
print(json.dumps({'report': str(OUT / 'report.md'), 'real_calls': len(results), 'non_idempotent_rows': non_idempotent, 'declared_no_rows': [r['index'] for r in results if r['verdicts']['declared_ok']['verdict'] == 'no'], 'declared_unsure_rows': [r['index'] for r in results if r['verdicts']['declared_ok']['verdict'] == 'unsure'], 'source_changes_since_snapshot': live_changes}, ensure_ascii=False))
