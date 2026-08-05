# 游客端验收证据

验收日期：2026-08-05。工作区：`D:\spmap\GeoSync`，分支：`ZZX`。本地工具链为 Node.js `v24.14.1`、npm `11.11.0`、Git `2.53.0.windows.3`。

## 自动化结果

| 检查 | 结果 | 覆盖重点 |
|---|---|---|
| `npm.cmd run test:tour:unit` | `17/17` | 错误分类、格式化、客流/路线样式、提案时钟、Store version 与提案去重。 |
| `npm.cmd run test:tour` | `59/59` | API/MapFacade/Socket/定位模块、完整游览、生产 REST 提案、并发恢复、终态刷新、页面销毁和视口矩阵。 |
| `npm.cmd test` | `493/493` | 后端全量基线，覆盖本人行程详情、提案公开预览、POI 公共投影、规划停留时间和同实例封路接受闭环。 |
| `npm.cmd run check:tour-syntax` | 29 个文件通过 | 游客端 ES Modules、脚本和测试语法。 |
| `npm.cmd run check:syntax` | 通过 | 后端关键模块与测试语法。 |
| `npm.cmd run check:tour-offline` | 通过 | 无 CDN、无弹窗 API、固定 vendor 版本，并校验边界与 5 个 POI 离线夹具。 |
| `npm.cmd audit --omit=dev --audit-level=high` | `critical 0 / high 5 / moderate 5` | 现有生产依赖基线仍有 10 项告警；本次未升级依赖，上线前需单独修复并回归。 |
| `git diff --check` | 通过 | 无空白错误。 |

## P0 浏览器闭环

Playwright 已验证：规划 4 小时摄影路线、预览、开始、暂停、继续、跳过、封路通知、提案新旧路线与站点差异、接受或拒绝、完整路线/ETA/站点/version 替换、结束和刷新恢复。生产形态测试使用非 Demo `/tour`、真实 `ApiClient` envelope 和公开 `pendingProposal` 字段，验证地图数据源、差值、站点文本及接受请求 version。终态恢复只在 `sessionStorage` 保存行程 ID，再通过受所有权保护的详情接口读取服务端事实。额外覆盖 Socket proposal/current 首次 503 后退避恢复、重连后 config/current/heatmap 三项校准、1203 后 current 首次失败恢复、1206 两种用户选择及携带 version 的放弃重规划、放弃成功但新规划失败后的普通重试、放弃 version 冲突后的权威刷新、延迟 null 竞态、不完整快照、部分轮询失败、重连后迟到轮询失效、页面销毁后迟到请求失效、缺失路线指标不误报零、8201～8206、1204、1205、2102、2103、空客流、定位拒绝、地图 SDK/配置失败列表降级，以及 API 非 JSON/超时/取消/401/403/409/429/5xx。公共 `MapFacade` 还直接验证边界、定位、封路、路段选择、几何缩放、连接状态和精确事件载荷；客流增量事件只更新现有 GeoJSON source。

后端工作流还使用同一个可变行程实例验证 `graph close -> barrierReroute 持久化 -> GET /current 公共投影 -> accept`，确认提案私有 payload 不泄漏，接受后的路线、站点、ETA、时刻表、version 和进度事件保持一致。

本地 Mock 性能断言已通过：首个可交互地图 `<3s`，封路通知到提案 `<5s`，接受提案后完整状态替换 `<2s`。这些结果只证明本地同源 Mock 链路，不等同于真实 iServer 性能签字。

## 视口与截图

四个验收视口为 375×812、390×844、768×1024、1366×768。每个视口自动验证 9 种状态：home、plan、preview、map fallback list、socket disconnected、touring location denied、proposal、proposal 200% font、proposal safe area。

断言包括：无横向溢出、关键区域无不合理碰撞、页面及地图控件触控目标至少 44×44、根字号调到 200% 后实际计算字号同步放大、无 `ResizeObserver` 时标题高度仍能重算、底部操作不被模拟安全区遮挡。另有一条 Chromium 触摸环境与微信 UA 的 `.tap()` 冒烟测试；它只验证 H5 触摸事件路径，不是微信、iOS 或 Android 实机认证。`docs/screenshots/` 保存 36 张矩阵截图和 7 张主流程截图，共 43 张。截图使用固定浏览器时间，并在地图相机动画结束后采集；连续两次完整产图回归均为 `18/18`，第二次前后逐文件哈希比较为 `CHANGED=0`。

## 尚未签字

以下依赖 LZY/SXR 或真实微信环境，当前不能宣称已联调通过：

- 真实 manifest、公开二维地图、边界数据和三维 scene URL。
- 真实 iServer 首图 3 秒、真实封路事件到提案 5 秒、接受后服务端状态更新 2 秒。
- 微信 H5 的签名会话 Cookie、Socket Cookie、定位授权和设备安全区实机行为。
- 非 `barrierReroute` 提案仍缺接受前的权威路线预览与距离/时长差；`graph:update` 仍缺封闭路段几何。

封路提案现已从服务端安全公开权威 `beforeRoute/afterRoute` 与距离、时长差；其他提案类型对缺失字段继续显示明确降级文案，不推算路线、不伪造几何，也不直接请求 iServer 网络分析。详细契约缺口见 `LZY_FRONTEND_CONTRACT_GAPS.md`。
