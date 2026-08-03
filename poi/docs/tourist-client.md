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

然后打开 `http://127.0.0.1:4177/tour?demo=1`。Mock 只在显式 `demo=1` 时启用，不会成为生产降级路径。

## 身份与配置

- 生产请求使用宿主服务签发的同源用户会话 Cookie/令牌。
- `X-Open-Id` 只在 localhost 且 URL 显式包含 `legacyAuth=1` 时发送。
- 地图从 `/api/geosync/client-config` 读取 `gis.center`、`gis.extent`、`gis.crs` 和 `gis.publicServices.map`。
- 三维入口只在 `features.threeD=true` 且 `gis.publicServices.scene` 存在时启用。
- 不把 `.env`、真实 openId、位置数据、iServer 账号或 SuperMap 激活文件放入前端目录。

## 页面流程

```text
home -> plan -> preview -> touring -> proposal -> completed
                                 \-> spot/:id
```

刷新时重新请求 `/api/itinerary/current`。规划、开始、暂停、继续、跳过、结束和接受提案成功时，使用响应中的完整行程整体替换本地行程。拒绝提案的现有后端响应只有 `{version}`，客户端必须随后请求 `current`，不得把该局部响应写成完整行程。Socket 事件只触发 REST 校准，不直接修改站点、ETA 或 version。

`/api/itinerary/current` 当前只返回 `draft`、`active` 或 `paused` 行程。结束操作的响应可在当前会话展示完成路线和时刻表，但刷新后无法通过 `current` 恢复已完成行程；该限制已记录在 `LZY_FRONTEND_CONTRACT_GAPS.md`。

## 共享地图

公共入口是 `public/assets/js/map/mapFacade.js` 的 `MapFacade`。运营端只允许调用其公开方法，不直接引用 `geosync-*` source 或 layer ID。

完整接入示例、图层规范、颜色和 API Client 方法见 `MAP_FACADE_HANDOFF.md`。

对外事件：

- `poi:selected`：`{ poiId, feature }`
- `route:compared`：`{ distanceDeltaM, durationDeltaSec, reason, degraded, beforeSource, afterSource }`
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
| 8204 | 提示无已验证无障碍路线，由用户主动切换模式 |

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

2026-08-03 最终本地验证结果为：游客端 Playwright `29/29`、纯函数 `17/17`、后端测试 `481/481`，前后端语法检查与离线资源扫描通过。Playwright 时限断言只证明本地 Mock 演示链路满足首个可交互地图小于 3 秒、封路通知到提案小于 5 秒、接受提案后完整状态替换小于 2 秒；它不能替代真实 iServer、真实 Socket 和微信 H5 环境的性能验收。逐项证据与未签字项见 `TOUR_ACCEPTANCE_EVIDENCE.md`。

## 当前上游契约差异

完整审计结论见 `LZY_FRONTEND_CONTRACT_GAPS.md`。该清单是给 LZY/SXR 的联调输入，本次没有修改后端。

截至 `origin/LZY@5792852`，公开提案仍不包含新路线 GeoJSON、距离变化或耗时变化，`graph:update` 仍不包含路段几何。游客端在字段缺失时必须显示“服务端暂未提供”，不得根据 `gainMin` 推算时长差、把缺失距离显示为零或伪造路线。正式环境若要求提案前比较路线或绘制封闭路段，需要 LZY/SXR 补充公开、脱敏的 EPSG:4326 数据。

同一实际契约中，位置 `2102/2103` 是 `success:true` 的 soft code，客流 `lowConfidence` 位于 heatmap 顶层，拒绝提案只返回 `{version}`，已完成行程也无法通过 `/current` 刷新恢复。客户端需按差异清单兼容这些结构；真实 GIS、三维入口和性能结果仍需服务可用后联调确认。
