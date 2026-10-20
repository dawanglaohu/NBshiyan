# S6 前端文档契约审查（第2轮，仅差异）

VERDICT: pass。33项均通过本轮契约复核，首轮F01–F06全部关闭；没有新增阻断。未修改源、未登记verify、未执行TypeSafe、未提交。

当前源版本：`fca77b4d96bc9bd35e46494b75fa3f052764a5c0921a3a29c3d9f259741136e7`。33个任务均重新执行status，currentHash与实际dispatch一致；stale/runtimeDrift/结构blockers为空。完整逐卡记录在`s6-frontend-round2-evidence.json`；原首轮报告、证据、status和负项均保留。

## 修正核对

- F01：M2-T8新增M4-T14/chat-human-roundtrip-ui，回复API和可见回复控件都在闭包，产品任务不重做运营UI。
- F02：M5-T10增加ops.ts范围，只新增settings/analytics GET/PATCH；M6-T4追加stats，不覆盖其他方法。07:210与任务产出同口径。
- F03：T6/T7/T15（M4）的完整visual-components依赖明确，所列M3后继闭包全部继承M1-T7；M1-T7的sections已补07/11/12。唯一token/原生包装owner未复制。
- F04：M1-T8改primitive→M3-T7；T7首先交account GET/activity生产调用，M1-T8移出server/http/errors.ts owner。M1-T2及M3-T14均primitive→M3-T1，后者真实GET account完成DTO/最终响应计数；服务端错误映射只剩T14唯一owner。
- F05：T7经既有/api/auth/signin密码+TOTP先交壳，不注册新signIn；T7→M6-T4→T6顺序无环。T6必须实际到已存在/admin/stats并GET stats/显示核心看板，404或只变URL不算成功；密码控件发送Auth.js password字段。06:82、07:210、12:420解释UI交付顺序而不引服务反调。
- F06：M2-T1保留局部大卡/独立动作/不导航承诺，移去E97/E104整条覆盖标签；完整指针在T2、复位在T3，原全局边界没有削弱。

## 新增chat_start差异

09:186和10:170明确由ChatContainer当前导航首次新咨询成功收件且当时已同意后生产；M4-T5实际包用M5队列/navigationId、eventId/occurredAt与导航语义键去重。消息重试和重复回调只计一次，失败/仅开窗/回复/拒绝/撤回/后补同意不补历史。分析不携带email/body/conversationId/messageId/cookie，业务咨询不等待分析成功。

M4-T5已依赖M5-T6/T7，其闭包有M5-T8实际作业和M5-T3聚合；e2e/chat-start-analytics.spec.ts已纳范围，可验证聊天→事件→chatStarts，不新增AI判断层或业务ID分析关联。

## 当前派发包与证据

- 33项requires逐一位于合法前置闭包；stage/integrationTask关系满足实际消费者先后。全部目标UI实际prompt仍有唯一minimalist-flat、07/11/12、真实GIF/computed style、1920×1080/1440×900/390×844和后台D1–D6/overflow。
- 最新prompt-calibration-final/results.json共有78项，promptHash逐一等于当前implementation的SHA256前16位；status均ok，scope_clear无no，placeholder/asks_user/contradiction无yes。本审查只读取这些已有真实结果，没有执行新TypeSafe调用。
- 首轮其他19项局部语义未被重开；共享章节和前置变动传播到33个hash，均刷新到本轮evidence。pass只用于任务文档契约，不是产品、媒体制作、部署或CI验收。

