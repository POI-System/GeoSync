# LZY 与游客端契约差异清单

本文记录 ZZX 游客端对实际后端契约的审计结果、已在当前分支完成的窄范围补齐，以及仍需 LZY/SXR 联调的项目。审计基线为 ZZX 所基于的 LZY 提交 `087d4c9`，并已核对 `origin/LZY@5792852` 的增量。

当前分支没有修改数据库模型或 iServer 请求拼装，但补齐了三个明确公共契约：POI 建议停留字段、封路提案脱敏路线预览，以及受所有权保护的行程详情读取；规划器同时统一使用相同的建议停留回退规则。客户端仍不在本地修改服务端行程结构，也不直接拼接 iServer 网络分析请求。上述后端契约改动在 Git 中独立提交，最终合入前需由 LZY 审核或先进入上游 `main`。

## 已确认契约

| 范围 | 实际后端契约 | 游客端兼容原则 | 需要 LZY/SXR 确认或补充 |
|---|---|---|---|
| 拒绝改道提案 | `POST /api/itinerary/:id/proposal/:proposalId/reject` 成功仅返回 `data: { version }`，不是完整行程。 | 成功后立即 `GET /api/itinerary/current`，用返回的完整行程整体替换 Store；不得把 `{version}` 合并或替换为本地行程。 | 如后续统一写接口，建议 reject 也返回与 accept 相同的完整序列化行程。 |
| 位置上报 | `2102` 和 `2103` 都是 HTTP 200、`success: true` 的 soft code。`2102` 返回 `{accepted:false,outOfFence:true}`；`2103` 返回 `{accepted:false}` 和“定位精度过差”。 | API Client 必须保留成功响应的 `code`。`2102` 停止上报并显示离开景区；`2103` 显示低精度且不把该样本当成已接受。 | 不应把这两个 code 改造成普通成功 `code:0`，除非同时提供等价状态字段并更新契约。 |
| 客流置信度 | `/api/crowd/heatmap` 的 `lowConfidence` 位于快照顶层，单个 item 没有该字段。 | 显示层把快照级置信度作为所有 item 的上下文，显示“参考人流”；不得从 `ci` 或人数自行推断置信度。 | Socket `crowd:update` 目前也不携带 `lowConfidence`；重连或轮询后应以完整 heatmap 快照校准。 |
| 提案详情 | `barrierReroute` 的 REST `pendingProposal` 已安全公开 `beforeRoute/afterRoute/distanceDeltaM/durationDeltaSec`；Socket 仍只作通知，其他提案类型仍只有基础字段和 `diff.before/after`。 | 封路提案直接比较权威路线；所有提案均显示文字站点差异。缺少路线时明确降级，不用 `gainMin` 推算 ETA/时长差，也不伪造几何。 | 其他提案类型若需接受前路线比较，应在创建提案时预计算并保存脱敏 preview route/deltas。 |
| 封路事件 | `graph:update` 只公开 `eventId/edgeId/status/reason/at`，没有路段 GeoJSON；公开端没有封闭路段快照接口。 | 仅更新封路状态和提示。没有几何时不绘制虚假路段，不调用受保护的管理图接口，也不直接请求 iServer 网络分析。 | 如需游客端高亮封路，请由 LZY/SXR 提供公开、脱敏、EPSG:4326 的路段几何或只读快照。 |
| 已完成行程恢复 | `/current` 保持只查询 `draft/active/paused`；新增 `GET /api/itinerary/:id`，按 `_id + openId` 返回本人完整行程，非法、越权或不存在 ID 统一 `404/1204`。 | 浏览器只保存 terminal 行程 ID；`current=null` 时读取详情恢复服务端事实。新活动行程优先，返回首页清除 ID。 | 已在当前分支闭环；仍需真实签名会话环境联调。 |
| POI 建议停留 | `/api/poi/all` 的公共投影现输出顶层 `suggestedStayMin`，优先使用 `visitMeta.suggestedStayMin`，再回退 `dwellMin` 和模型默认 20 分钟。 | POI 弹层直接显示服务端公开值，不读取或泄漏完整 `visitMeta`。 | 已在当前分支闭环。 |
| Socket 加入 | Socket 使用同源签名会话认证。服务端根据认证身份自动加入 `scenic:<id>` 和 `user:<openId>`；`geosync:join` 不读取客户端传入的角色或景区参数。 | 客户端只触发 `geosync:join` 刷新授权，不依赖或伪造 `role/scenicId/openId` 决定房间。Socket 事件只作通知，REST 响应才是行程事实。 | 无需为游客端开放客户端自选房间。 |

## `origin/LZY@759b6a8` 的影响

该提交没有修改 `/api/geosync/client-config`、行程、客流、位置上报、提案或 GeoSync Socket 事件的业务结构。当前分支补齐后的剩余差异以上表为准。与游客端相关的增量是：

- 增加用户会话持久撤销；已撤销会话可收到 `401/9001`，撤销存储不可用时可收到 `503/9001`。
- REST 中与签名会话不一致的 openId 提示会返回 `403/9001`，Socket 也会拒绝该身份不一致；生产游客端不得在 query、body 或 Socket 参数中复制 openId。
- Socket 周期刷新会检查用户会话撤销状态，失效后会离开房间并断开。
- `/api/auth/logout` 改为服务端持久撤销后的全局注销。
- `/api/geosync/health/ready` 的公开响应收缩为 `{state, ready}`；游客端当前不依赖该接口。
- 摄影点公开 GET 契约未变，上传路径只增加鉴权、身份一致性和临时文件清理。

## `origin/LZY@5792852` 的影响

该提交继续收敛上传错误和运行日志，行程路由只把内部异常日志替换为稳定错误码。它没有修改游客端公开响应包、行程序列化、提案字段、Socket payload、客流或位置契约。该提交尚未进入 `main`；当前分支的窄范围契约补齐独立记录在上表。

## 尚待真实环境验收

以下项目不能由本地 Mock 或 Playwright 代替最终签字：

- 真实 manifest、公开二维地图 URL、边界数据和三维 scene URL。
- 真实 iServer 下首图 3 秒、封路到提案 5 秒、接受提案后完整状态更新 2 秒。
- 微信 H5 中的签名会话、Socket Cookie、定位授权和安全区行为。
- 非封路提案的接受前路线预览，以及 `graph:update` 封路几何高亮所缺的公开数据契约。

在上述服务和字段可用前，ZZX 只能完成 Mock、接口兼容和异常降级验证，不应宣称真实 GIS 性能或三维联调已经通过。
