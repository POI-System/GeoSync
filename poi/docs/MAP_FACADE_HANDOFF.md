# 共享地图与 API Client 交接说明

本文面向邵建鹏及其他前端调用方。共享地图的唯一公共入口是 `public/assets/js/map/mapFacade.js`；图层和 source ID 保持模块私有，不提供原始 MapLibre 实例，也不允许业务页面复制图层实现。

## 最小接入

```js
import { ApiClient } from '/assets/js/api/client.js';
import { MapFacade } from '/assets/js/map/mapFacade.js';

const api = new ApiClient();
const config = await api.getClientConfig();
const map = new MapFacade();

await map.init(document.querySelector('#map'), {
    mapUrl: config.gis.publicServices.map,
    center: config.gis.center,
    extent: config.gis.extent,
    zoom: 15,
    minZoom: 13,
    maxZoom: 20,
    crs: config.gis.crs
});

map.setBoundary(boundaryFeatureCollection);
map.setPois(await api.getPois());
map.setCrowd(await api.getHeatmap());
```

生产配置必须来自 `/api/geosync/client-config`，坐标统一为 EPSG:4326 `[lng, lat]`。调用方不得拼接 iServer 网络分析 URL 或传入账号、密码。没有公开边界数据集时，可以把 `config.gis.extent` 转为明确标注的矩形降级边界。

## 公共方法

| 方法 | 输入与行为 |
|---|---|
| `init(container, config)` | 校验容器、地图 URL、中心、范围、缩放和 CRS；重复调用会先销毁旧实例。 |
| `isReady()` | 返回地图是否已经完成初始化。 |
| `setBoundary(featureCollection)` | 更新景区边界 GeoJSON。 |
| `setPois(featureCollectionOrItems)` | 更新 POI；既可传入 GeoJSON FeatureCollection，也可直接传入 `ApiClient.getPois()` 返回的 POI 数组，数组中的 `poiId/id/_id` 会统一为 `properties.poiId`。 |
| `setCrowd(snapshotOrItem)` | 接受完整 `{items, lowConfidence}` 快照或一个 `crowd:update` item。 |
| `setRoute(route, options)` | 绘制 NormalizedRoute；兼容读取集中处理的 `pathGeometry`。 |
| `compareRoutes(beforeRoute, afterRoute)` | 绘制灰色旧路线和主题色新路线，缩放到联合范围并返回差异摘要；仅在新旧两侧都提供有效指标时返回距离或时长差。 |
| `clearRouteComparison()` | 清空比较图层并恢复当前正式路线可见性，不删除正式路线数据。 |
| `setUserLocation(location)` | 更新 `{lng, lat, accuracy}`；无效位置会清空位置图层。 |
| `setClosedEdges(items)` | 更新包含公开 EPSG:4326 几何的封闭路段。缺少几何时不要伪造线段。 |
| `selectEdge(edgeId)` | 高亮一个已存在的封闭路段。 |
| `fitToGeometry(geometry, options)` | 缩放到 GeoJSON 几何范围。 |
| `setConnectionState(state)` | 把连接状态写入地图容器的 `data-connection-state`。 |
| `destroy()` | 清理地图事件、ResizeObserver、初始化定时器和地图实例；页面卸载必须调用。 |

除 `init`、`isReady` 和 `destroy` 外，方法在地图未初始化时会抛出 `MAP_NOT_INITIALIZED`，不会静默忽略调用顺序错误。

## 对外事件

```js
map.addEventListener('poi:selected', ({ detail }) => {
    const { poiId, feature } = detail;
});

map.addEventListener('route:compared', ({ detail }) => {
    const {
        distanceDeltaM,
        durationDeltaSec,
        reason
    } = detail;
});

map.addEventListener('map:error', ({ detail }) => {
    const { code, message } = detail;
});
```

`distanceDeltaM` 和 `durationDeltaSec` 始终存在。新旧路线任一侧缺少对应指标时值为 `null`，调用方不得把 `null` 当成 `0`。

`init` 的稳定错误分类是 `MAP_SDK_LOAD_FAILED`、`MAP_SERVICE_UNAVAILABLE`、`MAP_CONFIG_INVALID`。运行中还可能发出 `MAP_SOURCE_UNAVAILABLE` 或 `MAP_GEOMETRY_INVALID`；调用方应进入列表或非地图降级状态，不能阻断业务操作。

## 数据与视觉规范

POI 的地图内部格式是 GeoJSON Point FeatureCollection，唯一键为 `properties.poiId`。调用方可以直接把 `ApiClient.getPois()` 的数组结果传给 `setPois`，无需复制游客端的数据转换代码。类别图标由本地样式生成，关闭或受限状态由属性控制；点击只派发事件，不在地图层请求详情。

客流固定颜色与文字如下：

| 等级 | 颜色 | 文案 |
|---|---|---|
| low | `#34c759` | 舒适 |
| medium | `#ffb020` | 较忙 |
| high | `#ff453a` | 拥挤 |
| unknown | `#8e8e93` | 准备中 |

`lowConfidence=true` 时必须显示“参考人流”，不得展示为精确人数。

路线模式颜色为 normal `#087f73`、accessible `#2774ae`、shade `#167c45`；旧路线 `#707a80`、封闭路段 `#b42318`。`gis.source=iserver` 使用实线，`cache` 显示“缓存结果”，`local-fallback` 使用虚线并显示“离线路线”。accessible 路线只有显式 `verifiedAccessible=true` 且来源可信时才能显示为已验证无障碍路线。

标准路线结构：

```js
{
    geometry: { type: 'LineString', coordinates: [[114.35, 30.54], [114.36, 30.545]] },
    distanceM: 842,
    durationSec: 662,
    verifiedAccessible: true,
    gis: { source: 'iserver', mode: 'accessible', degraded: false }
}
```

## 公共 API Client

`ApiClient` 统一处理同源凭证、标准响应包、JSON 异常、超时、取消、401/403/409/429/5xx 和业务 code。生产环境只使用同源签名会话；仅 localhost 且调用方明确设置 `allowLegacyOpenId` 时才发送 `X-Open-Id`。

可用方法包括：

- `getClientConfig()`、`getPois()`、`getCurrentItinerary()`、`getItinerary(id)`、`getHeatmap()`
- `getPhotoSpots()`、`getGoldenWindow()`、`getArData()`
- `planItinerary()`、`startItinerary()`、`pauseItinerary()`、`resumeItinerary()`
- `skipStop()`、`endItinerary()`、`abandonItinerary()`、`acceptProposal()`、`rejectProposal()`
- `reportPosition()`、`cancel(key)`、`cancelAll()`、`destroy()`

所有行程写方法都携带服务端 version。返回完整行程后，调用方必须整体替换 Store；不得在前端修改站点、ETA 或 version。Socket 只触发 REST 校准。`rejectProposal()` 已在 Client 内兼容后端仅返回 `{version}` 的现状，会再读取 `/current`。

## 生命周期示例

```js
const dispose = () => {
    api.destroy();
    map.destroy();
};

window.addEventListener('pagehide', dispose, { once: true });
```

游客端完整用法可参考 `public/assets/js/pages/tour.js`；接口差异和真实环境待办见 `LZY_FRONTEND_CONTRACT_GAPS.md`。
