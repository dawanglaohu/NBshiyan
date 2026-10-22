import datetime as dt
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
results = json.loads((ROOT / 'results.json').read_text(encoding='utf-8'))
summary = json.loads((ROOT / 'summary.json').read_text(encoding='utf-8'))

mandatory = {
    'E-30': (
        '原句中的“保持原时序、画面稳定或正确品牌覆盖”“通过质量核查”没有逐项可判定标准。模型给 executable=no，p=0.32；这只是需具体化信号，不能用它降低承诺。',
        '沿原 GIF 时间轴逐帧对照发布副本：帧呈现时刻、顺序与循环总时长保持不变；每次旧品牌出现、透视变化、转场及遮挡后再现均由 PackJoyU 完整覆盖，不出现替换新增的错位、漏标或抖动。任一项失败则继续修复该发布副本，将文件标为未完成且不纳入发布成品；原始 JPG/GIF 始终保留用于回退。'
    )
}

clarifications = {
    'E-04': '补充可测分支：关闭并重开浏览器后，未到期且未撤销的真实凭据按既有策略处理；过期或撤销凭据的受保护请求拒绝。测试不得以浏览器关闭即销毁 Cookie 为前提。',
    'E-08': '把四种触发分别测试，并在最终事务复核待绑定记录、有效期和当前凭证版本；错误/过期/重放不提交，两个并发切换最多一个成功，失败后查询仍存在至少一种已验证登录方式。沿09节规则，不另造登录方式。',
    'E-14': '明确 restricted 凭据访问受保护后台必须拒绝；中断或过期不提交待绑定新因素，原有效绑定保持；持有效 restricted cookie 可重入同一 enroll，失效则按10节已定义恢复码/授权路径重启，不能换取完整后台会话。',
    'E-25': '列明在已定义的 PC 1440/1920 和窄屏验收尺寸检查：容器宽高比与素材一致，导航、正文及 PC 3D 控件的可见点击区域不被媒体覆盖，裁切后仍显示原图主体；不得以删除主体或操作区域通过检查。',
    'E-32': '直接请求读取/回复接口分别验未登录、EDITOR、撤权账号、他人访客凭据均无内容且无写入；ADMIN/SALES 仅按当前权限返回；不以隐藏按钮作为权限证据。',
    'E-33': '明确以服务端 seq 排序并展示真实 author；同会话同 clientMessageId 同载荷仅一条消息、一个出箱项和一次未读增加；并发人工回复各自保存，不由后返回响应覆盖先保存回复。',
    'E-34': '补入已定义 seq 游标与已读 MAX 规则：在分页间插入消息，补齐范围内消息 ID 恰一次；已读只推进到用户实际确认的 seq，新到且 seq 更大的消息仍未读。',
    'E-35': '将“真实通知状态”落到已定义 queued/sending/sent/failed 或其现有 DTO 映射，保存消息后的通知失败只改变该通知状态，不改变消息 received 或 inbox 可处理状态；未接通不得显示已发送。',
    'E-39': '镜像10节已定字段：email 可省略；填写时 trim 后≤254、单个合法邮箱、不接收显示名/CRLF；空值按不填处理，非法或过长返回字段错误并保留当前标签页原消息，不升级为已验证身份或投递保证。',
    'E-45': '在访客数的定义/提示处写明“已同意分析的匿名浏览器数”；分别用换设备、清标识、换浏览器验证可能形成新 browserHash，不出现“唯一真人”或跨设备识别宣称。',
    'E-48': '沿09节把保留边界写成 receivedAt+30天及无身份聚合 expiresAt 的13个自然月，并显示查询覆盖范围；清理只在另有明确生产保留授权且显式启用时执行，默认 dry-run/关闭真实清理，无授权请求拒绝实际删除；隔离测试验证过期目标集合、计数、去标识及不重建已过期明细，不扩大备份或已有数据删除权限。',
    'E-60': '直接引用09节既定 now-48h≤occurredAt≤now+5min：超界拒绝，准入的未来事件到其真实时间后才参与聚合；闭区间历史按原始完整覆盖和既定迟到窗口处理，禁止任意客户端时间污染未来日或已关闭区间。',
    'E-61': '列出一轮真实产品动作证据：同意→实际页面/产品访问→实际 GLB start/terminal→真实五分钟作业提交→看板读取真实日/产品聚合，逐项核今日授权浏览器、PV、归因和3D指标。核心来源不得以未接入或固定值交差。',
    'E-62': '明确业务计数读取已成功持久化的 inquiry/conversation/message 稳定业务标识；同标识重试与被拒垃圾不加计数；M6只读来源，结果 DTO 不含 email、body 等个人字段，不要求业务写入等待看板。',
    'E-63': '引用09节既定口径：分母为获同意后真实 model_view_start；同 viewId 最多一个 success/failure 终态，超时记 failure；终态 durationMs 的有效样本算平均耗时并带 samples，无样本为 null，零成功且有样本才为0%，拒绝分析样本不补分母。',
    'E-66': '按09/10节来源矩阵直接测：ADMIN全来源、SALES受既有 scope 的业务聚合、EDITOR公开流量/产品/3D；直接请求系统敏感来源403，混合来源响应在查询前裁剪且不含被隐藏计数。',
    'E-75': '把“D3”指向09/10节已定义受限恢复路径和一次性 permit/restricted cookie；普通无密码登录不改，敏感设置缺当前密码时不得签发普通 ActionGrant，仅凭已登录会话或一枚TOTP的直接请求拒绝并无变更，受限恢复只可新绑定且审计。',
    'E-79': '把“有界页”引用到既定分页上限并验每次请求不越界、seq 连续补齐；轮询只更新已确认收件游标，不推进用户已读位置，不创建客服在线或已读承诺。',
    'E-82': '明示仅重算 dayStart 不早于完整原始覆盖起点的自然日；超范围保留原聚合并返回 partial/unavailable 及原口径/覆盖，不以清理后的残片替换旧完整计数。迟到范围沿09节48h，不扩原始保留期。',
    'E-88': '新增纯授权门禁的可测表述：生产真实清理默认关闭且 dry-run 为默认模式；不存在另行明确的保留策略授权时，启用或请求真实删除必须拒绝且删除计数为0，可返回候选计数/未启用状态。文档、任务派发、模型或代理结论均不能充当授权。只用隔离数据验证，不触碰生产/恢复/备份现有数据。',
    'E-92': '用隔离 SMTP 受控接收后中断 worker，再重启验证可按至少一次重试并复用 stable Message-ID；允许 SMTP 实际重复，但本地状态不标精确一次或客服已读，聊天 received 不变；按09节 unknown-delivery/租约规则呈现真实状态。',
    'E-93': '把有界重试引用到09/10节持久任务/次数上限和退避规则，注入 SMTP不可达/缺配置/暂拒后重启验证从持久出箱恢复；日志和计数只含脱敏错误码及数量，不含主动邮箱/body；不得用 Next after() 的完成代替持久记录。',
    'E-94': '分别验无权限调用拒绝、chat-notifications 使用独立受限适配器且不扩展旧 mail UI；deploy/cron.nbshiyan 确有每分钟注册，重启后实际消费已提交出箱，不能只有手工调用或未来空注册。M4随交付注册，M7仅最终验收。',
    'E-96': '列明每种非法 mode、未由本人开启的totp、普通Credentials带非空recoveryCode都沿同一通用Auth.js失败结果，不签后台会话且响应不区分账号存在；合法password/totp只校验相应方式，并按既定限流/错误协议测试，保留有效用户登录。',
    'E-102': '以单指模型拖动、双指缩放、文字区滑动分别验证：仅模型操作区接管拖动，缩放不能越该产品已定义 min/max，文字/页面滚动可用；测量每个控件点击目标≥44 CSS px，任一手势不触发询盘提交。',
    'E-103': '分别注入GLB下载失败、不支持WebGL、context lost、仅poster/FoldBox，检查对应产品静态回退、重试和询盘；同viewId最多一个终态，poster/程序演示均不发GLB success。真实模型重试若新建尝试按既定viewId规则处理。',
    'E-104': '以产品已有初始相机/缩放边界作基准，任意操控后复位需回到该值；在1440/1920及窄屏检查完整模型可见、名称及关键操作可辨；移除底部重复介绍后规格与询盘入口仍可见可用，不靠删内容消除裁切。'
}
assert set(clarifications) == set(summary['unsure'])

