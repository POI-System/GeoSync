# Local font policy

The tourist H5 uses device-local Chinese UI fonts (`Microsoft YaHei`, `PingFang SC`,
and `system-ui`) and never requests a remote web font. The vendored SuperMap icon
font is copied by `npm run vendor:sync` for downstream shared-map controls.
