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

刷新时重新请求 `/api/itinerary/current`。任何写操作均使用响应中的完整行程替换本地行程，Socket 事件只触发 REST 校准。

## 共享地图

公共入口是 `public/assets/js/map/mapFacade.js` 的 `MapFacade`。运营端只允许调用其公开方法，不直接引用 `geosync-*` source 或 layer ID。

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
| 1203 | 关闭过期本地状态并重新拉取 current |
| 1204/1205 | 关闭失效提案并刷新行程 |
| 8204 | 提示无已验证无障碍路线，由用户主动切换模式 |

## 验证

```powershell
npm.cmd run vendor:sync
npm.cmd run check:tour-offline
npm.cmd run test:tour
npm.cmd run check:syntax
npm.cmd test
```

正式截图位于 `docs/screenshots/`，包含 375×812、390×844、768×1024、1366×768、路线预览、改道提案和摄影点详情。

本次验证结果：游客端 Playwright `9/9`、后端测试 `481/481`；语法检查与离线资源扫描通过。演示环境的首个可交互地图小于 3 秒、封路通知到提案小于 5 秒、接受提案后完整状态替换小于 2 秒，均由 Playwright 时限断言覆盖。

## 当前上游契约缺口

截至 LZY 提交 `087d4c9`，公开的 `pendingProposal` 与 `itinerary:proposal` 只包含原因、收益、到期时间和站点 ID 差异，不包含新路线 GeoJSON、距离变化或耗时变化。前端已经兼容 `beforeRoute`、`afterRoute`、`distanceDeltaM` 和 `durationDeltaSec`；上游未提供这些字段时会明确显示“服务端暂未提供新路线几何”，不会在本地推算或伪造路线。

同一提交中的 `graph:update` 只包含 `edgeId`、状态、原因和时间，不包含公开路段几何。游客端会保留封路状态并提示可能改道；收到几何时可直接通过 `setClosedEdges` 渲染。正式环境若要求在提案前绘制封闭路段，需要 LZY/SXR 在公开事件或配置数据中补充 EPSG:4326 几何。
