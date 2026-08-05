# 游客端与共享地图使用说明

## 运行

```powershell
Set-Location -LiteralPath 'D:\spmap\GeoSync\poi'
npm.cmd install
npm.cmd run vendor:sync
npm.cmd start
```

生产入口为 `http://<host>:<port>/tour`。本地无数据库和 iServer 时，可运行：

```powershell
node test/tour/server.js
```

然后打开 `http://127.0.0.1:4177/tour?demo=1`。Mock 演示使用无敏感信息的本地夹具，无需演示账号。Mock 只在显式 `demo=1` 时启用，不会成为生产降级路径；正式环境使用现场微信会话，不在仓库中保存共享账号或真实 openId。

## 契约基线

游客端以冲刺文档 09～14 和当前服务端标准响应包为准。早期 03/04/06 文档中冲突的高德地图、`localStorage` openId、`X-Open-Id` 生产鉴权和 `itinerary:updated` 已被 SuperMap、同源签名会话及 `itinerary:progress` 取代。页面流程与降级原则仍继续适用。

## 身份与配置

- 生产请求使用宿主服务签发的同源用户会话 Cookie/令牌。
- `X-Open-Id` 只在 localhost 且 URL 显式包含 `legacyAuth=1` 时发送。
- 地图从 `/api/geosync/client-config` 读取 `gis.center`、`gis.extent`、`gis.crs` 和 `gis.publicServices.map`。
- 三维入口只在 `features.threeD=true` 且 `gis.publicServices.scene` 存在时启用。
- 三维 scene 必须能解析为无用户名和密码的 HTTP(S) URL；空值或其他协议直接显示不可用。
- 不把 `.env`、真实 openId、位置数据、iServer 账号或 SuperMap 激活文件放入前端目录。

## 页面流程

```text
home -> plan -> preview -> touring -> proposal -> completed
                                 \-> spot/:id
```

刷新时先请求 `/api/itinerary/current`。规划、开始、暂停、继续、跳过、结束和接受提案成功时，使用响应中的完整行程整体替换本地行程。拒绝提案的现有后端响应只有 `{version}`，客户端必须随后请求 `current`，不得把该局部响应写成完整行程。Socket 事件只触发 REST 校准，不直接修改站点、ETA 或 version。

`/api/itinerary/current` 只返回 `draft`、`active` 或 `paused` 行程。结束后客户端只在 `sessionStorage` 保存 terminal 行程 ID；刷新且 `current=null` 时，通过受认证和所有权校验的 `GET /api/itinerary/:id` 读取完整 `completed/abandoned` 服务端事实。新活动行程优先，返回首页会清除该 ID；不在浏览器缓存完整行程 JSON。

## 共享地图

公共入口是 `public/assets/js/map/mapFacade.js` 的 `MapFacade`。运营端只允许调用其公开方法，不直接引用 `geosync-*` source 或 layer ID。

完整接入示例、图层规范、颜色和 API Client 方法见 `MAP_FACADE_HANDOFF.md`。

对外事件：

- `poi:selected`：`{ poiId, feature }`
- `route:compared`：`{ distanceDeltaM, durationDeltaSec, reason }`
- `map:error`：`{ code, message }`

初始化失败同时抛出 `MapFacadeError`，其 `code` 为 `MAP_SDK_LOAD_FAILED`、`MAP_SERVICE_UNAVAILABLE` 或 `MAP_CONFIG_INVALID`。

## 降级表现

| 场景 | 页面表现 |
|---|---|
| SDK/地图服务失败 | 切换列表模式，保留规划、时刻表和操作按钮 |
| Socket 断开 | 显示重连条，REST 操作保持可用 |
| 定位拒绝 | 保留地图手动浏览和纯列表游览 |
| 定位精度超过 100 米 | 显示低精度状态，不自动移动地图中心 |
| 2102 | 停止位置上报并显示离开景区 |
| 2103 | 显示定位精度过差；该样本不计为服务端已接受 |
| 1203 | 关闭过期本地状态并重新拉取 current |
| 1204/1205 | 关闭失效提案并刷新行程 |
| 1206 | 显示“继续已有行程 / 放弃并重新规划”，放弃操作携带当前 version |
| 8201/8202 | 显示路径服务不可用或超时，不生成半成品行程 |
| 8203 | 提示调整起点或联系运营人员 |
| 8204 | 提示无已验证无障碍路线，由用户主动切换模式 |
| 8205 | 阻止继续规划并提示刷新服务配置 |
| 8206 | 不显示错误折线，提示路线几何无效 |

## 验证

```powershell
npm.cmd run vendor:sync
npm.cmd run check:tour-offline
npm.cmd run check:tour-syntax
npm.cmd run test:tour:unit
npm.cmd run test:tour
npm.cmd run check:syntax
npm.cmd test
```

正式截图位于 `docs/screenshots/`。其中视口矩阵在 375×812、390×844、768×1024、1366×768 下分别覆盖首页、规划、预览、地图失败列表模式、Socket 断线、定位拒绝、提案、200% 字体和安全区，共 36 张；另有 7 张主流程截图，共 43 张。

2026-08-05 最终本地验证结果为：游客端 Playwright `59/59`、纯函数 `17/17`、后端测试 `493/493`，游客端语法检查 29 个文件通过，后端语法检查与离线资源扫描通过。Playwright 同时覆盖非 Demo 生产 REST 提案、1206 继续/放弃重规划及两步操作的失败/冲突边界、8201～8206、Socket 重连后的 config/current/heatmap 校准、公共 MapFacade 方法、current 首次失败退避、重连后迟到轮询失效、页面销毁后的迟到响应、200% 根字号和缺失路线指标降级。微信 UA 与触摸测试为 Chromium 仿真，不替代微信、iOS 或 Android 实机验收。正式截图固定浏览器时间并等待地图相机动画完成，连续产图后的 43 张 PNG 内容哈希不变。时限断言只证明本地 Mock 演示链路满足首个可交互地图小于 3 秒、封路通知到提案小于 5 秒、接受提案后完整状态替换小于 2 秒；它不能替代真实 iServer、真实 Socket 和微信 H5 环境的性能验收。逐项证据与未签字项见 `TOUR_ACCEPTANCE_EVIDENCE.md`。

## 当前上游契约差异

完整审计结论见 `LZY_FRONTEND_CONTRACT_GAPS.md`。本分支已对明确、低风险的公共契约缺口做了窄范围后端补齐，并保留真实环境与其他提案类型的待联调项。

本分支已为 `barrierReroute` 安全公开权威新旧路线、距离变化和耗时变化，并在缺少地图几何时用 `diff.before/after` 展示文字站点顺序。其他提案类型仍不得根据 `gainMin` 推算时长差、把缺失距离显示为零或伪造路线；`graph:update` 仍不包含路段几何。正式环境若要求所有提案预览或封路高亮，需要 LZY/SXR 继续补充公开、脱敏的 EPSG:4326 数据。

同一实际契约中，位置 `2102/2103` 是 `success:true` 的 soft code，客流 `lowConfidence` 位于 heatmap 顶层，拒绝提案只返回 `{version}`。完成态现通过所有权详情接口恢复，不改变 `/current` 的未完成行程语义；真实 GIS、三维入口和性能结果仍需服务可用后联调确认。
