# Home Background

This note documents the fixed 3D-style background on the home page. The main
implementation lives in `web/src/components/Home.tsx`; the rendering CSS lives
in `web/src/index.css` under the `.home-landscape-*` and `.home-grid-box*`
selectors.

## Rendering Stack

The background is decorative and must not affect document flow.

- `.home-landscape` is `position: fixed`, `inset: 0`, `pointer-events: none`.
- `.home-landscape-horizon` and `.home-landscape-floor` are positioned by
  `--horizon-y`.
- `Home.tsx` measures the gap below the hero CTA and sets `--horizon-y` using
  `HORIZON_GAP_PX`.
- `.home-landscape-floor` starts at the horizon and provides the CSS perspective.
- `.home-landscape-plane` is the tilted ground plane.
- `.home-landscape-streamer` holds the repeated grid texture and finite ground
  objects.

Do not move the floor or cube layer into normal page layout. The UI above and
below the background should be ordered by the real page sections only.

The left jump nav uses `.home-jump-nav::before` as a fixed-position
canvas-colored scrim with masked/feathered edges. It is there to keep cube faces
from visually obscuring those buttons while preserving a soft transition back
into the animated background.

## Coordinate System

Current constants:

```ts
const HOME_BACKGROUND_TILE = 64
const HOME_BACKGROUND_HORIZON_GAP_PX = 48
const HOME_BACKGROUND_SCROLL_FACTOR = 0.2
```

The floor grid line thickness is controlled in CSS:

```css
--scene-line-width: 2px;
--floor-grid-line-width: var(--scene-line-width);
```

The floor is intentionally a single sharp grid layer. Do not add full-floor
`drop-shadow()` or `blur()` filters for glow; those are expensive on a fixed,
transformed, full-viewport surface.

Grid object coordinates are expressed in tile units in `GridBoxSpec`.

- `xTiles`: horizontal tile coordinate.
- `yTiles`: ground-depth tile coordinate.
- `widthTiles`: object width on the grid.
- `depthTiles`: object footprint depth on the grid.
- `heightPx`: object height in pixels. A one-tile cube uses `64`.

`GridBox` converts tile coordinates into CSS vars:

```ts
'--box-x': `${xTiles * LANDSCAPE_TILE}px`
'--box-y': `${box.yTiles * LANDSCAPE_TILE}px`
'--box-w': `${widthTiles * LANDSCAPE_TILE}px`
'--box-d': `${depthTiles * LANDSCAPE_TILE}px`
'--box-h': `${heightPx}px`
```

Standalone `halfCylinder` objects use the same `xTiles` anchor as other objects:
`widthTiles` is the full screen-projected diameter of the semicircle, so a
two-tile half cylinder spans exactly two painted grid cells before perspective
is applied.

The X origin is the center of the streamer, written as `--ground-grid-origin-x`.
The painted floor grid uses `--grid-center-x` in CSS. If the visual grid center
changes, keep these origins in sync or cube footprints will no longer line up
with the floor.

## Scroll Direction

This is the crucial part.

At `scrollTop = 0`, the visible world-grid window starts at `Y = 0` at the
horizon and extends toward the viewer.

Scrolling down increases:

```ts
groundOffset = scrollTop * GROUND_SCROLL_FACTOR
```

Finite objects are moved by:

```css
top: calc(var(--box-y) + var(--ground-shift, 0px));
```

That means scrolling down makes negative world Y rows move into the visible
window from the horizon.

Correct placement for objects that should scroll into view:

- Put staged objects at negative `yTiles`.
- Example stream: `-1, -2, -3, ...`
- Do not put scroll-in rows at positive `yTiles`; those rows are already in the
  current visible floor window or closer to the camera at page load.

The repeated grid texture uses `--scroll-shift`, which is modulo one tile so the
texture wraps cleanly. Finite objects use `--ground-shift`, which is continuous
so they do not snap back when the grid texture wraps.

## Visible Floor Frustum

The rendered floor is not a simple world-space rectangle. CSS perspective turns
the ground into a projected frustum on screen.