owners = {
    'E-27': '06:9 明定 M1 拥有己方可证公司内容及品牌素材；PDF企业事实核验属于该职责。M6（06:14）只读取统计/运维真实来源，不负责企业宣传事实。模型M6仅0.39低置信；建议主线按源职责复核，台账M1本次不改。',
    'E-29': '06:9 的 M1 制作/保管发布素材与操作来源证据；06:15 的 M7负责跨模块最终验收收口。句中证据让模型偏M7(0.85)，可在任务中区分M1出证与M7终验，不能把素材制作整体移交M7；台账不改。',
    'E-62': '06:14 的 M6读取询盘/聊天真实来源并解释业务趋势；M5(06:13)负责匿名分析账本而非业务内容真值。M4提供已持久化消息事实；M6按权限只读计数，不能引出M4依赖M6。模型偏M5(0.55)，应由主线按来源区分，台账M6不改。',
    'E-86': '06:12及09:62的M4拥有咨询消息/邮箱和最后成功咨询活动，90天聊天保留与cookie期限分开；M5(06:13)的原始/聚合保留指分析账本，不能把所有“保留”都交M5。模型M5(0.76)，台账M4不改。',
    'E-87': '清理与新消息并发的事务重查发生在M4咨询记录，依据06:12、09:62；M5只交付共享固定作业基础（06:78），M4自行追加chat-retention。模型M5(0.98)虽高置信也不取代明确源职责；台账不改。',
    'E-88': '本条约束M4聊天生产清理的授权门禁，06:12/78和09:73/85/87均把chat-retention放M4并要求另行授权。M5分析保留或共享registry不获得聊天数据删除权；M7可核最终证据。模型偏M5(0.70)，台账M4不改。',
    'E-92': '06:12的M4保存真实聊天通知结果，06:78明确M7只验最终链路；SMTP接受后崩溃的outbox重投是M4运行行为，M7应验收而非拥有worker。模型M7(0.85)，台账M4不改。',
    'E-93': '持久通知重试、脱敏及cron恢复属M4咨询通知，依据06:12/78、09:85/86；M7不承接生产通知状态机。模型偏M7(0.61)，台账M4不改。',
    'E-94': 'M4随功能追加chat-notifications及其适配/权限契约，06:78、09:85明确不能等M7；M7负责最终真实接线验收（06:15）。模型M7(0.59)提示验收成分多，不构成转移实现责任；台账M4不改。'
}
assert set(owners) == {x['id'] for x in summary['owner_mismatches']}

