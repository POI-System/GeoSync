# [ZZX] 游客端：完成共享地图与完整游览闭环

## 本次完成

- 新增 `/tour` 静态 H5，完成规划、预览、游览、定位、改道提案、刷新恢复和异常降级。
- 新增可复用 `MapFacade`，统一边界、POI、客流、路线、路线对比、位置和封闭路段图层。
- 本地化 MapLibreGL、SuperMap iClient 和 Socket.io Client，无 CDN 运行依赖。
- 新增摄影机位详情、黄金窗口和受配置控制的三维入口。
- 新增 Playwright 主闭环、模块契约、定位拒绝和四视口测试及正式截图。
- 新增 `MAP_FACADE_HANDOFF.md`，提供给邵建鹏直接接入的公共方法、事件、颜色和 API Client 约定。

## 接口、配置或依赖变化

- 不新增后端 API。
- `poi/package.json` 增加固定版本前端 SDK、Playwright、`vendor:sync`、`check:tour-offline` 和 `test:tour`。
- 上游提案暂缺新路线几何，兼容字段与降级表现见 `docs/tourist-client.md`。

## 验证方式

```text
npm.cmd run vendor:sync
npm.cmd run check:tour-offline
npm.cmd run check:tour-syntax
npm.cmd run test:tour:unit
npm.cmd run test:tour
npm.cmd run check:syntax
npm.cmd test
```

实际结果：

- 游客端 Playwright：`29/29` 通过。
- 游客端纯函数：`17/17` 通过。
- 后端全量测试：`481/481` 通过。
- 游客端语法检查：27 个文件通过；后端 Node 语法检查通过。
- 离线资源扫描：通过，固定版本为 SuperMap iClient `12.1.0-r`、MapLibreGL `5.6.0`、Socket.io Client `4.7.4`。
- 演示环境性能断言：首图 `<3s`、封路通知到提案 `<5s`、接受后完整状态替换 `<2s`。

## 页面截图

- `docs/screenshots/tour-375x812.png`
- `docs/screenshots/tour-390x844.png`
- `docs/screenshots/tour-768x1024.png`
- `docs/screenshots/tour-1366x768.png`
- `docs/screenshots/tour-route-preview.png`
- `docs/screenshots/tour-reroute-proposal.png`
- `docs/screenshots/tour-photo-spot.png`

`docs/screenshots/tour-viewport-*.png` 另包含 4 个视口 × 9 种流程/异常/可访问性状态，共 36 张；仓库内正式 PNG 合计 43 张。

## 已知问题

- 真实 iServer 首图耗时、封路到提案耗时和三维 scene 跳转需在 SXR 服务与正式 manifest 可用后签字。
- 接受前的新旧路线比较依赖 LZY 补充公开提案路线几何；当前不会在前端自行推算。
- 生产 `graph:update` 暂缺封闭路段几何；当前保留状态与提示，收到公开几何后可直接渲染。

## 提交前确认

- [x] 当前分支是 `ZZX`，不是 `main`
- [ ] `LZY` 已先合入 `main`
- [x] 未提交 `.env`、密钥、token、真实 openId 和位置数据
- [x] 未提交 `node_modules`、uploads、日志、测试临时目录和 SuperMap 激活文件
- [x] 已运行游客端与后端测试
- [ ] PR base 是 `main`
