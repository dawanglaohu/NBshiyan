# S6 后端文档契约审查

首轮结论：revise。已逐项审查52份当前任务包，48项自身契约通过、4项需定点修订；另记录跨范围M2-T8前置缺口。这里的pass只指文档契约可实施，不代表任何网站功能、CI或产品代码已通过。

## 审查证据

逐任务执行maintain_docs.py status --task，52份当前hash/模板已取得，sourceVersion=85d042c28b91ac1bcc11b51b89285c0177cc894663e22201484a6b110d204272；结构阻断0、stale/runtimeDrift为空。对每份最终dispatch核验本任务输入、产出、验收、有效范围及contractHash；验收分句没有派发丢失。核06/08/09/10及13/17/19，按实际provider/consumer、注册与测试owner、最终事务及primitive集成闭合审查。没有运行TypeSafe、verify、产品测试或提交，没有修改源。

## 阻断项

- B1（M2-T8）：M2-T8人工回复验收缺实际发送UI provider，M4-T6只读，M4-T14未在其闭包。 位置：04-执行/19-模块任务拆分.md:26；04-执行/19-模块任务拆分.md:52；04-执行/19-模块任务拆分.md:60。纠正：M2-T8增加M4-T14依赖及chat-human-roundtrip-ui requires，保留已有访客/模型前置。
- B2（M3-T14,M3-T1）：T14先宣称完整AccountDTO真实GET；设备sid/期限由其下游T1创建，passwordlessEnabled默认字段由T2声明，基础provider存在语义前置反转。 位置：04-执行/19-模块任务拆分.md:40；04-执行/19-模块任务拆分.md:27；04-执行/19-模块任务拆分.md:28；02-设计/10-接口约定.md:22。纠正：T14改HTTP/config/metrics primitive且integrationTask=T1，把真实AccountDTO/响应计数归T1；必要User默认字段与T1 schema增量一并明确，T2消费。
- B3（M6-T6）：M6-T6实际五分钟作业和切时区HTTP验收的闭包缺M5-T4和M5-T8，只有domain/aggregate原语。 位置：04-执行/19-模块任务拆分.md:78；04-执行/19-模块任务拆分.md:65；04-执行/19-模块任务拆分.md:69。纠正：增加M5-T4 analytics-settings-api前置/requires（其闭包包含T8 runtime），使真实作业及配置HTTP可用。
- B4（M5-T8）：浏览器同意/页面到实际cron的新增验收只列tests/jobs-runtime.http.test.ts，没有17节Playwright e2e/测试owner路径。 位置：04-执行/19-模块任务拆分.md:69；03-质量/17-测试策略.md:28。纠正：有效范围补e2e/analytics-job-runtime.spec.ts，复用T7已验同意步骤，仅新增runtime关联断言。
- B5（M4-T5）：chat_start/chatStarts及M4→M5匿名发起是已定契约，但只有ingest收该kind，没有产品入口生产者owner。 位置：02-设计/06-系统架构与模块划分.md:29；02-设计/09-数据模型.md:26；02-设计/09-数据模型.md:68；04-执行/19-模块任务拆分.md:51；04-执行/19-模块任务拆分.md:67。纠正：在已有ChatContainer成功首条收件后明确同意门控chat_start生产与重试去重、消费analytics能力及eventKinds接线；明确种类必需字段，禁止email/body/凭据外传。

## 逐任务结论

