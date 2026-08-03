# 游客端验收证据

验收日期：2026-08-03。工作区：`D:\spmap\GeoSync`，分支：`ZZX`。本地工具链为 Node.js `v24.14.1`、npm `11.11.0`、Git `2.53.0.windows.3`。

## 自动化结果

| 检查 | 结果 | 覆盖重点 |
|---|---|---|
| `npm.cmd run test:tour:unit` | `17/17` | 错误分类、格式化、客流/路线样式、提案时钟、Store version 与提案去重。 |
| `npm.cmd run test:tour` | `29/29` | API/MapFacade/Socket/定位模块、完整游览、改道、错误码、刷新恢复和视口矩阵。 |
| `npm.cmd test` | `481/481` | 后端全量基线，确认游客端修改没有回归服务端。 |
| `npm.cmd run check:tour-syntax` | 27 个文件通过 | 游客端一方 ES Modules、脚本和测试语法。 |
| `npm.cmd run check:syntax` | 通过 | 后端关键模块与测试语法。 |
| `npm.cmd run check:tour-offline` | 通过 | 无 CDN、无弹窗 API、固定 vendor 版本、无 source map/激活文件。 |
| `git diff --check` | 通过 | 无空白错误。 |

## P0 浏览器闭环

Playwright 已验证：规划 4 小时摄影路线、预览、开始、暂停、继续、跳过、封路通知、提案查看、接受或拒绝、完整路线/ETA/站点/version 替换、结束和刷新恢复。额外覆盖 8204、1203、1204、1205、2102、2103、空客流、Socket 断线重连、定位拒绝、地图 SDK/配置失败列表降级、API 非 JSON/超时/取消/401/403/409/429/5xx。

本地 Mock 性能断言已通过：首个可交互地图 `<3s`，封路通知到提案 `<5s`，接受提案后完整状态替换 `<2s`。这些结果只证明本地同源 Mock 链路，不等同于真实 iServer 性能签字。

## 视口与截图

四个验收视口为 375×812、390×844、768×1024、1366×768。每个视口自动验证 9 种状态：home、plan、preview、map fallback list、socket disconnected、touring location denied、proposal、proposal 200% font、proposal safe area。

断言包括：无横向溢出、关键区域无不合理碰撞、操作触控目标至少 44×44、底部操作不被模拟安全区遮挡。`docs/screenshots/` 保存 36 张矩阵截图和 7 张主流程截图，共 43 张。

## 尚未签字

以下依赖 LZY/SXR 或真实微信环境，当前不能宣称已联调通过：

- 真实 manifest、公开二维地图、边界数据和三维 scene URL。
- 真实 iServer 首图 3 秒、真实封路事件到提案 5 秒、接受后服务端状态更新 2 秒。
- 微信 H5 的签名会话 Cookie、Socket Cookie、定位授权和设备安全区实机行为。
- 上游尚未公开的提案前新路线几何、距离/时长差，以及封闭路段几何。

当前游客端对缺失字段显示明确降级文案，不推算路线、不伪造几何，也不直接请求 iServer 网络分析。详细契约缺口见 `LZY_FRONTEND_CONTRACT_GAPS.md`。
