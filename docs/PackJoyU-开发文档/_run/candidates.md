SEARCH_NOTE: 已查看用户点名的[同行首页](https://www.euproprt.com/)，仅核对产品展示与联系入口语境，候选仍全部来自原话。未开展其他外部调研。

CANDIDATE C-01
WHAT: 为在线聊天补齐客服接收、查看和回复访客消息的入口。
HINT: “用户前台，联系我们的在线聊天工具，需要寻找开源项目进行替代，或是我们自己自研开发，”
COST_IF_SKIPPED: 访客能打开聊天并发消息，但无人能接收和答复，联系我们的咨询无法走完。
SIZE: 3 人天
DIMENSION: 角色盲区
TS_CHECK: candidate: needed=unsure(0.55) implied=yes(0.95) dimension=role_blind_spot(low 0.45)

CANDIDATE C-02
WHAT: 客服离线或发送失败时，提供保留联系方式的留言与明确的发送结果、重试路径。
HINT: “用户前台，联系我们的在线聊天工具，需要寻找开源项目进行替代，或是我们自己自研开发，”
COST_IF_SKIPPED: 访客在非工作时间或连接中断时无法完成联系，也不知道消息是否被接收，后续无人能回访。
SIZE: 2 人天
DIMENSION: 失败恢复
TS_CHECK: candidate: needed=unsure(0.39) implied=yes(0.95) dimension=failure_recovery(high 0.99)

CANDIDATE C-03
WHAT: 补齐 2FA 首次绑定、校验后启用及开关切换时保留可用登录方式的配置闭环。
HINT: “管理后台可默认使用  2fa 进行登录，无需填写密码，这个可以在管理后台 个人信息中去设置开关，” TS: 维度判为失败恢复，顾问保留生命周期。
COST_IF_SKIPPED: 管理员首次使用时没有可用的验证器凭据，或切换开关后失去所有登录方式，退出后无法再进入后台。
SIZE: 2 人天
DIMENSION: 生命周期
TS_CHECK: candidate: needed=yes(0.85) implied=yes(0.95) dimension=failure_recovery(medium 0.56)

CANDIDATE C-04
WHAT: 为验证器丢失或更换设备提供独立于日常登录的账号恢复与重新绑定路径。
HINT: “去除管理后台登录时需要的恢复码才能登录的逻辑，管理后台可默认使用  2fa 进行登录，无需填写密码”
COST_IF_SKIPPED: 唯一验证器不可用时管理员永久卡在登录外，既不能管理网站，也无法自行恢复 2FA；去掉日常恢复码并未解决这个异常场景。
SIZE: 2 人天
DIMENSION: 失败恢复
TS_CHECK: candidate: needed=unsure(0.37) implied=yes(0.93) dimension=failure_recovery(high 0.94)

CANDIDATE C-05
WHAT: 建立网站与 3D 产品访问的事件采集、人数去重和按日及产品归因的统计闭环。
HINT: “今日网站访问人数统计、访问 3d 产品统计、等网站运维看版内容” TS: 维度判为闭环缺口，顾问保留数据出入口。
COST_IF_SKIPPED: 看板只有展示容器，没有可靠数据来源；同一人刷新会被重复算作新访客，也无法判断访问的是哪个 3D 产品。
SIZE: 4 人天
DIMENSION: 数据出入口
TS_CHECK: candidate: needed=yes(0.76) implied=yes(0.93) dimension=loop_gap(medium 0.58)

CANDIDATE C-06
WHAT: 为运营数据提供最近更新时间与异常状态，区分真实零访问、尚无数据和查询失败。
HINT: “管理后台数据看版无法查看”；“在管理后台添加运维数据看板” TS: 非必要；维度判为闭环缺口，顾问保留运营维护。
COST_IF_SKIPPED: 看板再次无数值或停止更新时，运营人员无法判断网站确实没人访问，还是采集或查询已中断，无法继续使用这些数据做日常运维。
SIZE: 1 人天
DIMENSION: 运营维护
TS_CHECK: candidate: needed=no(0.35) implied=yes(0.80) dimension=loop_gap(low 0.26)