| 任务 | 当前hash | 结论 | 阶段/集成owner | 证据摘要 |
|---|---|---|---|---|
| M1-T2 | 143675d7111844a2dcc5c89f12817090f877085b96ecd0eca79ac20d39b79cc9 | pass | primitive → M1-T8 | 共享DTO以06节唯一Zod/index出口及10节字段为源；Boolean/API字段与Auth.js字符串rememberDevice解析分支可区分。只验schema及独立TS消费，M1-T8明确依赖并承担适配集成，未要求本原语先交未实现UI。 |
| M3-T1 | a8cc121dca18aded213d0f325ee7842da45f3efbd23cbadadabbb0005e403da9 | pass | integration | 当前User/disabled/lockedUntil/totpEnabled/sv/sid/期限均在实际guard重读，普通signOut撤sid与Cookie；接口设备摘要由本任务创建，前置T14完整AccountDTO的前置反转另列B2，须先纠正其阶段。 |
| M3-T2 | 7f4677feee83d0f377414518fb47509803a6d25865416a58026cdcc98f330c14 | pass | integration | mode枚举/非空恢复码/未知账号均通用失败；TOTP CAS匹配当前secret/sv/step，首次enroll确认匹配当前tokenhash/expiry/pending，schema范围含User默认false增量，HTTP与DB竞争测试均有owner。 |
| M3-T3 | 35a9391d3feb3e61a31bc283d9ae0148080acef6fa8564d0385f4012176f0b5d | pass | integration | reauth真实handler接当前设备与当前密码/未用TOTP，token仅一次响应/hash入库；目的/设备/目标/版本/5min核销条件在明确事务消费者测试，并由T4/T16/T17/T20等实际变更消费；忘密无密码会话不能签grant。 |
| M3-T4 | 535596fd4ee91dbe8f442477482fb5f07772779077714f2904c9eee2d9acb835 | pass | integration | ADMIN他人target的15min permit与grant消费/审计同事务，旧无body重置请求拒绝；目标原有效因素不被提前覆盖，T19是permit实际消费方，UI T9只一次显示秘密。 |
| M3-T5 | 75911964125c5b91666e711cbba6c7e0294d6eed7fb7de90876dde671cdd6f6e | pass | integration | 有效restricted-cookie的enroll重入同URI/原期限；confirm最终事务重验secret/sv/step，完成后新恢复码只返一次并撤旧设备。SERVER_OWNER预授权hash只在该提交生效，HTTP额外密码字段400，不能升级受限身份为后台。 |
| M3-T6 | 988a9e9cfa516216ee0436241ecb6f598b67866dadbe70acf50317998be7c98e | pass | integration | UI请求沿Auth.js原CSRF/Credentials协议，password与totp各自字段来自M1契约；next.config/safe-callback/auth.ts在scope，异常mode/恢复码通用失败与remembered false有真实接口断言。 |
| M3-T7 | 578b49d1ba723d5a1e100c49652f2c9706235b360963b341cabe3b867e31535c | pass | integration | 后台壳只读当前account，前台真实活动节流调用T15，后台轮询不伪续期，401取消在途清内容；profile-ui旧cap名实际仅外壳别名，个人安全表单明确归T12，不混成已实现个人页。 |
| M3-T8 | e67232aec82fe1aff60a35d366c1f5a5d499f91aa247686a45bd4c7d536f6424 | pass | integration | Devices页面读取T17安全摘要、仅本人游标，撤销先由T12对话框获得target绑定grant再调T17；其他设备/当前设备结果均有明确HTTP状态断言。 |
| M3-T9 | 112f4e0a1717190d69c3d56355bcf17798e0f41d188430fd725167d8d38bb242 | pass | integration | 他人账号行复用T12对话框，T4为permit provider；自己/SALES/EDITOR/旧直接reset拒绝，临时结果区关闭清秘密，不修改既有账号增删角色协议。 |
| M3-T10 | 45b6b7dbd76433482a82f519929a6b7e7876c96d4747e19d1b42dcb83cc799c0 | pass | integration | 真实首次token绑定只用既有enroll/confirm接口，URI/恢复码一次展示与清URL/存储禁写明确；确认码不能同时间步立即再登录，T2提供安全CAS，UI不承担重写认证。 |
| M3-T11 | 8dc5f2ed4aeae6dc524787f6b244179ed54b03b279c55a142b281199d3b33235 | pass | integration | 独立recovery root layout和start/enroll/confirm field/response与10节相合，受限cookie单独请求admin401；超时不重发confirm，页面退出清恢复材料，CLI/Self-rebind均有前置provider。 |
| M3-T12 | f7803f3d7a58a35223f71a06d8af1d1d7d322ddb85d25ba70106fc3539f7d9dc | pass | integration | reauth-dialog输出token仅内存，purpose与目标动作逐字段相配；mode/password/reset均调用已交T16/T20，成功撤销后回login，409恢复旧值，失败无后续敏感写。 |
| M3-T13 | 9bc0f68675255f24aadef6b327d7d5a5ba40af44acf6bd9bb7451d0177642133 | pass | integration | 取消确认不发reauth/logout-all，确认只用LOGOUT_ALL grant；结果未知仅GET核实，两浏览器旧cookie401，普通signOut不被加入现密码验证；依赖T8/T12/T17闭合。 |
| M3-T14 | f9479234d86b058bc1ab5b26dd27823e9256d02b8edc136978e267346a6d3d9d | revise | integration | 存在B2：完整AccountDTO的真实GET provider被安排在设备基础前；此任务应为HTTP/config/counter原语，并把真实account和计数接线验收留给T1。 |
| M3-T15 | 98f5abc3802913fc716571d6a8ecc79e165f699cef8235f4490b2d3f52e87307 | pass | integration | 实际activity的CAS与JWT/Set-Cookie同Response写回，SSR不能写则只读；2h/7d/30d及等号、竞争撤销均有测试owner，读session/account不touch，旧Cookie不能复活。 |
| M3-T16 | dc186ecd4358ee0d6bd71f31e73ddfc603e352f0feb2a4d114e1a816d447b2b7 | pass | integration | LOGIN_MODE/PASSWORD用途不同，grant核销+安全动作+sv撤销+审计为同一最终事务；回查当前User/device，旧currentPassword+totp兼容路径执行同强度，恢复码捷径拒绝。 |
| M3-T17 | 31bfd12a4e7b8e8f7081ba873fa3544f4b07b56ba84acdeda9715b383fd05044 | pass | integration | 列表不暴露sid凭据，DEVICE_REVOKE只核本人目标设备；logout-all User锁下sv/设备/审计原子，授权重放不因最终状态幂等而被允许，API/provider与测试范围齐。 |
| M3-T18 | 0035c3193e660581fac5e81287ac7da92499ad5810a8e45d23de0e86e1fce286 | pass | integration | OS-owner CLI为本地授权入口，TTY、明确target/role/reason、一次permit输出及无密审计有合同；预授权hash不先改原因素，原首次密码脚本guard保留，HTTP无同权限入口。 |
| M3-T19 | 28c71a34b182d370ac5004ab35ac405506631f293c4b90a6cc0ca707b22772b1 | pass | integration | User锁后重读恢复码数组，防不同码并发复活；核销/递增sv/旧会话撤销/10min restricted记录/审计同事务，cookie路径及权限隔离明确，原有效密码/因素在最终确认前保留。 |
| M3-T20 | 6ec94801b651a37101c8c3a32b5ef2acf9f5309a59619501efcb5e04ec2996e6 | pass | integration | TOTP_RESET新鲜grant消费后只给SELF_REAUTH受限cookie；T5提供最终新绑定；旧密码+totp与新grant同强度，无当前密码不能以会话/TOTP替代，HTTP不能任意设新密码。 |
| M4-T1 | cf9dff2aa9d8e20dc613225a0f705ffb1c90feb312a47d7d325ff18fd33a739f | pass | integration | 首会话+首消息+seq+唯一出箱原子提交才received，cookie为身份、client UUID为幂等标识，邮箱纯联系方式非找回身份；写失败无半记录，通知后续消费不倒置收件。 |
| M4-T2 | 88bc77fcdda7d3dfa26421851a505bb8aeefec57088089641ac0893c533d7144 | pass | integration | 访客cookie范围和有界afterSeq读取、read MAX不越lastSeq，GET/read不touch内容90d；过期401不删除期内正文，读位置与收件游标分开。 |
| M4-T3 | 0fc0b5f372503b9ae89bbf0363edb58b5fdfa11f8bf6c78a9efd69d365fffe04 | pass | integration | ADMIN/SALES当前角色每次重验，EDITOR/访客拒绝；inbox快照分页与消息seq分页不同，本人read不改其他运营，通知真实状态与received分离。 |
| M4-T4 | d1d33c0d8443c85524496637d5e6c69ab90a02ae5f6ce9745256544824e42ccc | pass | integration | 固定chat-notifications registry/composition/每分钟cron都在有效范围；消息出箱唯一，SMTP事务外20s，leaseVersion阻旧worker、UNKNOWN至少一次及稳定Message-ID有持久测试；缺SMTP为DISABLED。 |
| M4-T5 | 9fe72ae4786e8ec4b458c337797c60fe61839e7e843a972a10814161dba753dc | revise | integration | 访客composer实际调用既有cookie/会话/追加API，成功前无received，离线/邮箱错误保留内存草稿；另有B5：06/09已定chat_start匿名生产者未在此或其他产品任务落定，ingest接受kind不代替生产。 |
| M4-T6 | c61b28819ace690ce9d0777ec13be865d512482b22acaf08580ca703087d11ff | pass | integration | 该任务仅运营read页面，正文来自T3且轮询来自T9；明确人工发送由T14添加。它自身读UI合同可行，不能被M2-T8误当完整双向回复provider（B1）。 |
| M4-T7 | b7ffdda8752dcbb0e18bd39483d27f9eaf5dcbab81444e59e87b313c831f58fd | pass | integration | daily chat-retention默认只读候选与dry-run、无授权deletedCount0；不把cookie失效作为删除90d内容依据，实际匿名化分支明确归T13。 |
| M4-T8 | 174c6ce87a53ddd6546038216a05719e3298cfed19aff4c572924c1fbf84d919 | pass | integration | 主动联系才签cookie，随机token/hash、不依赖analytics；7d/30d及先判有效再touch有实际HTTP owner，同邮箱不恢复旧身份，轮询不会刷新必要凭据。 |
| M4-T9 | 7a7c4e80754af69a17a0db101d4737d732d625925cdc9f6c1a2aab1bc78caf3d | pass | integration | 实际ChatContainer消费poller与retry，不只导出工具；3s/hidden/30s上限/单在途/seq不退，超时保原key、失权停止，后台权限负例由T11当前guard提供。 |
| M4-T10 | ab7a13e4d603429c0256ebf7d7c20be713b26f7a8edd3753869c705ece80c546 | pass | integration | 实际访客追加事务处理seq/消息/出箱/90d期限，同key重试不重发通知或延长期限；closed/anonymized拒绝，访客身份不能由email或threadId替代。 |
| M4-T11 | 545d217e4a43691b85c2f37a7ea854fbe330ec60e5532cb074ca5751b3937684 | pass | integration | 运营作者来自当前session，双人并发独立seq，close用版本CAS；真实访客HTTP收件→人工HTTP回复→访客GET为非AI闭环，界面发送控件另归T14。 |
| M4-T12 | 75fa620b65c3dd800914cc228c5175234ce374db049f1f455d7c9b2ad562e523 | pass | integration | 旧mail-queue真实POST每分钟调度与GET兼容入口共享租约摘要，原mail gate/Bearer/unknown_delivery及响应字段保留，HTTP超时不以换方法探测或重复发信。 |
| M4-T13 | 292e8a3be53ad08886f71e1a461dfad9ffcdc7a4723013df5201bf43ce9efb76 | pass | integration | 已有daily job接当前授权分支，最终事务重读activity/retainUntil/policyVersion，新消息竞争跳过旧候选；只在隔离授权数据验匿名化，默认生产dry-run与FK Restrict避免凭据到期级联删内容。 |
| M4-T14 | 2e8e86bd33c4130818364afd3d2964359fcc73ee44dfb59f486e5f6d7d412ae0 | pass | integration | 实际双端UI Send reply/Close消费T11，依赖只读T6/同步T9/通知T4，作者/seq/关闭冲突/撤权403均明确；完整human-roundtrip-ui唯一provider。 |
| M4-T15 | 321b2ea91500279ad4d6acbccf31a083716cc1cb2a9ff7f48c7d6bb541cdda92 | pass | integration | 移除Tawk实际接线并保留contact/privacy可见入口、必要聊天与可选分析分开；独立chat开关关闭仍可用旧询盘/邮箱，不把历史容量快照或默认90d当真实资源或删除授权。 |
| M5-T1 | 8aad14a50e1d4aa97c926f6fe6f8291b250847c41db9dae8b93936d13d0da836 | pass | primitive → M5-T8 | 仅JobState租约仓储原语，真实PG并发owner/generation/90s/成功时间单调；无任意脚本能力，T8明确依赖并提供真实注册/调度，不提前要求未交UI。 |
| M5-T2 | de8752b6e2e67a8e725089a4078e6cb65636d199fb2038664bcd6d524f1a54cb | pass | integration | 签名consent cookie首次/有效重复true/重复false语义与10节一致，同源限流及strict Boolean明确；无cookie/伪签名不可准入，客户端停采由T7负责。 |
| M5-T3 | 00c0c477c8a1c3b421ea7fbed95a8a64806a134abc3f29a6c55d439882e83205 | pass | primitive → M5-T8 | RepeatableRead快照/cutoff、整组替换、水位和当前revision提交复核一致，完整原始覆盖外保留旧值/partial而不用残片；是服务/DB原语，T8闭合实际5分钟运行。 |
| M5-T4 | ee57ffaf994c38890f4e4caa312ccd1f93e6eda6c66fa1175e5d86a9d1f3778d | pass | integration | GET/PATCH时区API消费T9 domain与T8 runtime，ADMIN CAS/审计/重算待办、非法IANA和旧version不改变值；只重算完整保留范围，旧about/org不动。 |
| M5-T5 | 65e9e1859a9b1b2f454df45828c91637a6a0aaab8ddbc1bfc7604d80b2fef57f | pass | primitive → M5-T11 | 只读候选/截止计划器不执行删除，不把30d原始覆盖断点后的部分日标可重算；T11明确依赖并承担授权、registry与真实事务，原语无需虚报完整HTTP链。 |
| M5-T6 | 21e006c0ca9c238f065ebb48b97cba9b56aa6e56372b0bc3a426107689c7f587 | pass | integration | strict事件种类/产品/长度/PII与120/300事件额度可逐项判定；eventId+semanticKey重试和terminal互斥对应唯一键；模型生产者明确M2T7，UI同意生产者T7，后端自己不伪造浏览器同意。 |
| M5-T7 | 98bab5e45466def8bbae14fff5a3a3f9d6970fc5785573ff62f23a76cf78a6ce | pass | integration | 实际偏好DOM、有效cookie、events0/acceptedIds、断网队列清0、串行false最后/不补发已明确；隐私7/30/90/30/13数值及IANA来源是配置，数据可查而不输出browserHash原值。 |
| M5-T8 | 9c9b5a4c260a73b2e9e5c0a77ff9b155b836d9c3a5dc97d0ba5e449480b2dd08 | revise | integration | 固定registry/operations/cron/cutoff运行规则与T1/T3一致，实际5分钟重启证据和±48h/+5min受控时钟有明确协议；B4需补浏览器验收的e2e测试有效路径。 |
| M5-T9 | e1c43ee360affefefddd2c3bfa121488e8123d86c974846b5e6c81e2276afce0 | pass | primitive → M5-T4 | 仅版本化IANA/边界/domain primitive，23/25h/午夜及当前ADMIN CAS有独立DB/纯规则测试，HTTP消费方T4显式依赖；命中服务/事件词的H12不等于缺路由。 |
| M5-T10 | efa05b2a43fbb9fcd4c40cf18683148f6548806564b8b7f04d240dec47cbabb6 | pass | integration | 只增加ADMIN设置UI，GET/PATCH均由T4现成provider提供，非法IANA不改原配置，computed/density/GIF验收沿11，不在本卡重新实现domain或聚合。 |
| M5-T11 | e024b4114bd986af701fac168a40bbae9503f029ca8900afc44c3a20e403e340 | pass | integration | 实际daily retention注册消费T5/T8，默认dry-run+授权拒绝、30d/13月集合及覆盖断点可测，清理后聚合不以残片替换原值，不把文档当生产删除授权。 |
| M6-T1 | b3d9fd16b156a5272e4ca4573b6f48a0a0303d3b7017803df59dd2cc768e4c0a | pass | primitive → M6-T6 | 只读StatsSourceDTO/聚合查询primitive，zero/no_data/not_connected及样本null/0%区分，不能累加产品UV冒充全站；T6显式依赖并提供实际stats HTTP。 |
| M6-T2 | bfe0b0cd720c748f9fbe9442313c1b222eee61e9fec154ba3983c513cd5f5ac5 | pass | integration | 由真实Inquiry/Chat HTTP产生业务事实再读稳定ID计数，SALES既有scope和EDITOR拒绝在查询前，业务保存不反调M6；查询适配器在composition范围内。 |
| M6-T3 | 064b46eaa26b3092bfd452a3ffc63fc08001f88819c404a28a3e286f3420d360 | pass | integration | 真实受控ops-report Bearer/白名单/时间CAS，不接任意路径/内容；15min ops-sample registry/composition/cron俱在范围，备份无验证不能显示可恢复，敏感来源角色拒绝。 |
| M6-T5 | 6956f23a4cd243035191ecb16ea8e614d695ab50c475d2c21e9859a7070684e7 | pass | integration | 真实已接线2xx/5xx计数以同范围分母与coverage解释，不宣称全站；通知真实queued/SMTP accepted/failed/unknown不同，源失败保留旧时间而不拖其他来源。 |
| M6-T6 | 5e6a1258a4283022d4249975601059d76d86dc2effbcd43baacdf434d38c0010 | revise | integration | B3：统计HTTP要求已注册五分钟作业与变时区后的完整覆盖，但前置闭包仅到T3/T9原语，缺M5-T4 settings HTTP/T8 runtime；需补实际provider方可执行该集成验收。 |