def ids(items):
    return '、'.join(items)

lines = [
    '# 104条边界真实校准证据',
    '',
    f'生成时间：{dt.datetime.now(dt.timezone.utc).isoformat()}。本报告只写 planning，不写13节，不改边界台账、产品或主 `_run/judgments.jsonl`。',
    '',
    '## 结论与使用边界',
    '',
    f'104/104次真实调用成功，模型均为 `{summary["models"][0]}`；104个独立日志、104个state哈希均与实际输入匹配，0项skipped/error，0项language_warning。英文state只含edge.scene/trigger/expect与7个简短职责；职责文本总长832字符。并发上限3。',
    '',
    f'可执行性：yes={summary["executable_counts"]["yes"]}、unsure={summary["executable_counts"]["unsure"]}、no={summary["executable_counts"]["no"]}。**进入13前须具体化：{ids(summary["mandatory_rewrite"])}**。另外27条unsure提供具体化建议供主线复核，不伪称已通过，也不把unsure自动改成no。',
    '',
    f'职责分歧9条：{ids([x["id"] for x in summary["owner_mismatches"]])}。校准模型不能代替主线裁决；所有台账归属保持原样，分歧的源职责解释见下表。',
    '',
    f'真实用量：input_tokens={summary["usage"]["input_tokens"]}，output_tokens={summary["usage"]["output_tokens"]}。未读取.env/密钥内容；helper按其既有受支持机制取得凭据，仅保留helper原样输出。',
    '',
    '建议文本尚未再次校准，也未写入13或任何源文档。本报告不是实施完成或阶段过关声明。S3状态由主线处理。',
    '',
    '## 输入与证据格式',
    '',
    '- 源台账快照：`source-edges.md`；逐行中文来源：`source-rows.json`；06职责快照：`source-06.md`。',
    '- 每项`NN.state.json`为实际输入，`NN.response.json`与`NN.stdout.txt`为helper完整原样JSON响应；`NN.jsonl`独立保留template/model/state_sha256/verdicts/usage/label。',
    '- 每项`NN.meta.json`保留真实命令、起止时刻、退出码；`NN.stderr.txt`保留标准错误。NN按01..99、100..104命名。',
    '- `results.json`为只读汇总；`summary.json`为计数；`audit_results.py`逐项验证哈希、标签、模型、结论、用量与英文输入。没有合并主judgments。',
    '- 调用形态：`python <工作树>/_run/typesafe_ask.py --log <planning>/NN.jsonl --label S4-E-NN run edge --state <planning>/NN.state.json`。',
    '- helper哈希口径为排序键/ensure_ascii=False的JSON序列化后SHA256前16位；保留该真实值，不伪造完整64位调用日志。',
    '',
    '## 必须具体化的条目（executable=no）',
    '',
]
for edge_id, (reason, rewrite) in mandatory.items():
    row = next(x for x in results if x['id'] == edge_id)
    lines += [f'### {edge_id}', '', f'中文原期望：{row["expect"]}', '', f'校准解释：{reason}', '', f'最小具体改写建议：{rewrite}', '', f'真实 TS_CHECK：`{row["line"]}`', '']

lines += ['## unsure条目的保承诺具体化建议', '', '这些建议解释既有09/10条款和原承诺，不新增产品能力。主线应结合各自完整条款判断是否采用；本次不修改ledger。', '', '| 编号 | p | 中文最小建议 |', '|---|---:|---|']
for row in results:
    if row['id'] in clarifications:
        lines.append(f'| {row["id"]} | {row["verdicts"]["executable"]["p"]:.2f} | {clarifications[row["id"]]} |')