Current CSS:

```css
.home-landscape-floor {
  perspective: 900px;
  perspective-origin: 50% 0%;
}

.home-landscape-plane {
  transform: rotateX(76deg);
  transform-origin: 50% 0%;
}
```

Approximate projection, with `p = 900`, `theta = 76deg`, screen Y below the
horizon as `sy`, and world-grid Y as `Y`:

```text
Y = sy * p / (p * cos(theta) + sy * sin(theta))
screenX = X * p / (p - Y * sin(theta))
```

The further down the floor gets, the narrower the visible world X range becomes.
Wide lanes can therefore clip off the sides even when their Y position is in
front of the camera. This was the source of the "only a few cubes are visible"
confusion: at 7 tiles out, side clipping can happen after only a few visible
rows on narrower viewports.

If a lane must remain 7 tiles from center and stay visible longer, use one of
these approaches:

- Increase `perspective` to flatten the projection.
- Move the lane closer to center.
- Reduce object width or row spacing.
- Generate rows dynamically from the measured frustum.

## Object Construction

`GridBox` renders the current cheap ground object shapes from `kind`.

For `kind: "cube"` it renders three opaque rectangular faces:

- one top face at `heightPx`;
- one front face facing the camera;
- one side face facing inward toward the screen center.

The CSS translates the box by half its height:

```css
transform: translateZ(calc(var(--box-h) / 2));
```

The floor grid supplies the footprint, so the cube does not render a base
outline. The front face always renders. The side face is chosen from `xTiles`:
left-lane cubes render their right face, and right-lane cubes render their left
face. That shows the face closer to the y-axis without mounting both side faces.

Cube faces use the opaque page background token, `var(--canvas)`. They still
fade at the horizon/bottom by element opacity, but when fully visible their face
backgrounds are not translucent. Do not add per-face shadows or glow filters
unless the performance budget is revisited.

For `kind: "pyramid"` it renders two triangular faces:

- one front triangle facing the camera;
- one inward side triangle facing the y-axis.

For `kind: "tent"` it renders two faces:

- one front triangle facing the camera and pointing directly up;
- one inward rectangular side face facing the y-axis.

Triangle faces are one DOM element each with a clipped `::after` inset that
creates the border and opaque `var(--canvas)` fill. Avoid segmenting the
triangles into many line elements.

For `kind: "halfCylinder"` it renders a fixed-camera impostor:

- one front semicircle cap;
- one back semicircle cap;
- one rectangular shell panel.

The caps span the full footprint width and are proportioned as true
semicircles: cap width is the diameter, cap height is the radius. The visible
cap stroke is a border box widened by `--scene-line-width`, so the left and
right stroke strips sit on the same painted grid lines that bound the footprint.
For this kind, the rendered height is derived from `widthTiles` as
`widthTiles * tileSize / 2` so the base stays locked to the floor grid; avoid
using `heightPx` to stretch the cap. Keep `depthTiles` on whole tile units when
the front and back caps need to land on painted floor lines. The shell panel's
lower long edge anchors to the inner, y-axis-facing edge of the base, while its
upper long edge lands on a configurable point on the semicircle arc.
Edit top-level `halfCylinderShellArcAngleDeg` in
`web/public/data/home-background.json` to move that upper point; scripts can
change this one number. `45` means the outside 45-degree point on the arc. The
React layer converts that angle into the slanted panel width and mirrored
left/right rotations so the upper edge stays on the same arc point while the
lower edge remains on the base's inner edge. This is deliberately not a true
curved mesh. Do not animate that angle on scroll unless there is a specific
reason to spend extra style/compositing work. Standalone half-cylinder shells
are anchored as ground-layer siblings, not as children of the transformed cap
box. Their inner grid edge is positioned directly from tile coordinates:
`xTiles + widthTiles` for left-side objects and `xTiles` for right-side objects.
The rotated plane lives inside that zero-width anchor, so the grid anchor is
established before rotation. The inside border is suppressed so the visible edge
is the grid-aligned plane edge, not a border drawn inside the plane. The
right-side shell gets one `--half-shell-line-width` of width overrun so its
upper edge meets the cap border. The far depth edge is not drawn: the top border
is suppressed because CSS `top` maps to the back edge toward the horizon, while
`bottom` remains the near edge closer to the camera.