## H12/H13

机械结果H12=10、H13=0。以下10个H12逐条核过实际产出；均属既有消费/原语/终验，不是遗漏注册。该结论不抵消上面的语义前置/生产者阻断。

- M1-T8：误报：服务一词命中；现有HTTP/error适配直接导出/import，无新路由或DI注册；消费者T14/T1及各客户端已有明确依赖。
- M2-T4：误报：纯model事件规则，primitive→M2-T7，事件生产接线由T7承担，非本卡漏注册。
- M5-T9：误报：IANA/settings domain primitive→M5-T4，既定服务/事件文字不是实际HTTP注册，本卡不交新路由。
- M6-T7：误报：在已有T4 stats页面消费各源状态，不新增路由；前置含T4/T2/T5/T3，现成页面注册不重复。
- M7-T2：误报：真实会话验收只调用已有API，不新增handler/provider。
- M7-T3：误报：统计端到端终验只消费现成事件/页面/作业，不创建页面或注册。
- M7-T4：误报：询盘聊天终验只调用已有API及开关，实际回复provider T14在闭包。
- M7-T5：误报：恢复终验调用既有受限接口/CLI，未新增恢复旁路。
- M7-T6：误报：新鲜授权终验复用已有reauth/动作，不新增服务或路由。
- M7-T9：误报：运行既有分发/备份恢复脚本并比对ops，不新增事件或HTTP provider。

## 非阻断与实际边界

- calibration-s5保留initial/decomposed/final，size仍有more-than-two-days/unsure；已一次实质拆分，按本卡实际实现和前置复用审，不将分数或未实施代码变成文档阻断。
- 78份prompt真实lint中placeholder/asks_user/contradiction无yes、scope_clear无no；仍有72个unsure输出，不宣称所有判断均yes/no确定。
- wiring注册表会把对应整类路径保守加入support有效范围，实际prompt已包含；可能降低并行度，但任务验收与禁止越界条款仍限制业务改动，不是遗漏注册。
- 本项目约定中的primitive阶段说明重复一次，属可定点清理的文案重复，不造成阶段冲突。

详细逐任务scope/task-contract证据和当前完整hash见同目录s6-backend-evidence.json。修订后仅复核变更契约及其影响，保留本轮结论；不因产品尚未实施追加阻断。