lines += ['', '## 清理授权的可测门禁', '', 'E-48、E-87、E-88及任何生产保留清理测试均不得把规格、代理或模型结论当作既有数据删除授权。只实现并在隔离数据验证候选选择/并发复核；真实清理开关默认关闭，未获另行明确保留策略授权时保持dry-run并拒绝实际删除，返回未启用及候选/实际计数。备份、恢复数据与原始JPG/GIF不得因本报告新增删除权限。E-87测试仍须验证消息并发时跳过旧截止；关闭实际清理不能用来免除这项实现承诺。', '', '## 职责分歧：源职责解释', '', '| 编号 | ledger | 模型/置信 | 来源解释及主线复核建议 |', '|---|---|---|---|']
for mismatch in summary['owner_mismatches']:
    lines.append(f'| {mismatch["id"]} | {mismatch["ledger"]} | {mismatch["model"]}/{mismatch["confidence"]:.2f} | {owners[mismatch["id"]]} |')

lines += ['', '## 17节优先测试输入', '', '筛选严格按edge模板：severity选择最高影响档（数据丢失/损坏、钱款错误或越权）且likelihood不是rare。这里的“高影响档”与confidence=high不同；低置信选择仍原样保留并标风险，不把它改写成确定事实。', '', f'共{len(summary["high_priority"])}条：{ids(summary["high_priority"])}。', '', f'其中最高影响选择自身为high置信的{len(summary["high_priority_high_confidence"])}条：{ids(summary["high_priority_high_confidence"])}。', '', '最高风险重点（按源条款归并，不替代53条完整输入）：', '', '- 账号与会话：E-02/03/04/05/08/10/11/14/15、E-68/69/70/71/72/74/75、E-95/96。用真实Auth.js初登/刷新/SSR/退出和撤销/过期/并发校验，不能只验Token解析。', '- 必要聊天与持久化：E-16/17/20/34/37/38/40、E-77/78/79、E-85/86/87/88/89/91/93。优先消息持久化与通知分离、重试去重、分页游标、授权撤销、保留边界及默认关闭的实际清理。', '- 分析与时间账本：E-42/43/44/45/46/48/56/57/58、E-80/81/82/83。验证同意门控、终态关联、DST/午夜、完整快照、lease/代次、时区revision、清理后的历史不伪造重算。', '- 看板真来源：E-61/62/63/64。由真实访问/GLB/消息事实到固定作业再到只读看板，核计数与缺样本、失败、旧值；核心数据不可交未接入。', '- 素材制作证据：E-29入最高影响筛选，但severity/likelihood置信分别须看原line；真实工具操作和文件证据不可用文字声明替代，E-30仍须先具体化。', '', 'rare不等于免测：E-12/13/19/27/32/47/59/60/65/66/73/94因模型likelihood选择rare不在53条里；尤其越权、恢复和注入/回放仍应保留安全负例。模型筛选也不能移除M2的PC/键盘/触屏和GLB真失败验收（E-97..104），它们选择中档影响不等于已验收。', '', '## 104行真实TS_CHECK', '', 'line列逐字复制helper响应；owner列前者是台账，后者是模型，未替换源归属。每行模型均jev-1.13.0；对应完整响应/日志就在本目录。', '', '| 编号 | ledger→model | state_sha256 | 17优先 | 真实line |', '|---|---|---|---|---|']
for row in results:
    lines.append(f'| {row["id"]} | {row["owner"]}→{row["verdicts"]["owner"]["choice"]} | `{row["state_sha256"]}` | {"是" if row["high_priority"] else "—"} | `{row["line"]}` |')

lines += ['', '## 最终完整性核验', '', '- 104个state、104个完整JSON响应、104个单记录独立日志、104个退出码0均已核验。', '- 104个真实state_sha256均与本地实际输入一致；日志与响应model/verdicts/usage逐项一致。', '- 104个state未含中日韩文字；没有language_warning，职责描述共832字符；状态场景、触发、期望按中文源行顺序逐句翻译。', '- 已提供1条no的完整最小改写、27条unsure建议、9项职责分歧源解释、53项17节优先输入。', '- 未写13、未修改ledger/产品/主judgments，未调用真人，未执行任何生产清理。', '']
(ROOT / 'report.md').write_text('\n'.join(lines), encoding='utf-8')
print(json.dumps({'report': str(ROOT / 'report.md'), 'real_line_rows': len(results), 'mandatory_rewrite': summary['mandatory_rewrite'], 'unsure_count': len(clarifications), 'owner_mismatches': len(owners), 'high_priority_count': len(summary['high_priority'])}, ensure_ascii=False))
