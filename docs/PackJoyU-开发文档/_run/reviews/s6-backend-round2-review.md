# S6 后端文档契约第二轮复核

结论：pass（仅文档契约）。首轮5个可定位阻断均已修源并进入实际派发包，未发现本次差异引入新的前置反转或有效范围缺口。没有重启全轮审查，也不以估算残余或产品尚未实施追加阻断。

## 当前证据

52项逐个重新运行status --task，全部刷新currentHash，sourceVersion=fca77b4d96bc9bd35e46494b75fa3f052764a5c0921a3a29c3d9f259741136e7；stale/runtimeDrift/显式blockers均为空。最终78份prompt lint无负向确定项，仍有74个unsure输出，不宣称全部模型判断确定。

## 首轮问题闭合

- B1：19:26、52、60及实际M2-T8 prompt/contract：依赖M4-T14且requires chat-human-roundtrip-ui，运营发送界面已在产品咨询闭包。
- B2：19:27、28、40：T14 primitive→T1；T1先建User默认false并提供完整AccountDTO/生产计数，T2只消费；M1-T8已移除服务端错误映射，T14为唯一owner。
- B3：19:65、69、78及M6-T6 prompt：requires M5-T4，实际闭包含M5-T8 runtime，变时区及真实调度均先交付。
- B4：19:69与M5-T8 contract.outputPaths/实际prompt均含e2e/analytics-job-runtime.spec.ts，保留既有HTTP测试并复用T7前置。
- B5：09:186、10:168-170、19:51与M4-T5 prompt：同意且当前导航首次成功新咨询收件才发chat_start；navigationId语义去重，禁业务ID/PII、拒绝/撤回/后补不发，实际chat→event→聚合有明确e2e owner。

## 传播差异

- M1-T8：client primitive→M3-T7，服务端HTTP错误映射移出本卡outputPaths；M3-T7前置含本卡，单一错误owner得到保持。
- M3-T7,M6-T4,M3-T6：实际图无环：现有Auth.js登录可先交T7壳，M6-T4交stats页面后T6再换自定义登录/默认回跳；仅任务/UI验收顺序，不新增M3服务导入M6服务。

H12=10、H13=0，保留首轮逐条解释；提醒没有被当作语义通过证明。primitive与integrationTask及全部provider requires闭包已对当前图复核，无循环。

## 52项当前文档契约

