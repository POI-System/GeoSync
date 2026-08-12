# SJP 前端交付与本地联调说明

更新时间：2026-08-12
分支：`SJP`
范围：运营端、展示大屏、游客端真实路网叠加、三端统一入口和本地验收工具

## 1. 本次交付内容

### 1.1 三端统一工作台

本地预览根路径为 `/` 或 `/workspace`，顶部提供三个切换入口：

- 游客端 `/tour?demo=1`：游客行程规划、路线预览、摄影机位和真实路网叠加。
- 运营端 `/ops?gis=1`：真实路网展示、景点管理、道路状态/拥堵/警告编辑。
- 展示大屏 `/screen?gis=1`：实时态势、路网状态和回放视图。

工作台使用同源 iframe 保留各端独立状态，不复制各端业务实现。也可以通过“新窗口打开”单独调试当前端。

### 1.2 真实路网接入

前端通过只读接口 `GET /api/geosync/road-network` 获取标准 GeoJSON `FeatureCollection`。当前本地联调数据来自 SXR 交付的 `WalkEdge@GeoSync`：

- 坐标系：`EPSG:4326`
- 坐标顺序：`[lng, lat]`
- 源要素：1083 条
- 按业务 `edge_id` 合并后：1079 条道路
- 数据版本：`2026.08.08-p1`

共享地图 `MapFacade` 增加了 `setRoadNetwork()`，路网绘制在 POI、规划路线和封闭路段图层下方。游客端、运营端和大屏使用相同的路网坐标基线。

### 1.3 运营功能

- 地图选点创建景点。
- 景点名称、经度、纬度必填；照片和备注选填。
- 道路通行状态、拥堵状态和警告信息可编辑。
- 本地管理修改单独保存，不修改 SXR 原始 GIS 数据。
- MongoDB、后台任务和 GIS 状态分别展示，不把 iServer 首页可访问误报为业务服务可用。

### 1.4 本地资源

MapLibreGL、SuperMap iClient、Socket.io Client 和门户页面依赖均使用仓库内固定版本资源，页面运行不依赖公共 CDN。

## 2. 本地运行

### 2.1 安装 Node 依赖

```powershell
Set-Location .\poi
npm install
```

### 2.2 准备路网快照

SXR 的 UDBX、完整 GIS 工作空间和生成后的快照都不提交 Git。拿到 SXR 交付目录后执行：

```powershell
Set-Location .\poi
python scripts\build-sxr-road-snapshot.py `
  ..\SunXinran_GIS_iServer_20260809\gis-work\workspace\GeoSync.udbx `
  .\.cache\sxr-road-snapshot.json
```

生成器以 SQLite 只读模式读取 `WalkEdge_3`，校验数据集注册、EPSG:4326、行数和几何格式，不写回 UDBX。

在本地 `.env` 中配置（`.env` 不提交）：

```text
SXR_ROAD_SNAPSHOT=./.cache/sxr-road-snapshot.json
SJP_DEMO_PORT=4174
SJP_BACKEND_BASE=http://127.0.0.1:3000
```

`SXR_ISERVER_BASE` 可指向已发布的 iServer。预览服务优先读取 iServer；服务不存在或不可用时才使用经过校验的本地快照，并把来源明确标记为 `local-snapshot`。

### 2.3 启动服务

先启动 MongoDB 和主 Node 后端，再启动本地三端预览：

```powershell
Set-Location .\poi
npm start
```

另开一个 PowerShell：

```powershell
Set-Location .\poi
$env:SJP_DEMO_PORT = '4174'
node scripts\serve-sjp-demo.js
```

浏览器必须使用 HTTP 地址，不能直接双击 HTML：

```text
http://127.0.0.1:4174/
```

`workspace.html` 在 `file://` 方式打开时会自动跳转到上述本地服务地址。

## 3. 验证命令

```powershell
Set-Location .\poi
node --test test\ops-screen\*.test.mjs
node scripts\verify-sjp-management.js
```

本次提交前结果：

- SJP 模块测试：25/25 通过。
- 后端完整测试：496/496 通过。
- 游客端地图：1079 条道路，5 个 Demo 景点。
- 三端工作台：游客端、运营端、展示大屏均可切换。
- 道路编辑和景点管理浏览器验收通过。
- 桌面 1440x1000 与移动端 390x844 无横向溢出。
- 浏览器控制台无错误、无失败资源请求。

## 4. 安全与提交边界

以下内容不会提交：

- `.env`、MongoDB URI、管理员 Token、iServer 用户名或密码。
- `poi/config/supermap-manifest.json` 本机配置。
- `SunXinran_GIS_iServer_20260809/` 原始 GIS 交付目录。
- `.cache/sxr-road-snapshot.json` 生成快照。
- SuperMap 工作空间、UDBX、激活文件、日志、上传文件和测试截图输出。

浏览器代码不保存 iServer 凭据，也不直接调用 Manager 管理接口。

## 5. 当前限制

- 当前验证恢复的是 SXR UDBX 的只读路网快照，不代表本机 iServer 已重新发布 `scenic-map`、`scenic-data` 或 `scenic-network`。
- 游客端 `?demo=1` 的行程和 POI 为 ZZX Demo 数据，路网为 SXR 真实数据；页面明确显示“开发 Mock 模式”。
- 本地管理修改由预览适配层保存，不会回写 SXR UDBX。
- 尚不能宣称 `SUPERMAP_ENABLED=true` 已具备生产切换条件。
- 尚不能宣称 Linux Gateway、真实封路改道和连续三次端到端验收已经完成。
- 正式 HTTPS 部署必须通过 GeoSync Gateway 或受控 HTTPS 反向代理访问 iServer，不能让 HTTPS 页面直接请求公网 HTTP iServer。

## 6. 主要文件

```text
public/workspace.html
public/ops.html
public/screen.html
public/tour.html
public/assets/js/map/mapFacade.js
public/assets/js/map/layers.js
public/assets/js/ops/opsMap.js
public/assets/js/pages/workspace.js
scripts/serve-sjp-demo.js
scripts/sxr-iserver-preview.js
scripts/build-sxr-road-snapshot.py
scripts/sxr-management-store.js
test/ops-screen/
```
