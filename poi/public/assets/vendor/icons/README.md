# Tourist map icons

POI category markers are generated locally by `MapFacade` from the color and glyph
contract in `assets/js/map/styles.js`. They do not load remote images or fonts.

The glyphs use the device's installed Chinese system font stack. No web font is
downloaded at runtime. Add reviewed bitmap assets to this directory only when the
team freezes a replacement icon set; do not add SuperMap activation or license
files here.