| 任务 | 本轮 | current contractHash |
|---|---|---|
| M1-T1 | pass | `eef4a0e7b72cc65b7248a21191020c7297b0dc2a63bd92844cacf196120f1fcc` |
| M1-T2 | pass | `fc0e8a639ad18c806256f0387194266adae031484d110ce8c4c03accb766ace9` |
| M1-T3 | pass | `bac30c30cd2c4881643f2701a3c54767c027a9cd1b95416fb2898a3c37756887` |
| M1-T4 | pass | `01a6cb233aa7a24d6519aa3c7b3077748fb0a48894734f302a7a01feb66e0aa2` |
| M1-T5 | pass | `b3032cca257fb1f925a335c4556666c31683f647544718e0cfa8b1afbc1cc1d0` |
| M1-T6 | pass | `bca304092b8b633e65f7153084ca46a0395ba660760fcfdc09e68f410239bedf` |
| M1-T7 | pass | `8dfccbe83d5c5fc9b55e8042eb0d36ac68b76e3fc3be606a02b6318f4cee5675` |
| M1-T8 | pass | `c318a5d33e757f934eb1c08cb5f8a6177f32a251aba087dd9d31da0f7775b797` |
| M2-T1 | pass | `cb59e2e7f25a82f61de9edde490f60697be51fbf2f2e7718e6d1d83a3b58c58d` |
| M2-T2 | pass | `2e115fd41d162ff2bdc580db5d8209ac2171b41b0608e0343f2623fc0adf110f` |
| M2-T3 | pass | `63cad123504a4aa12e38a8e9ce269a40bf7c36dceecdbaadbc264363d817aec5` |
| M2-T4 | pass | `31cefa667944267afd16e80718daaf1f29960bce132a0da5d5ac4ed85009176f` |
| M2-T5 | pass | `fe8c96c4c47c627454a4db1a6266ca282e5c0e5933b15a9378d8f09122228d80` |
| M2-T6 | pass | `0e56217da209e8654c333a799cd4118b2771c2c84e064b45ad9873371a48bf64` |
| M2-T7 | pass | `4beab52a78e56e1b6ad7c288a79ea0f41909b51bb3af4117ea9a77a7dee81ebe` |
| M2-T8 | pass | `a0de6bfb1a0ec66a29fca3568efa6c33b2a87f4eeeeaa94904ccaa11ea359ebe` |
| M3-T6 | pass | `90b66f0b2f034572c4f96713f659e578b5c781b5388f5e770f5779f2b84b8276` |
| M3-T7 | pass | `4711e43e9db9d85032bdbfca6128fa7748f708bea58f720c0b84a11202f0b92e` |
| M3-T8 | pass | `f0c36bb31241257fa2e0615a8ff93967589be2b8208b6c4647e28fc7641b8b8c` |
| M3-T9 | pass | `4ac0bdc861bb494d77df2eb93f31730227808ef5b5a97b58606a37529ec764de` |
| M3-T10 | pass | `96a806bd138dababf6a55e0b7e31ef0bbe45bf7fea9768ea9b5174b18a62da4b` |
| M3-T11 | pass | `b36ebca18517493afbf550999c7d4c8cbd81ea135dc84c89cf728c174f14fc2d` |
| M3-T12 | pass | `9e3176e800fa748938d9ecb71f58083f1eaa7553bcdfcd5be4ad7a34828be4cb` |
| M3-T13 | pass | `866d83d17947eb820dd6ee8db644bc26d0c406d78a714005c994be5d8464d101` |
| M4-T5 | pass | `7caede542e06a6a27badf4472784ba2a9c4559b76fe579a2b19a59fe7a8b821c` |
| M4-T6 | pass | `f174b947a7ebaf31b39b50190489108624633b0ea6eb228202c87d45826236cd` |
| M4-T9 | pass | `9b4aa7d3c61d8767f885490eab194feed892c69bd30629640b20fa32aea8da30` |
| M4-T14 | pass | `fce19303f24d0f84db57bd870448d17c404848aaf9e7369a0af73507ebe4d698` |
| M4-T15 | pass | `b0d9079f28150e8f16598d30421516da104a90ca7954a4748baeb7ff7b96bfbd` |
| M5-T7 | pass | `551878db78246f377e86fe56e80ea89585701ba68e881f52ca3784cc9c018962` |
| M5-T10 | pass | `9dd4dbc8b52426c218e4fedc7e19a28a910f2d351347fb321cdeb613c233f73f` |
| M6-T4 | pass | `30757cc3316f344f77f5b6c7d81204ba80091b8b3355f8e9a00c04f99f384b36` |
| M6-T7 | pass | `8e985c9e6349a52f5bdb05cfe6e8e4fdc2d55e6489ce18347abdcabd16b11f5d` |