| 任务 | currentHash | 结论 | 阶段/集成owner |
|---|---|---|---|
| M1-T2 | fc0e8a639ad18c806256f0387194266adae031484d110ce8c4c03accb766ace9 | pass | primitive → M3-T1 |
| M3-T1 | 58172161385199fd71b9e67f80035a3678afcdbecb9a26b42b020072a9b285c3 | pass | integration |
| M3-T2 | 8cb0629eba3be9d26cbde369f35d1fba9f7af4c998d2321051d4f691d1f0274b | pass | integration |
| M3-T3 | bc1e46082034566f0d1689b94981e9916230f96defdb9f83d4dbc25dedea9844 | pass | integration |
| M3-T4 | ba6c3828dc1ef882eb769f0e7ca1bb30c164f5c98c1aa17e9c49ea35404ce3ae | pass | integration |
| M3-T5 | a6297fffcb153b5fb6614dde1eefcf7d3bdf726b5aa2523a0a36aaa68961bc98 | pass | integration |
| M3-T6 | 90b66f0b2f034572c4f96713f659e578b5c781b5388f5e770f5779f2b84b8276 | pass | integration |
| M3-T7 | 4711e43e9db9d85032bdbfca6128fa7748f708bea58f720c0b84a11202f0b92e | pass | integration |
| M3-T8 | f0c36bb31241257fa2e0615a8ff93967589be2b8208b6c4647e28fc7641b8b8c | pass | integration |
| M3-T9 | 4ac0bdc861bb494d77df2eb93f31730227808ef5b5a97b58606a37529ec764de | pass | integration |
| M3-T10 | 96a806bd138dababf6a55e0b7e31ef0bbe45bf7fea9768ea9b5174b18a62da4b | pass | integration |
| M3-T11 | b36ebca18517493afbf550999c7d4c8cbd81ea135dc84c89cf728c174f14fc2d | pass | integration |
| M3-T12 | 9e3176e800fa748938d9ecb71f58083f1eaa7553bcdfcd5be4ad7a34828be4cb | pass | integration |
| M3-T13 | 866d83d17947eb820dd6ee8db644bc26d0c406d78a714005c994be5d8464d101 | pass | integration |
| M3-T14 | a194b137db5a31fd477c776c5e58cc333ce21c77668fdecbd911d0dbb079b16c | pass | primitive → M3-T1 |
| M3-T15 | cb4b881a019e03f97c81a9db3cc56311464d24fd795d2871a2a33934cf422f4c | pass | integration |
| M3-T16 | 5ea3c3fbd81f96ebf22fa0a7b7f325ead4445bde7e83550d8ec644936d4ddc69 | pass | integration |
| M3-T17 | 455c5b958ff372262c2f5c569dc4314001121242913f2380e9327a566dd6095a | pass | integration |
| M3-T18 | 9b1d724524eb7b0049b1f571ec18d9e7c0718333ab1b5463a699425242daee17 | pass | integration |
| M3-T19 | d68e50559b822834126ac3f8112c8a72aecbaf622701fb2e8280ec7cf3812a58 | pass | integration |
| M3-T20 | 639a57c5c29adb9a7b6b44c38c624d91bac92534e1da343c24c0e2d737802b2f | pass | integration |
| M4-T1 | d71c4f67a21427013b408670f23e168ca153aecade21e66d359170e3e6ff6d4f | pass | integration |
| M4-T2 | 275e00d25b007acf23e6d322651579f935f42e938a7b97effbc735120ba9147a | pass | integration |
| M4-T3 | c4a6c91eb13cfa6b3e815c8aa2b556eb0d2382a3778d5beb7bdff7ab7bd7f295 | pass | integration |
| M4-T4 | 3c708c3878ac9c05a5d742b67452f946086ad5f79ea955825935be1ee0cd8149 | pass | integration |
| M4-T5 | 7caede542e06a6a27badf4472784ba2a9c4559b76fe579a2b19a59fe7a8b821c | pass | integration |
| M4-T6 | f174b947a7ebaf31b39b50190489108624633b0ea6eb228202c87d45826236cd | pass | integration |
| M4-T7 | 5efc424fe51b85299f6ed22c98967a0b07fb6549292d05169f06d8f98778f655 | pass | integration |
| M4-T8 | 027abd8d86ef8add8df62f776b67fee2c32a45a6f27a8e7c0f348d3c8f10b1e0 | pass | integration |
| M4-T9 | 9b4aa7d3c61d8767f885490eab194feed892c69bd30629640b20fa32aea8da30 | pass | integration |
| M4-T10 | a3fe298864f764ee9ef50075f9cde21a5118a812b7468acf181b70efb43d4fdf | pass | integration |
| M4-T11 | 6f5617541c16a66e8a4ccb3b6f905dc7c641eef10322d84c26120a38acd73f1c | pass | integration |
| M4-T12 | 7d9d6364523cf0eb17fe251732a56cec9e873ba2fad3f588f539a202dcd64d9d | pass | integration |
| M4-T13 | 25ac577f7b76ab2a733dab574db2964acc2e8826cd7669e3ffee5202bc590b49 | pass | integration |
| M4-T14 | fce19303f24d0f84db57bd870448d17c404848aaf9e7369a0af73507ebe4d698 | pass | integration |
| M4-T15 | b0d9079f28150e8f16598d30421516da104a90ca7954a4748baeb7ff7b96bfbd | pass | integration |
| M5-T1 | f3ee876950a291f2266858e82c35b95a1a151e7ed10381661408edc95e22b708 | pass | primitive → M5-T8 |
| M5-T2 | 8a3be33c96f240da2e27f32efd1ec71a1843ef399628202b5267d84ffb4f0fe4 | pass | integration |
| M5-T3 | 2ec1fe3da583c8af86195f2ab955088476af23a0341ab3c4e49f9f9611046fe8 | pass | primitive → M5-T8 |
| M5-T4 | 5252e547ae64e0e783c997fad3c80e67889aeefbc76cc686d935ba346e56b0bd | pass | integration |
| M5-T5 | e6b6af32b371765053e48dfeaac9f635252eb34882ab494ffc9f314783bb5f97 | pass | primitive → M5-T11 |
| M5-T6 | e12c66f91029b692d1aa3e4cf4099ccbe2e2ff5ad89b8d6e162c305e3d3aacbb | pass | integration |
| M5-T7 | 551878db78246f377e86fe56e80ea89585701ba68e881f52ca3784cc9c018962 | pass | integration |
| M5-T8 | 2f4a67541ce90247c115d8b1a4d042b82ec1af1671039aaa7cadfb49e3d3cd81 | pass | integration |
| M5-T9 | 1078be421228f7a53595bfb0f4f518e78bbb6a66338ad571ce5531033ab2ba1b | pass | primitive → M5-T4 |
| M5-T10 | 9dd4dbc8b52426c218e4fedc7e19a28a910f2d351347fb321cdeb613c233f73f | pass | integration |
| M5-T11 | e244b0aebc65a6b92a320cc1298f4b2301ae71165702daba247c265c3fe6def6 | pass | integration |
| M6-T1 | 5558812fdcf0f2b21fcb6d3b1e9d13b82435029c90afd6dca4df43d19e8e7df1 | pass | primitive → M6-T6 |
| M6-T2 | 460e55d0a7766012634b56185c8956e63bbf32345eb52f73ed17b3487fbea55a | pass | integration |
| M6-T3 | b1c5062ce280cc8e45beb40b82ff00df3e7c1e094e45160f6541edcb63aef2b1 | pass | integration |
| M6-T5 | 880d9bdf39931bc1f4c255f8409a4df6a207e0703d67613569297292a6028ff7 | pass | integration |
| M6-T6 | d5a2390e536b6197a9a8175d700d49c42544419753068beb9052c21941842bfc | pass | integration |

所有pass只指当前规格、依赖、接线与完成阶段可实施；不代表网站登录、聊天、统计、CI或发布功能已运行通过。本轮未调用TypeSafe、未verify、未修改源、未提交。首轮报告/负响应保留；第二轮完整scope/task-contract evidence见s6-backend-round2-evidence.json。