Cube objects can also carry an optional `hat` object:

```ts
hat: {
  kind: 'pyramid' | 'tent' | 'halfCylinder',
  heightPx: 48,
}
```

Hats are only rendered on `kind: "cube"` objects. The hat footprint inherits the
cube's `widthTiles` and `depthTiles`, so widening or deepening the cube also
stretches the hat. `hat.heightPx` is independent from the cube's `heightPx`;
the editor's selection popup edits that value without changing the base cube.
For `halfCylinder` hats, the editor renders a real 3D half-cylinder mesh sitting
on top of the cube, while the home page uses the same lightweight CSS impostor
style as standalone half-cylinder objects.

## Current Cube Stream

The current home scene uses two continuous rows:

```ts
const CUBE_LANE_LEFT_X = -7
const CUBE_LANE_RIGHT_X = 6
const CUBE_STREAM_START_Y = -1
const CUBE_STREAM_COUNT = 48
```

Rows are generated by `makeCubeLaneRows()` as negative Y values:

```ts
CUBE_STREAM_START_Y - i
```

This intentionally stages cubes above the horizon so scrolling brings them into
view.

The data can define the full stream, but React should not mount every cube at
once. `Home.tsx` keeps a tile-range render window around the visible floor
region and only renders boxes whose footprints intersect that window. Keep that
virtualization in place when adding longer streams.

## Adding Modular Objects

To place an object anywhere on the grid, add a `GridBoxSpec`:

```ts
{
  id: 'example-block',
  kind: 'cube',
  xTiles: 2,
  yTiles: -6,
  widthTiles: 2,
  depthTiles: 1,
  heightPx: LANDSCAPE_TILE * 1.5,
  hat: {
    kind: 'pyramid',
    heightPx: LANDSCAPE_TILE * 0.75,
  },
  opacity: 1,
}
```

Supported `kind` values are `cube`, `pyramid`, `tent`, and `halfCylinder`. The
old `box` kind is still accepted as a compatibility alias for `cube`. Missing
or invalid values default to `cube`.

Placement rules:

- Use negative `yTiles` for objects that should enter from the horizon while
  scrolling down.
- Use `yTiles >= 0` only for objects that should be visible immediately at page
  load.
- Keep `widthTiles` and `depthTiles` in whole tile units when the footprint must
  align to the painted floor.
- Keep `heightPx` in pixels because CSS 3D height is vertical screen-space depth,
  not a floor tile coordinate.

## Fade Behavior

Every finite ground object has `data-ground-fade-y`. `Home.tsx` updates
`--ground-fade` per object from:

```ts
baseY + groundOffset
```

Objects fade in near the horizon and fade out near the bottom edge. The fade is
per object, not global. Do not replace it with one shared opacity unless the
goal is for every cube to appear and disappear at the same time.

Reduced-motion mode sets `--ground-fade: 1` so objects do not depend on
scroll-driven opacity transitions.

## Maintenance Checklist

When changing the home background:

- Keep the background fixed and pointer-inert.
- Keep grid texture movement modulo-based and object movement continuous.
- Place scroll-in objects at negative Y.
- Preserve `transform-style: preserve-3d` on the floor, plane, streamer, box
  layer, and boxes.
- Keep cube face borders visually matched to the ground lines. The ground uses
  `--floor-grid-line-width`; cube face borders use `--scene-line-width`.
- Keep cube streams virtualized. The scene file may contain many boxes, but the
  DOM should only contain the boxes near the visible floor window.
- Avoid full-floor CSS filters like `drop-shadow()` and `blur()` in the home
  background.
- Check both narrow and wide viewports because side clipping changes with
  viewport width.
- Run `npm run build` after code changes.

Documentation-only changes do not require an app version bump.
