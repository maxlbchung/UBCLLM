import { useEffect, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import type {
  HomeBackgroundBox,
  HomeBackgroundObjectKind,
  HomeBackgroundScene,
} from '../lib/homeBackground'

type HomeThreeBackgroundProps = {
  horizonY: number
  scene: HomeBackgroundScene
  scrollerRef: RefObject<HTMLDivElement | null>
}

type FadeBounds = {
  bottomFadeEnd: number
  bottomFadeStart: number
  horizonFadeEnd: number
  horizonFadeStart: number
}

type FadeUniforms = {
  uBottomFadeEnd: { value: number }
  uBottomFadeStart: { value: number }
  uHorizonFadeEnd: { value: number }
  uHorizonFadeStart: { value: number }
}

type MaterialWithFadeBounds = THREE.ShaderMaterial & {
  uniforms: FadeUniforms & Record<string, THREE.IUniform>
}

type MaterialWithOpacity = THREE.ShaderMaterial & {
  uniforms: FadeUniforms & {
    uColor: { value: THREE.Color }
    uFadeByGroundY: { value: number }
    uLineDepthBias: { value: number }
    uOpaqueFill: { value: number }
    uOpacity: { value: number }
  } & Record<string, THREE.IUniform>
}

type FadeTarget = {
  fillGroup: THREE.Group
  lineGroup: THREE.Group
  materials: MaterialWithOpacity[]
  maxYPx: number
  minYPx: number
}

type SparkLayer = 'grid' | 'object'

type SparkLineSegment = {
  a: Point3
  b: Point3
}

type ShapeGeometry = {
  fill: THREE.BufferGeometry
  lines: THREE.BufferGeometry
  lineSegments: SparkLineSegment[]
}

type SparkNode = {
  edgeIds: number[]
  point: THREE.Vector3
}

type SparkEdge = {
  a: number
  b: number
  layer: SparkLayer
  length: number
}

type SparkGraph = {
  edges: SparkEdge[]
  nodes: SparkNode[]
}

type Spark = {
  age: number
  distance: number
  edgeId: number
  fadeAge: number | null
  fadeDuration: number
  fromNode: number
  maxAge: number
  seed: number
  size: number
  spawnGridShift: number
  spawnGroundOffset: number
  speed: number
  toNode: number
}

type SparkSpawnTarget = {
  distanceFromA: number
  edgeId: number
}

type SparkSystem = {
  alphas: Float32Array
  graph: SparkGraph
  mesh: THREE.Mesh
  material: SparkMaterial
  positions: Float32Array
  sparks: Spark[]
}

type SparkMaterial = THREE.ShaderMaterial & {
  uniforms: ProjectionUniforms & FadeUniforms & {
    uColor: { value: THREE.Color }
    uLineDepthBias: { value: number }
  }
}

type RenderState = {
  camera: THREE.Camera
  dispose: () => void
  fillGroup: THREE.Group
  horizontalGridGroup: THREE.Group
  lineGroup: THREE.Group
  projectionUniforms: ProjectionUniforms
  rebuild: () => void
  renderer: THREE.WebGLRenderer
  render: (dt?: number) => void
  requestRender: () => void
  scene: THREE.Scene
  verticalGridGroup: THREE.Group
}

type ProjectionUniforms = {
  uCosTilt: { value: number }
  uDepthFar: { value: number }
  uDepthNear: { value: number }
  uOrigin: { value: THREE.Vector2 }
  uPerspective: { value: number }
  uSinTilt: { value: number }
  uViewport: { value: THREE.Vector2 }
}

type Point3 = [number, number, number]
type PushVisibleLine = (a: Point3, b: Point3) => void
type RenderableShapeKind = Exclude<HomeBackgroundObjectKind, 'box'>

const CSS_PERSPECTIVE_PX = 900
const GROUND_TILT_DEG = 76
const GROUND_TILT_RAD = (GROUND_TILT_DEG * Math.PI) / 180
const GROUND_TILT_COS = Math.cos(GROUND_TILT_RAD)
const GROUND_TILT_SIN = Math.sin(GROUND_TILT_RAD)
const PLANE_SCALE = 2.6
const HORIZON_FADE_START_TILES = -3
const HORIZON_FADE_END_TILES = 4
const BOTTOM_FADE_END_AFTER_HORIZON_TILES = 5
const BOTTOM_FADE_OUT_DISTANCE_TILES = 3
const HALF_CYLINDER_SEGMENTS = 18
const HALF_CYLINDER_SHELL_MAX_HEIGHT_PX = 248
const HALF_CYLINDER_SHELL_MAX_ARC_ANGLE_DEG = 90
const OUTLINE_DEPTH_BIAS = 0.0001
const SPARK_DEPTH_BIAS = 0
const LINE_HALF_WIDTH_PX = 1
const SPARK_DESKTOP_TARGET = 18
const SPARK_MOBILE_TARGET = 10
const SPARK_FADE_IN_SECONDS = 2
const SPARK_FADE_OUT_SECONDS = 2
const SPARK_VERTEX_COUNT = 6
const SPARK_CAPSULE_HALF_RATIO = 1.35
const SPARK_SPAWN_MIN_X_TILES = -6
const SPARK_SPAWN_MAX_X_TILES = 6

const VERTEX_SHADER = `
uniform vec2 uViewport;
uniform vec2 uOrigin;
uniform float uPerspective;
uniform float uDepthNear;
uniform float uDepthFar;
uniform float uCosTilt;
uniform float uSinTilt;
uniform float uLineDepthBias;
varying float vGroundY;

void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vGroundY = p.y;
  float screenLocalY = p.y * uCosTilt - p.z * uSinTilt;
  float depth = p.y * uSinTilt + p.z * uCosTilt;
  float viewDistance = max(uDepthNear, uPerspective - depth);
  float ndcOriginX = (uOrigin.x / uViewport.x) * 2.0 - 1.0;
  float ndcOriginY = 1.0 - (uOrigin.y / uViewport.y) * 2.0;
  float clipX = ndcOriginX * viewDistance +
    (2.0 * uPerspective * p.x) / uViewport.x;
  float clipY = ndcOriginY * viewDistance -
    (2.0 * uPerspective * screenLocalY) / uViewport.y;
  float depthA = (uDepthFar + uDepthNear) / (uDepthFar - uDepthNear);
  float depthB = (-2.0 * uDepthFar * uDepthNear) /
    (uDepthFar - uDepthNear);
  gl_Position = vec4(
    clipX,
    clipY,
    depthA * viewDistance + depthB - uLineDepthBias * viewDistance,
    viewDistance
  );
}
`

const FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFadeByGroundY;
uniform float uHorizonFadeStart;
uniform float uHorizonFadeEnd;
uniform float uBottomFadeStart;
uniform float uBottomFadeEnd;
uniform float uOpaqueFill;
varying float vGroundY;

void main() {
  float fadeIn = smoothstep(uHorizonFadeStart, uHorizonFadeEnd, vGroundY);
  float fadeOut = 1.0 - smoothstep(uBottomFadeStart, uBottomFadeEnd, vGroundY);
  float groundFade = fadeIn * fadeOut;
  if (uOpaqueFill > 0.5) {
    float fillOpacity = mix(1.0, groundFade, uFadeByGroundY);
    if (fillOpacity <= 0.001) discard;
    gl_FragColor = vec4(uColor, fillOpacity);
    return;
  }
  float opacity = uOpacity * mix(1.0, groundFade, uFadeByGroundY);
  if (opacity <= 0.001) discard;
  gl_FragColor = vec4(uColor, opacity);
}
`

const THICK_LINE_VERTEX_SHADER = `
uniform vec2 uViewport;
uniform vec2 uOrigin;
uniform float uPerspective;
uniform float uDepthNear;
uniform float uDepthFar;
uniform float uCosTilt;
uniform float uSinTilt;
uniform float uLineDepthBias;
uniform float uLineHalfWidthPx;
attribute vec3 aLineStart;
attribute vec3 aLineEnd;
attribute float aLineSide;
varying float vGroundY;

vec4 projectPoint(vec3 p) {
  float screenLocalY = p.y * uCosTilt - p.z * uSinTilt;
  float depth = p.y * uSinTilt + p.z * uCosTilt;
  float viewDistance = max(uDepthNear, uPerspective - depth);
  float ndcOriginX = (uOrigin.x / uViewport.x) * 2.0 - 1.0;
  float ndcOriginY = 1.0 - (uOrigin.y / uViewport.y) * 2.0;
  float clipX = ndcOriginX * viewDistance +
    (2.0 * uPerspective * p.x) / uViewport.x;
  float clipY = ndcOriginY * viewDistance -
    (2.0 * uPerspective * screenLocalY) / uViewport.y;
  float depthA = (uDepthFar + uDepthNear) / (uDepthFar - uDepthNear);
  float depthB = (-2.0 * uDepthFar * uDepthNear) /
    (uDepthFar - uDepthNear);
  return vec4(
    clipX,
    clipY,
    depthA * viewDistance + depthB - uLineDepthBias * viewDistance,
    viewDistance
  );
}

void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 lineStart = (modelMatrix * vec4(aLineStart, 1.0)).xyz;
  vec3 lineEnd = (modelMatrix * vec4(aLineEnd, 1.0)).xyz;
  vec4 clip = projectPoint(p);
  vec4 startClip = projectPoint(lineStart);
  vec4 endClip = projectPoint(lineEnd);
  vec2 startNdc = startClip.xy / startClip.w;
  vec2 endNdc = endClip.xy / endClip.w;
  vec2 startPx = (startNdc * 0.5 + 0.5) * uViewport;
  vec2 endPx = (endNdc * 0.5 + 0.5) * uViewport;
  vec2 linePx = endPx - startPx;
  float lineLength = length(linePx);
  vec2 normalPx = lineLength > 0.001
    ? vec2(-linePx.y, linePx.x) / lineLength
    : vec2(0.0, 1.0);
  vec2 ndcOffset = normalPx * aLineSide * uLineHalfWidthPx * 2.0 / uViewport;
  clip.xy += ndcOffset * clip.w;
  vGroundY = p.y;
  gl_Position = clip;
}
`

const SPARK_VERTEX_SHADER = `
uniform vec2 uViewport;
uniform vec2 uOrigin;
uniform float uPerspective;
uniform float uDepthNear;
uniform float uDepthFar;
uniform float uCosTilt;
uniform float uSinTilt;
uniform float uLineDepthBias;
attribute vec2 aSparkCoord;
attribute float aOpacity;
varying float vGroundY;
varying float vOpacity;
varying vec2 vSparkCoord;

void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vGroundY = p.y;
  float screenLocalY = p.y * uCosTilt - p.z * uSinTilt;
  float depth = p.y * uSinTilt + p.z * uCosTilt;
  float viewDistance = max(uDepthNear, uPerspective - depth);
  float ndcOriginX = (uOrigin.x / uViewport.x) * 2.0 - 1.0;
  float ndcOriginY = 1.0 - (uOrigin.y / uViewport.y) * 2.0;
  float clipX = ndcOriginX * viewDistance +
    (2.0 * uPerspective * p.x) / uViewport.x;
  float clipY = ndcOriginY * viewDistance -
    (2.0 * uPerspective * screenLocalY) / uViewport.y;
  float depthA = (uDepthFar + uDepthNear) / (uDepthFar - uDepthNear);
  float depthB = (-2.0 * uDepthFar * uDepthNear) /
    (uDepthFar - uDepthNear);
  gl_Position = vec4(
    clipX,
    clipY,
    depthA * viewDistance + depthB - uLineDepthBias * viewDistance,
    viewDistance
  );
  vOpacity = aOpacity;
  vSparkCoord = aSparkCoord;
}
`

const SPARK_FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float uHorizonFadeStart;
uniform float uHorizonFadeEnd;
uniform float uBottomFadeStart;
uniform float uBottomFadeEnd;
varying float vGroundY;
varying float vOpacity;
varying vec2 vSparkCoord;

void main() {
  vec2 p = vSparkCoord;
  vec2 capsule = vec2(max(abs(p.x) - 1.0, 0.0), p.y);
  float d = length(capsule);
  float core = 1.0 - smoothstep(0.06, 0.38, d);
  float halo = 1.0 - smoothstep(0.22, 1.0, d);
  float fadeIn = smoothstep(uHorizonFadeStart, uHorizonFadeEnd, vGroundY);
  float fadeOut = 1.0 - smoothstep(uBottomFadeStart, uBottomFadeEnd, vGroundY);
  float groundFade = fadeIn * fadeOut;
  float alpha = vOpacity * groundFade * (core + halo * 0.55);
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`

function readCssColor(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return value || fallback
}

function readBackgroundColor(fallback: string) {
  const value = getComputedStyle(document.body).backgroundColor.trim()
  if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') {
    return value
  }
  return readCssColor('--canvas', fallback)
}

function readCssRgb(value: string): [number, number, number] | null {
  const rgb = value.match(
    /^rgba?\(\s*([\d.]+)\s*,?\s+([\d.]+)\s*,?\s+([\d.]+)/i,
  )
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }

  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!hex) return null
  const raw = hex[1]
  const full = raw.length === 3
    ? raw.split('').map((c) => c + c).join('')
    : raw
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function updateMaterialDisplayColor(material: MaterialWithOpacity, color: string) {
  const rgb = readCssRgb(color)
  if (!rgb) {
    updateMaterialColor(material, color)
    return
  }
  material.uniforms.uColor.value.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
}

function readSceneColors() {
  return {
    accent: readCssColor('--accent', '#2563eb'),
    background: readBackgroundColor('#0b0d12'),
  }
}

function makeProjectionUniforms(): ProjectionUniforms {
  return {
    uCosTilt: { value: GROUND_TILT_COS },
    uDepthFar: { value: CSS_PERSPECTIVE_PX * 2 },
    uDepthNear: { value: 1 },
    uOrigin: { value: new THREE.Vector2(0, 0) },
    uPerspective: { value: CSS_PERSPECTIVE_PX },
    uSinTilt: { value: GROUND_TILT_SIN },
    uViewport: { value: new THREE.Vector2(1, 1) },
  }
}

function makeMaterial(
  projectionUniforms: ProjectionUniforms,
  color: string,
  opacity: number,
  fadeByGroundY = false,
  opaqueFill = false,
  depthTest = false,
  depthWrite = false,
  colorWrite = true,
  lineDepthBias = 0,
) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...projectionUniforms,
      uBottomFadeEnd: { value: 1 },
      uBottomFadeStart: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uFadeByGroundY: { value: fadeByGroundY ? 1 : 0 },
      uHorizonFadeEnd: { value: 1 },
      uHorizonFadeStart: { value: 0 },
      uLineDepthBias: { value: lineDepthBias },
      uOpaqueFill: { value: opaqueFill ? 1 : 0 },
      uOpacity: { value: opacity },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    blending: THREE.NormalBlending,
    side: opaqueFill ? THREE.DoubleSide : THREE.FrontSide,
    transparent: true,
    depthFunc: THREE.LessEqualDepth,
    depthTest,
    depthWrite,
    colorWrite,
  }) as MaterialWithOpacity
}

function makeLineMaterial(
  projectionUniforms: ProjectionUniforms,
  color: string,
  opacity: number,
  fadeByGroundY = false,
  depthTest = false,
  depthWrite = false,
  colorWrite = true,
  lineDepthBias = 0,
) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...projectionUniforms,
      uBottomFadeEnd: { value: 1 },
      uBottomFadeStart: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uFadeByGroundY: { value: fadeByGroundY ? 1 : 0 },
      uHorizonFadeEnd: { value: 1 },
      uHorizonFadeStart: { value: 0 },
      uLineDepthBias: { value: lineDepthBias },
      uLineHalfWidthPx: { value: LINE_HALF_WIDTH_PX },
      uOpaqueFill: { value: 0 },
      uOpacity: { value: opacity },
    },
    vertexShader: THICK_LINE_VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    transparent: true,
    depthFunc: THREE.LessEqualDepth,
    depthTest,
    depthWrite,
    colorWrite,
  }) as MaterialWithOpacity
}

function makeSparkMaterial(
  projectionUniforms: ProjectionUniforms,
  color: string,
) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...projectionUniforms,
      uBottomFadeEnd: { value: 1 },
      uBottomFadeStart: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uHorizonFadeEnd: { value: 1 },
      uHorizonFadeStart: { value: 0 },
      uLineDepthBias: { value: SPARK_DEPTH_BIAS },
    },
    vertexShader: SPARK_VERTEX_SHADER,
    fragmentShader: SPARK_FRAGMENT_SHADER,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthFunc: THREE.LessEqualDepth,
    depthTest: true,
    depthWrite: false,
    transparent: true,
  }) as SparkMaterial
}

function geometryFrom(vertices: number[], indices?: number[]) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  if (indices) geometry.setIndex(indices)
  return geometry
}

function v(x: number, y: number, z: number): Point3 {
  return [x, y, z]
}

function pushVertex(vertices: number[], point: Point3) {
  const index = vertices.length / 3
  vertices.push(point[0], point[1], point[2])
  return index
}

function pushQuad(
  vertices: number[],
  indices: number[],
  a: Point3,
  b: Point3,
  c: Point3,
  d: Point3,
) {
  const i = pushVertex(vertices, a)
  pushVertex(vertices, b)
  pushVertex(vertices, c)
  pushVertex(vertices, d)
  indices.push(i, i + 1, i + 2, i, i + 2, i + 3)
}

function pushTriangle(
  vertices: number[],
  indices: number[],
  a: Point3,
  b: Point3,
  c: Point3,
) {
  const i = pushVertex(vertices, a)
  pushVertex(vertices, b)
  pushVertex(vertices, c)
  indices.push(i, i + 1, i + 2)
}

function pushLine(
  vertices: number[],
  a: Point3,
  b: Point3,
) {
  vertices.push(a[0], a[1], a[2], b[0], b[1], b[2])
}

function lineSegmentKey(segment: SparkLineSegment) {
  const pointKey = (point: Point3) =>
    `${point[0].toFixed(3)},${point[1].toFixed(3)},${point[2].toFixed(3)}`
  const a = pointKey(segment.a)
  const b = pointKey(segment.b)
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function geometryFromThickLineSegments(segments: SparkLineSegment[]) {
  const vertices: number[] = []
  const starts: number[] = []
  const ends: number[] = []
  const sides: number[] = []
  const sidePattern = [-1, -1, 1, -1, 1, 1]

  for (const segment of segments) {
    const points = [
      segment.a,
      segment.b,
      segment.b,
      segment.a,
      segment.b,
      segment.a,
    ]
    for (let i = 0; i < points.length; i += 1) {
      vertices.push(points[i][0], points[i][1], points[i][2])
      starts.push(segment.a[0], segment.a[1], segment.a[2])
      ends.push(segment.b[0], segment.b[1], segment.b[2])
      sides.push(sidePattern[i])
    }
  }

  const geometry = geometryFrom(vertices)
  geometry.setAttribute('aLineStart', new THREE.Float32BufferAttribute(starts, 3))
  geometry.setAttribute('aLineEnd', new THREE.Float32BufferAttribute(ends, 3))
  geometry.setAttribute('aLineSide', new THREE.Float32BufferAttribute(sides, 1))
  return geometry
}

function makeVisibleLinePusher(
  vertices: number[],
  lineSegments: SparkLineSegment[] = [],
): PushVisibleLine {
  const seen = new Set<string>()
  const pointKey = (point: Point3) =>
    `${point[0].toFixed(3)},${point[1].toFixed(3)},${point[2].toFixed(3)}`

  return (a, b) => {
    const ka = pointKey(a)
    const kb = pointKey(b)
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
    if (seen.has(key)) return
    seen.add(key)
    pushLine(vertices, a, b)
    lineSegments.push({ a, b })
  }
}

function pushFaceOutline(pushVisibleLine: PushVisibleLine, points: Point3[]) {
  for (let i = 0; i < points.length; i += 1) {
    pushVisibleLine(points[i], points[(i + 1) % points.length])
  }
}

function getLegacyVisibleSide(box: HomeBackgroundBox): 'left' | 'right' {
  return box.xTiles <= 0 ? 'right' : 'left'
}

function getBoxKind(box: HomeBackgroundBox): RenderableShapeKind {
  return box.kind === 'box' ? 'cube' : box.kind ?? 'cube'
}

function getHalfCylinderShellArcAngleDeg(
  baseArcAngleDeg: number,
  liftHeightPx: number,
) {
  const boundedBaseAngle = Math.max(0, Math.min(90, baseArcAngleDeg))
  const t = Math.max(
    0,
    Math.min(1, liftHeightPx / HALF_CYLINDER_SHELL_MAX_HEIGHT_PX),
  )
  const easedT = t * t * (3 - 2 * t)
  return boundedBaseAngle +
    (HALF_CYLINDER_SHELL_MAX_ARC_ANGLE_DEG - boundedBaseAngle) * easedT
}

function buildCubeGeometry(
  box: HomeBackgroundBox,
  tileSize: number,
  zOffset: number,
  heightPx: number,
) {
  const x0 = box.xTiles * tileSize
  const x1 = x0 + (box.widthTiles ?? 1) * tileSize
  const y0 = 0
  const y1 = (box.depthTiles ?? 1) * tileSize
  const z0 = zOffset
  const z1 = zOffset + heightPx
  const visibleSide = getLegacyVisibleSide(box)
  const fillVertices: number[] = []
  const fillIndices: number[] = []
  const lineVertices: number[] = []
  const lineSegments: SparkLineSegment[] = []
  const pushVisibleLine = makeVisibleLinePusher(lineVertices, lineSegments)

  const top = [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)]
  const front = [v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)]
  const side = visibleSide === 'right'
    ? [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)]
    : [v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)]

  for (const face of [top, front, side]) {
    pushQuad(fillVertices, fillIndices, face[0], face[1], face[2], face[3])
    pushFaceOutline(pushVisibleLine, face)
  }

  return {
    fill: geometryFrom(fillVertices, fillIndices),
    lines: geometryFrom(lineVertices),
    lineSegments,
  }
}

function buildPyramidGeometry(
  box: HomeBackgroundBox,
  tileSize: number,
  zOffset: number,
  heightPx: number,
) {
  const x0 = box.xTiles * tileSize
  const x1 = x0 + (box.widthTiles ?? 1) * tileSize
  const y0 = 0
  const y1 = (box.depthTiles ?? 1) * tileSize
  const z0 = zOffset
  const z1 = zOffset + heightPx
  const apex = v((x0 + x1) / 2, (y0 + y1) / 2, z1)
  const visibleSide = getLegacyVisibleSide(box)
  const side = visibleSide === 'right'
    ? [v(x1, y0, z0), v(x1, y1, z0), apex]
    : [v(x0, y1, z0), v(x0, y0, z0), apex]
  const front = [v(x0, y1, z0), v(x1, y1, z0), apex]
  const fillVertices: number[] = []
  const fillIndices: number[] = []
  const lineVertices: number[] = []
  const lineSegments: SparkLineSegment[] = []
  const pushVisibleLine = makeVisibleLinePusher(lineVertices, lineSegments)

  for (const face of [front, side]) {
    pushTriangle(fillVertices, fillIndices, face[0], face[1], face[2])
    pushFaceOutline(pushVisibleLine, face)
  }

  return {
    fill: geometryFrom(fillVertices, fillIndices),
    lines: geometryFrom(lineVertices),
    lineSegments,
  }
}

function buildTentGeometry(
  box: HomeBackgroundBox,
  tileSize: number,
  zOffset: number,
  heightPx: number,
) {
  const x0 = box.xTiles * tileSize
  const x1 = x0 + (box.widthTiles ?? 1) * tileSize
  const y0 = 0
  const y1 = (box.depthTiles ?? 1) * tileSize
  const z0 = zOffset
  const z1 = zOffset + heightPx
  const ridgeBack = v((x0 + x1) / 2, y0, z1)
  const ridgeFront = v((x0 + x1) / 2, y1, z1)
  const front = [v(x0, y1, z0), v(x1, y1, z0), ridgeFront]
  const visibleSide = getLegacyVisibleSide(box)
  const plane = visibleSide === 'right'
    ? [v(x1, y0, z0), v(x1, y1, z0), ridgeFront, ridgeBack]
    : [v(x0, y1, z0), v(x0, y0, z0), ridgeBack, ridgeFront]
  const fillVertices: number[] = []
  const fillIndices: number[] = []
  const lineVertices: number[] = []
  const lineSegments: SparkLineSegment[] = []
  const pushVisibleLine = makeVisibleLinePusher(lineVertices, lineSegments)

  pushTriangle(fillVertices, fillIndices, front[0], front[1], front[2])
  pushFaceOutline(pushVisibleLine, front)
  pushQuad(fillVertices, fillIndices, plane[0], plane[1], plane[2], plane[3])
  pushFaceOutline(pushVisibleLine, plane)

  return {
    fill: geometryFrom(fillVertices, fillIndices),
    lines: geometryFrom(lineVertices),
    lineSegments,
  }
}

function buildSlopeGeometry(
  box: HomeBackgroundBox,
  tileSize: number,
  zOffset: number,
  heightPx: number,
) {
  const x0 = box.xTiles * tileSize
  const x1 = x0 + (box.widthTiles ?? 1) * tileSize
  const y0 = 0
  const y1 = (box.depthTiles ?? 1) * tileSize
  const z0 = zOffset
  const z1 = zOffset + heightPx
  const fillVertices: number[] = []
  const fillIndices: number[] = []
  const lineVertices: number[] = []
  const lineSegments: SparkLineSegment[] = []
  const pushVisibleLine = makeVisibleLinePusher(lineVertices, lineSegments)

  const facing = box.facing ?? (box.xTiles <= 0 ? 'left' : 'right')
  const crossAxis = facing === 'front' || facing === 'back' ? 'y' : 'x'
  const triangle =
    crossAxis === 'x'
      ? (() => {
          const highX = facing === 'right' ? x0 : x1
          const lowX = facing === 'right' ? x1 : x0
          return [
            v(lowX, y1, z0),
            v(highX, y1, z0),
            v(highX, y1, z1),
          ]
        })()
      : (() => {
          const highY = facing === 'back' ? y0 : y1
          const lowY = facing === 'back' ? y1 : y0
          const sideX = getLegacyVisibleSide(box) === 'right' ? x1 : x0
          return [
            v(sideX, lowY, z0),
            v(sideX, highY, z0),
            v(sideX, highY, z1),
          ]
        })()
  const ramp =
    crossAxis === 'x'
      ? (() => {
          const highX = facing === 'right' ? x0 : x1
          const lowX = facing === 'right' ? x1 : x0
          return [
            v(lowX, y0, z0),
            v(lowX, y1, z0),
            v(highX, y1, z1),
            v(highX, y0, z1),
          ]
        })()
      : (() => {
          const highY = facing === 'back' ? y0 : y1
          const lowY = facing === 'back' ? y1 : y0
          return [
            v(x0, lowY, z0),
            v(x1, lowY, z0),
            v(x1, highY, z1),
            v(x0, highY, z1),
          ]
        })()

  pushTriangle(fillVertices, fillIndices, triangle[0], triangle[1], triangle[2])
  pushFaceOutline(pushVisibleLine, triangle)
  pushQuad(fillVertices, fillIndices, ramp[0], ramp[1], ramp[2], ramp[3])
  pushFaceOutline(pushVisibleLine, ramp)
  if (crossAxis === 'x') {
    const visibleSide = getLegacyVisibleSide(box)
    const highSide = facing === 'left' ? 'right' : 'left'
    if (visibleSide === highSide) {
      const highX = facing === 'right' ? x0 : x1
      const back = [
        v(highX, y0, z0),
        v(highX, y1, z0),
        v(highX, y1, z1),
        v(highX, y0, z1),
      ]
      pushQuad(fillVertices, fillIndices, back[0], back[1], back[2], back[3])
      pushFaceOutline(pushVisibleLine, back)
    }
  }
  if (crossAxis === 'y') {
    const highY = facing === 'back' ? y0 : y1
    const back = [
      v(x0, highY, z0),
      v(x1, highY, z0),
      v(x1, highY, z1),
      v(x0, highY, z1),
    ]
    pushQuad(fillVertices, fillIndices, back[0], back[1], back[2], back[3])
    pushFaceOutline(pushVisibleLine, back)
  }

  return {
    fill: geometryFrom(fillVertices, fillIndices),
    lines: geometryFrom(lineVertices),
    lineSegments,
  }
}

function buildHalfCylinderGeometry(
  box: HomeBackgroundBox,
  tileSize: number,
  zOffset: number,
  shellArcAngleDeg: number,
) {
  const width = (box.widthTiles ?? 1) * tileSize
  const depth = (box.depthTiles ?? 1) * tileSize
  const x0 = box.xTiles * tileSize
  const x1 = x0 + width
  const y0 = 0
  const y1 = depth
  const z0 = zOffset
  const radius = width / 2
  const height = radius
  const cx = (x0 + x1) / 2
  const fillVertices: number[] = []
  const fillIndices: number[] = []
  const lineVertices: number[] = []
  const lineSegments: SparkLineSegment[] = []
  const pushVisibleLine = makeVisibleLinePusher(lineVertices, lineSegments)
  const arcBack: Point3[] = []
  const arcFront: Point3[] = []
  const visibleSide = getLegacyVisibleSide(box)
  const shellArcAngle = getHalfCylinderShellArcAngleDeg(
    shellArcAngleDeg,
    zOffset,
  )
  const shellArcAngleRad =
    (Math.max(0, Math.min(90, shellArcAngle)) * Math.PI) / 180
  const shellTheta = visibleSide === 'right'
    ? Math.PI - shellArcAngleRad
    : shellArcAngleRad

  for (let i = 0; i <= HALF_CYLINDER_SEGMENTS; i += 1) {
    const theta = Math.PI - (Math.PI * i) / HALF_CYLINDER_SEGMENTS
    const back = v(cx + Math.cos(theta) * radius, y0, z0 + Math.sin(theta) * height)
    const front = v(cx + Math.cos(theta) * radius, y1, z0 + Math.sin(theta) * height)
    arcBack.push(back)
    arcFront.push(front)
  }

  for (let i = 0; i < HALF_CYLINDER_SEGMENTS; i += 1) {
    pushQuad(
      fillVertices,
      fillIndices,
      arcBack[i],
      arcFront[i],
      arcFront[i + 1],
      arcBack[i + 1],
    )
  }
  for (let i = 0; i < HALF_CYLINDER_SEGMENTS; i += 1) {
    pushVisibleLine(arcFront[i], arcFront[i + 1])
    pushVisibleLine(arcBack[i], arcBack[i + 1])
  }
  pushVisibleLine(arcBack[0], arcFront[0])
  pushVisibleLine(arcBack[HALF_CYLINDER_SEGMENTS], arcFront[HALF_CYLINDER_SEGMENTS])
  pushVisibleLine(
    v(cx + Math.cos(shellTheta) * radius, y0, z0 + Math.sin(shellTheta) * height),
    v(cx + Math.cos(shellTheta) * radius, y1, z0 + Math.sin(shellTheta) * height),
  )

  for (const y of [y0, y1]) {
    const center = v(cx, y, z0)
    let previous = v(x0, y, z0)
    for (let i = 1; i <= HALF_CYLINDER_SEGMENTS; i += 1) {
      const theta = Math.PI - (Math.PI * i) / HALF_CYLINDER_SEGMENTS
      const next = v(cx + Math.cos(theta) * radius, y, z0 + Math.sin(theta) * height)
      pushTriangle(fillVertices, fillIndices, center, previous, next)
      pushVisibleLine(previous, next)
      previous = next
    }
    pushVisibleLine(v(x0, y, z0), v(x1, y, z0))
  }

  return {
    fill: geometryFrom(fillVertices, fillIndices),
    lines: geometryFrom(lineVertices),
    lineSegments,
  }
}

function buildShapeGeometry(
  box: HomeBackgroundBox,
  tileSize: number,
  zOffset: number,
  kind: RenderableShapeKind,
  heightPx: number,
  shellArcAngleDeg: number,
): ShapeGeometry {
  if (kind === 'pyramid') return buildPyramidGeometry(box, tileSize, zOffset, heightPx)
  if (kind === 'tent') return buildTentGeometry(box, tileSize, zOffset, heightPx)
  if (kind === 'slope') return buildSlopeGeometry(box, tileSize, zOffset, heightPx)
  if (kind === 'halfCylinder') {
    return buildHalfCylinderGeometry(
      box,
      tileSize,
      zOffset,
      shellArcAngleDeg,
    )
  }
  return buildCubeGeometry(box, tileSize, zOffset, heightPx)
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh | THREE.LineSegments
    const maybeGeometry = mesh.geometry as THREE.BufferGeometry | undefined
    if (maybeGeometry) maybeGeometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose())
    } else if (material) {
      material.dispose()
    }
  })
}

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child)
    disposeObject(child)
  }
}

function getGridExtents(width: number, height: number, tileSize: number) {
  const halfWidth = width * 1.3
  const maxDepth = Math.max(
    tileSize * 8,
    Math.min(height * PLANE_SCALE, (CSS_PERSPECTIVE_PX - tileSize) /
      Math.sin((GROUND_TILT_DEG * Math.PI) / 180)),
  )
  return {
    maxDepth,
    maxX: halfWidth,
    minX: -halfWidth,
  }
}

function buildVerticalGridLineSegments(
  width: number,
  height: number,
  tileSize: number,
) {
  const { maxDepth, maxX, minX } = getGridExtents(width, height, tileSize)
  const xStart = Math.floor(minX / tileSize) * tileSize
  const segments: SparkLineSegment[] = []
  for (let x = xStart; x <= maxX; x += tileSize) {
    segments.push({ a: v(x, -tileSize, 0), b: v(x, maxDepth, 0) })
  }
  return segments
}

function buildHorizontalGridLineSegments(
  width: number,
  height: number,
  tileSize: number,
) {
  const { maxDepth, maxX, minX } = getGridExtents(width, height, tileSize)
  const segments: SparkLineSegment[] = []
  for (let y = -tileSize; y <= maxDepth; y += tileSize) {
    segments.push({ a: v(minX, y, 0), b: v(maxX, y, 0) })
  }
  return segments
}

function getSparkTarget(width: number) {
  return width < 768 ? SPARK_MOBILE_TARGET : SPARK_DESKTOP_TARGET
}

function pointToVector(point: Point3) {
  return new THREE.Vector3(point[0], point[1], point[2])
}

function pointKey(point: THREE.Vector3, layer: SparkLayer) {
  return `${layer}:${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`
}

function otherNode(edge: SparkEdge, nodeId: number) {
  return edge.a === nodeId ? edge.b : edge.a
}

function makeSparkGraph() {
  const graph: SparkGraph = { edges: [], nodes: [] }
  const nodeByKey = new Map<string, number>()
  const edgeKeys = new Set<string>()

  const getNode = (point: THREE.Vector3, layer: SparkLayer) => {
    const key = pointKey(point, layer)
    const existing = nodeByKey.get(key)
    if (existing !== undefined) return existing
    const nodeId = graph.nodes.length
    graph.nodes.push({ edgeIds: [], point })
    nodeByKey.set(key, nodeId)
    return nodeId
  }

  const addEdge = (aPoint: Point3, bPoint: Point3, layer: SparkLayer) => {
    const aVector = pointToVector(aPoint)
    const bVector = pointToVector(bPoint)
    const length = aVector.distanceTo(bVector)
    if (length < 1) return
    const a = getNode(aVector, layer)
    const b = getNode(bVector, layer)
    const key = a < b ? `${layer}:${a}:${b}` : `${layer}:${b}:${a}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    const edgeId = graph.edges.length
    graph.edges.push({ a, b, layer, length })
    graph.nodes[a].edgeIds.push(edgeId)
    graph.nodes[b].edgeIds.push(edgeId)
  }

  return { addEdge, graph }
}

function buildSparkGraph(
  width: number,
  height: number,
  tileSize: number,
  objectSegments: SparkLineSegment[],
) {
  const { addEdge, graph } = makeSparkGraph()
  const { maxDepth, maxX, minX } = getGridExtents(width, height, tileSize)
  const xStart = Math.floor(minX / tileSize) * tileSize
  const yStart = -tileSize
  const xValues: number[] = []
  const yValues: number[] = []

  for (let x = xStart; x <= maxX; x += tileSize) xValues.push(x)
  for (let y = yStart; y <= maxDepth; y += tileSize) yValues.push(y)

  for (const y of yValues) {
    for (let i = 0; i < xValues.length - 1; i += 1) {
      addEdge(v(xValues[i], y, 0), v(xValues[i + 1], y, 0), 'grid')
    }
  }
  for (const x of xValues) {
    for (let i = 0; i < yValues.length - 1; i += 1) {
      addEdge(v(x, yValues[i], 0), v(x, yValues[i + 1], 0), 'grid')
    }
  }

  for (const segment of objectSegments) {
    addEdge(segment.a, segment.b, 'object')
  }

  return graph
}

function makeSparkSystem(
  graph: SparkGraph,
  projectionUniforms: ProjectionUniforms,
  color: string,
  width: number,
) {
  const capacity = getSparkTarget(width)
  const positions = new Float32Array(capacity * SPARK_VERTEX_COUNT * 3)
  const alphas = new Float32Array(capacity * SPARK_VERTEX_COUNT)
  const sparkCoords = new Float32Array(capacity * SPARK_VERTEX_COUNT * 2)
  const coords = [
    -SPARK_CAPSULE_HALF_RATIO, -1,
    SPARK_CAPSULE_HALF_RATIO, -1,
    SPARK_CAPSULE_HALF_RATIO, 1,
    -SPARK_CAPSULE_HALF_RATIO, -1,
    SPARK_CAPSULE_HALF_RATIO, 1,
    -SPARK_CAPSULE_HALF_RATIO, 1,
  ]
  for (let i = 0; i < capacity; i += 1) {
    sparkCoords.set(coords, i * SPARK_VERTEX_COUNT * 2)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    'aOpacity',
    new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage),
  )
  geometry.setAttribute(
    'aSparkCoord',
    new THREE.BufferAttribute(sparkCoords, 2),
  )
  const material = makeSparkMaterial(projectionUniforms, color)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 30

  return {
    alphas,
    graph,
    mesh,
    material,
    positions,
    sparks: [],
  } satisfies SparkSystem
}

function disposeSparkSystem(system: SparkSystem | null) {
  if (!system) return
  system.mesh.geometry.dispose()
  system.material.dispose()
  system.mesh.removeFromParent()
}

function getEdgeDisplayMidY(
  graph: SparkGraph,
  edge: SparkEdge,
  layerOffset: number,
) {
  const a = graph.nodes[edge.a].point
  const b = graph.nodes[edge.b].point
  return (a.y + b.y) / 2 + layerOffset
}

function edgeIsVisible(
  graph: SparkGraph,
  edge: SparkEdge,
  layerOffset: number,
  fadeBounds: FadeBounds,
) {
  const midY = getEdgeDisplayMidY(graph, edge, layerOffset)
  return midY >= fadeBounds.horizonFadeStart && midY <= fadeBounds.bottomFadeEnd
}

function getSparkSpawnDistanceRange(
  graph: SparkGraph,
  edge: SparkEdge,
  tileSize: number,
) {
  const a = graph.nodes[edge.a].point
  const b = graph.nodes[edge.b].point
  const minX = SPARK_SPAWN_MIN_X_TILES * tileSize
  const maxX = SPARK_SPAWN_MAX_X_TILES * tileSize
  const dx = b.x - a.x

  if (Math.abs(dx) < 0.001) {
    return a.x >= minX && a.x <= maxX
      ? { minDistance: 0, maxDistance: edge.length }
      : null
  }

  const tA = (minX - a.x) / dx
  const tB = (maxX - a.x) / dx
  const minT = Math.max(0, Math.min(tA, tB))
  const maxT = Math.min(1, Math.max(tA, tB))
  if (minT > maxT) return null

  return {
    minDistance: minT * edge.length,
    maxDistance: maxT * edge.length,
  }
}

function getSpawnLayerOffset(
  edge: SparkEdge,
  groundOffset: number,
  gridShift: number,
) {
  return edge.layer === 'grid' ? gridShift : groundOffset
}

function getSparkLayerOffset(
  spark: Spark,
  edge: SparkEdge,
  groundOffset: number,
) {
  return edge.layer === 'grid'
    ? spark.spawnGridShift + groundOffset - spark.spawnGroundOffset
    : groundOffset
}

function chooseVisibleSparkEdge(
  graph: SparkGraph,
  groundOffset: number,
  gridShift: number,
  fadeBounds: FadeBounds,
  tileSize: number,
): SparkSpawnTarget | null {
  if (graph.edges.length === 0) return null

  const makeSpawnTarget = (edgeId: number) => {
    const edge = graph.edges[edgeId]
    const distanceRange = getSparkSpawnDistanceRange(graph, edge, tileSize)
    if (
      !distanceRange ||
      !edgeIsVisible(
        graph,
        edge,
        getSpawnLayerOffset(edge, groundOffset, gridShift),
        fadeBounds,
      )
    ) {
      return null
    }
    const distanceFromA =
      distanceRange.minDistance +
      Math.random() * (distanceRange.maxDistance - distanceRange.minDistance)
    return { distanceFromA, edgeId }
  }

  const randomTries = Math.min(24, graph.edges.length)
  for (let i = 0; i < randomTries; i += 1) {
    const edgeId = Math.floor(Math.random() * graph.edges.length)
    const target = makeSpawnTarget(edgeId)
    if (target) return target
  }

  const start = Math.floor(Math.random() * graph.edges.length)
  for (let i = 0; i < graph.edges.length; i += 1) {
    const edgeId = (start + i) % graph.edges.length
    const target = makeSpawnTarget(edgeId)
    if (target) return target
  }

  return null
}

function makeSparkOnEdge(
  graph: SparkGraph,
  spawnTarget: SparkSpawnTarget,
  groundOffset: number,
  gridShift: number,
): Spark {
  const edgeId = spawnTarget.edgeId
  const edge = graph.edges[edgeId]
  const forward = Math.random() < 0.5
  const fromNode = forward ? edge.a : edge.b
  const toNode = forward ? edge.b : edge.a
  return {
    age: 0,
    distance: forward
      ? spawnTarget.distanceFromA
      : edge.length - spawnTarget.distanceFromA,
    edgeId,
    fadeAge: null,
    fadeDuration: SPARK_FADE_OUT_SECONDS,
    fromNode,
    maxAge: 6 + Math.random() * 4,
    seed: Math.random(),
    size: 5.5 + Math.random() * 3.5,
    spawnGridShift: gridShift,
    spawnGroundOffset: groundOffset,
    speed: 45 + Math.random() * 50,
    toNode,
  }
}

function chooseNextSparkEdge(graph: SparkGraph, spark: Spark) {
  const node = graph.nodes[spark.toNode]
  const candidates = node.edgeIds.filter((edgeId) => edgeId !== spark.edgeId)
  if (candidates.length === 0) return null
  if (candidates.length === 1 || Math.random() < 0.7) {
    const fromPoint = graph.nodes[spark.fromNode].point
    const nodePoint = node.point
    const incoming = nodePoint.clone().sub(fromPoint).normalize()
    let bestEdge = candidates[0]
    let bestDot = -Infinity
    for (const edgeId of candidates) {
      const edge = graph.edges[edgeId]
      const candidatePoint = graph.nodes[otherNode(edge, spark.toNode)].point
      const outgoing = candidatePoint.clone().sub(nodePoint).normalize()
      const dot = incoming.dot(outgoing)
      if (dot > bestDot) {
        bestDot = dot
        bestEdge = edgeId
      }
    }
    return bestEdge
  }
  return candidates[Math.floor(Math.random() * candidates.length)]
}

function updateSparkSystem(
  system: SparkSystem,
  dt: number,
  groundOffset: number,
  gridShift: number,
  fadeBounds: FadeBounds,
  tileSize: number,
  width: number,
) {
  const target = getSparkTarget(width)
  const graph = system.graph

  for (let i = system.sparks.length - 1; i >= 0; i -= 1) {
    const spark = system.sparks[i]
    spark.age += dt
    if (
      spark.fadeAge === null &&
      spark.age >= spark.maxAge - spark.fadeDuration
    ) {
      spark.fadeAge = Math.max(0, spark.age - (spark.maxAge - spark.fadeDuration))
    } else if (spark.fadeAge !== null) {
      spark.fadeAge += dt
    }

    spark.distance += spark.speed * dt
    let guard = 0
    while (guard < 4) {
      guard += 1
      const edge = graph.edges[spark.edgeId]
      if (
        spark.fadeAge === null &&
        edge.length - spark.distance <= spark.speed * spark.fadeDuration &&
        graph.nodes[spark.toNode].edgeIds.every((edgeId) => edgeId === spark.edgeId)
      ) {
        const secondsUntilEnd = Math.max(0, (edge.length - spark.distance) / spark.speed)
        spark.fadeAge = Math.max(0, spark.fadeDuration - secondsUntilEnd)
      }
      if (spark.distance < edge.length) break
      const overflow = spark.distance - edge.length
      const nextEdgeId = chooseNextSparkEdge(graph, spark)
      if (nextEdgeId === null) {
        spark.distance = edge.length
        spark.fadeAge = spark.fadeDuration
        break
      }
      spark.fromNode = spark.toNode
      spark.edgeId = nextEdgeId
      const nextEdge = graph.edges[nextEdgeId]
      spark.toNode = otherNode(nextEdge, spark.fromNode)
      spark.distance = overflow
    }

    const edge = graph.edges[spark.edgeId]
    const layerOffset = getSparkLayerOffset(spark, edge, groundOffset)
    if (!edgeIsVisible(graph, edge, layerOffset, fadeBounds)) {
      system.sparks.splice(i, 1)
      continue
    }
    if (spark.fadeAge !== null && spark.fadeAge >= spark.fadeDuration) {
      system.sparks.splice(i, 1)
    }
  }

  while (system.sparks.length < target) {
    const spawnTarget = chooseVisibleSparkEdge(
      graph,
      groundOffset,
      gridShift,
      fadeBounds,
      tileSize,
    )
    if (spawnTarget === null) break
    system.sparks.push(makeSparkOnEdge(graph, spawnTarget, groundOffset, gridShift))
  }

  const capacity = system.alphas.length / SPARK_VERTEX_COUNT
  for (let i = 0; i < capacity; i += 1) {
    const spark = system.sparks[i]
    const vertexIndex = i * SPARK_VERTEX_COUNT
    const positionIndex = vertexIndex * 3
    if (!spark) {
      for (let vertex = 0; vertex < SPARK_VERTEX_COUNT; vertex += 1) {
        const alphaIndex = vertexIndex + vertex
        const emptyPositionIndex = alphaIndex * 3
        system.alphas[alphaIndex] = 0
        system.positions[emptyPositionIndex] = 0
        system.positions[emptyPositionIndex + 1] = 0
        system.positions[emptyPositionIndex + 2] = 0
      }
      continue
    }

    const edge = graph.edges[spark.edgeId]
    const from = graph.nodes[spark.fromNode].point
    const to = graph.nodes[spark.toNode].point
    const edgeDx = to.x - from.x
    const edgeDy = to.y - from.y
    const edgeDz = to.z - from.z
    const distance = Math.max(0, Math.min(edge.length, spark.distance))
    const halfLength = Math.min(edge.length / 2, Math.max(3, spark.size * 0.45))
    const startDistance = Math.max(0, distance - halfLength)
    const endDistance = Math.min(edge.length, distance + halfLength)
    const startT = startDistance / edge.length
    const endT = endDistance / edge.length
    const offset = getSparkLayerOffset(spark, edge, groundOffset)
    const introOpacity = Math.min(1, spark.age / SPARK_FADE_IN_SECONDS)
    const fadeOpacity =
      spark.fadeAge === null
        ? 1
        : Math.max(0, 1 - spark.fadeAge / spark.fadeDuration)
    const flicker =
      0.86 + Math.sin((spark.age * 12 + spark.seed * 10) * Math.PI) * 0.14
    const alpha = introOpacity * fadeOpacity * flicker

    const startX = from.x + edgeDx * startT
    const startY = from.y + edgeDy * startT + offset
    const startZ = from.z + edgeDz * startT
    const endX = from.x + edgeDx * endT
    const endY = from.y + edgeDy * endT + offset
    const endZ = from.z + edgeDz * endT
    const screenDx = endX - startX
    const screenDy =
      (endY - startY) * GROUND_TILT_COS - (endZ - startZ) * GROUND_TILT_SIN
    const screenLength = Math.hypot(screenDx, screenDy)
    const perpScreenX = screenLength > 0.001 ? -screenDy / screenLength : 0
    const perpScreenY = screenLength > 0.001 ? screenDx / screenLength : 1
    const halfWidth = Math.max(2, spark.size * 0.42)
    const perpX = perpScreenX * halfWidth
    const perpY = perpScreenY * GROUND_TILT_COS * halfWidth
    const perpZ = -perpScreenY * GROUND_TILT_SIN * halfWidth
    const vertices = [
      startX - perpX,
      startY - perpY,
      startZ - perpZ,
      endX - perpX,
      endY - perpY,
      endZ - perpZ,
      endX + perpX,
      endY + perpY,
      endZ + perpZ,
      startX - perpX,
      startY - perpY,
      startZ - perpZ,
      endX + perpX,
      endY + perpY,
      endZ + perpZ,
      startX + perpX,
      startY + perpY,
      startZ + perpZ,
    ]

    for (let vertex = 0; vertex < SPARK_VERTEX_COUNT; vertex += 1) {
      const alphaIndex = vertexIndex + vertex
      const sourceIndex = vertex * 3
      const targetIndex = positionIndex + sourceIndex
      system.positions[targetIndex] = vertices[sourceIndex]
      system.positions[targetIndex + 1] = vertices[sourceIndex + 1]
      system.positions[targetIndex + 2] = vertices[sourceIndex + 2]
      system.alphas[alphaIndex] = alpha
    }
  }

  const positionAttr = system.mesh.geometry.getAttribute('position')
  const opacityAttr = system.mesh.geometry.getAttribute('aOpacity')
  positionAttr.needsUpdate = true
  opacityAttr.needsUpdate = true
}

function createBoxObject(
  box: HomeBackgroundBox,
  scene: HomeBackgroundScene,
  projectionUniforms: ProjectionUniforms,
  colors: ReturnType<typeof readSceneColors>,
) {
  const fillGroup = new THREE.Group()
  const lineGroup = new THREE.Group()
  fillGroup.position.y = box.yTiles * scene.tileSize
  lineGroup.position.y = box.yTiles * scene.tileSize
  fillGroup.frustumCulled = false
  lineGroup.frustumCulled = false
  const materials: MaterialWithOpacity[] = []
  const objectLineSegments: SparkLineSegment[] = []
  const objectLineSegmentKeys = new Set<string>()
  const addObjectLineSegment = (segment: SparkLineSegment) => {
    const shiftedSegment = {
      a: [
        segment.a[0],
        segment.a[1] + box.yTiles * scene.tileSize,
        segment.a[2],
      ],
      b: [
        segment.b[0],
        segment.b[1] + box.yTiles * scene.tileSize,
        segment.b[2],
      ],
    } satisfies SparkLineSegment
    const key = lineSegmentKey(shiftedSegment)
    if (objectLineSegmentKeys.has(key)) return
    objectLineSegmentKeys.add(key)
    objectLineSegments.push(shiftedSegment)
  }
  const addShape = (
    kind: RenderableShapeKind,
    zOffset: number,
    heightPx: number,
    shapeBox = box,
  ) => {
    const { fill, lines, lineSegments } = buildShapeGeometry(
      shapeBox,
      scene.tileSize,
      zOffset,
      kind,
      heightPx,
      scene.halfCylinderShellArcAngleDeg,
    )
    const fillMaterial = makeMaterial(
      projectionUniforms,
      colors.background,
      1,
      true,
      true,
      true,
      true,
      true,
    )
    const lineMaterial = makeLineMaterial(
      projectionUniforms,
      colors.accent,
      box.opacity ?? 1,
      true,
      true,
      false,
      true,
      OUTLINE_DEPTH_BIAS,
    )
    updateMaterialDisplayColor(fillMaterial, colors.background)
    materials.push(fillMaterial, lineMaterial)
    const fillMesh = new THREE.Mesh(fill, fillMaterial)
    const lineMesh = new THREE.Mesh(
      geometryFromThickLineSegments(lineSegments),
      lineMaterial,
    )
    lines.dispose()
    fillMesh.frustumCulled = false
    lineMesh.frustumCulled = false
    fillMesh.renderOrder = 10
    lineMesh.renderOrder = 20
    fillGroup.add(fillMesh)
    lineGroup.add(lineMesh)
    for (const segment of lineSegments) {
      addObjectLineSegment(segment)
    }
  }

  const depthPx = (box.depthTiles ?? 1) * scene.tileSize
  const kind = getBoxKind(box)
  const widthPx = (box.widthTiles ?? 1) * scene.tileSize
  const baseHeightPx = kind === 'halfCylinder' ? widthPx / 2 : box.heightPx ?? scene.tileSize
  addShape(kind, 0, baseHeightPx)

  if (kind === 'cube' && box.hat) {
    const hatHeight =
      box.hat.kind === 'halfCylinder'
        ? widthPx / 2
        : box.hat.heightPx
    addShape(
      box.hat.kind,
      baseHeightPx,
      hatHeight,
      {
        ...box,
        kind: box.hat.kind,
        facing:
          box.hat.kind === 'slope'
            ? box.hat.facing ?? box.facing ?? 'right'
            : box.facing,
      },
    )
  }

  return {
    fillGroup,
    lineGroup,
    materials,
    lineSegments: objectLineSegments,
    maxYPx: box.yTiles * scene.tileSize + depthPx,
    minYPx: box.yTiles * scene.tileSize,
  }
}

function updateMaterialColor(material: MaterialWithOpacity, color: string) {
  try {
    material.uniforms.uColor.value.set(color)
  } catch {
    material.uniforms.uColor.value.set('#2563eb')
  }
}

function updateFadeBounds(
  material: MaterialWithFadeBounds,
  bounds: FadeBounds,
) {
  material.uniforms.uBottomFadeEnd.value = bounds.bottomFadeEnd
  material.uniforms.uBottomFadeStart.value = bounds.bottomFadeStart
  material.uniforms.uHorizonFadeEnd.value = bounds.horizonFadeEnd
  material.uniforms.uHorizonFadeStart.value = bounds.horizonFadeStart
}

export function HomeThreeBackground({
  horizonY,
  scene,
  scrollerRef,
}: HomeThreeBackgroundProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<RenderState | null>(null)
  const latestRef = useRef({ horizonY, scene })

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let raf: number | null = null
    let sparkRaf: number | null = null
    let lastSparkFrame: number | null = null
    let disposed = false
    let fadeTargets: FadeTarget[] = []
    let gridMaterials: MaterialWithOpacity[] = []
    let sparkSystem: SparkSystem | null = null
    const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
    const projectionUniforms = makeProjectionUniforms()
    const threeScene = new THREE.Scene()
    const camera = new THREE.Camera()
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.sortObjects = false
    renderer.domElement.className = 'home-three-background__canvas'
    mount.appendChild(renderer.domElement)

    const verticalGridGroup = new THREE.Group()
    const horizontalGridGroup = new THREE.Group()
    const fillGroup = new THREE.Group()
    const lineGroup = new THREE.Group()
    threeScene.add(
      verticalGridGroup,
      horizontalGridGroup,
      fillGroup,
      lineGroup,
    )

    let colors = readSceneColors()

    const updateViewport = () => {
      const width = Math.max(1, mount.clientWidth)
      const height = Math.max(1, mount.clientHeight)
      renderer.setSize(width, height, false)
      projectionUniforms.uViewport.value.set(width, height)
      projectionUniforms.uOrigin.value.set(width / 2, latestRef.current.horizonY)
    }

    const syncColors = () => {
      colors = readSceneColors()
      for (const material of gridMaterials) {
        updateMaterialColor(material, colors.accent)
      }
      if (sparkSystem) {
        sparkSystem.material.uniforms.uColor.value.set(colors.accent)
      }
      for (const target of fadeTargets) {
        for (let i = 0; i < target.materials.length; i += 2) {
          updateMaterialDisplayColor(target.materials[i], colors.background)
          updateMaterialColor(target.materials[i + 1], colors.accent)
        }
      }
    }

    const clearSparkBuffers = () => {
      if (!sparkSystem) return
      sparkSystem.sparks = []
      sparkSystem.alphas.fill(0)
      sparkSystem.positions.fill(0)
      const positionAttr = sparkSystem.mesh.geometry.getAttribute('position')
      const opacityAttr = sparkSystem.mesh.geometry.getAttribute('aOpacity')
      positionAttr.needsUpdate = true
      opacityAttr.needsUpdate = true
    }

    const shouldAnimateSparks = () =>
      !disposed &&
      sparkSystem !== null &&
      !motionMedia.matches &&
      document.visibilityState === 'visible'

    const stopSparkLoop = () => {
      if (sparkRaf !== null) cancelAnimationFrame(sparkRaf)
      sparkRaf = null
      lastSparkFrame = null
    }

    const startSparkLoop = () => {
      if (!shouldAnimateSparks() || sparkRaf !== null) return
      sparkRaf = requestAnimationFrame((now) => {
        sparkRaf = null
        const dt =
          lastSparkFrame === null
            ? 0
            : Math.min(0.05, (now - lastSparkFrame) / 1000)
        lastSparkFrame = now
        render(dt)
        startSparkLoop()
      })
    }

    const rebuild = () => {
      disposeSparkSystem(sparkSystem)
      sparkSystem = null
      clearGroup(verticalGridGroup)
      clearGroup(horizontalGridGroup)
      clearGroup(fillGroup)
      clearGroup(lineGroup)
      fadeTargets = []
      gridMaterials = []
      updateViewport()
      const activeScene = latestRef.current.scene
      const floorHeight = mount.clientHeight - latestRef.current.horizonY
      const objectSegments: SparkLineSegment[] = []
      const verticalGridMaterial = makeLineMaterial(
        projectionUniforms,
        colors.accent,
        1,
        true,
        false,
        false,
      )
      const horizontalGridMaterial = makeLineMaterial(
        projectionUniforms,
        colors.accent,
        1,
        true,
        false,
        false,
      )
      gridMaterials.push(
        verticalGridMaterial,
        horizontalGridMaterial,
      )
      const verticalSegments = buildVerticalGridLineSegments(
        mount.clientWidth,
        floorHeight,
        activeScene.tileSize,
      )
      const horizontalSegments = buildHorizontalGridLineSegments(
        mount.clientWidth,
        floorHeight,
        activeScene.tileSize,
      )
      const verticalGrid = new THREE.Mesh(
        geometryFromThickLineSegments(verticalSegments),
        verticalGridMaterial,
      )
      const horizontalGrid = new THREE.Mesh(
        geometryFromThickLineSegments(horizontalSegments),
        horizontalGridMaterial,
      )
      verticalGrid.frustumCulled = false
      horizontalGrid.frustumCulled = false
      verticalGrid.renderOrder = 0
      horizontalGrid.renderOrder = 1
      verticalGridGroup.add(verticalGrid)
      horizontalGridGroup.add(horizontalGrid)

      for (const box of activeScene.boxes) {
        const target = createBoxObject(box, activeScene, projectionUniforms, colors)
        fillGroup.add(target.fillGroup)
        lineGroup.add(target.lineGroup)
        fadeTargets.push(target)
        objectSegments.push(...target.lineSegments)
      }
      sparkSystem = makeSparkSystem(
        buildSparkGraph(
          mount.clientWidth,
          floorHeight,
          activeScene.tileSize,
          objectSegments,
        ),
        projectionUniforms,
        colors.accent,
        mount.clientWidth,
      )
      threeScene.add(sparkSystem.mesh)
      syncColors()
      if (motionMedia.matches) {
        clearSparkBuffers()
      } else {
        startSparkLoop()
      }
    }

    const render = (dt = 0) => {
      if (disposed) return
      const activeScene = latestRef.current.scene
      const scroller = scrollerRef.current
      const scrollTop = scroller?.scrollTop ?? 0
      const groundOffset = scrollTop * activeScene.groundScrollFactor
      const gridShift = groundOffset % activeScene.tileSize
      const tileSize = activeScene.tileSize
      const horizonFadeStart = tileSize * HORIZON_FADE_START_TILES
      const horizonFadeEnd = tileSize * HORIZON_FADE_END_TILES
      const bottomFadeEnd =
        horizonFadeEnd + tileSize * BOTTOM_FADE_END_AFTER_HORIZON_TILES
      const bottomFadeStart =
        bottomFadeEnd - tileSize * BOTTOM_FADE_OUT_DISTANCE_TILES
      const fadeBounds = {
        bottomFadeEnd,
        bottomFadeStart,
        horizonFadeEnd,
        horizonFadeStart,
      }

      horizontalGridGroup.position.y = gridShift
      fillGroup.position.y = groundOffset
      lineGroup.position.y = groundOffset

      for (const material of gridMaterials) {
        updateFadeBounds(material, fadeBounds)
      }

      if (sparkSystem) {
        updateFadeBounds(sparkSystem.material, fadeBounds)
      }

      for (const target of fadeTargets) {
        const minY = target.minYPx + groundOffset
        const maxY = target.maxYPx + groundOffset
        const visible = maxY >= horizonFadeStart && minY <= bottomFadeEnd
        target.fillGroup.visible = visible
        target.lineGroup.visible = visible
        for (const material of target.materials) {
          updateFadeBounds(material, fadeBounds)
        }
      }

      if (
        sparkSystem &&
        dt > 0 &&
        !motionMedia.matches &&
        document.visibilityState === 'visible'
      ) {
        updateSparkSystem(
          sparkSystem,
          dt,
          groundOffset,
          gridShift,
          fadeBounds,
          tileSize,
          mount.clientWidth,
        )
      }

      renderer.render(threeScene, camera)
    }

    const requestRender = () => {
      if (sparkRaf !== null) return
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        render()
      })
    }

    const resizeObserver = new ResizeObserver(() => {
      rebuild()
      requestRender()
    })
    resizeObserver.observe(mount)
    const mutationObserver = new MutationObserver(() => {
      syncColors()
      requestRender()
    })
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    const scroller = scrollerRef.current
    scroller?.addEventListener('scroll', requestRender, { passive: true })
    const onMotionChange = () => {
      if (motionMedia.matches) {
        stopSparkLoop()
        clearSparkBuffers()
        requestRender()
      } else {
        startSparkLoop()
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        startSparkLoop()
        requestRender()
      } else {
        stopSparkLoop()
      }
    }
    motionMedia.addEventListener('change', onMotionChange)
    document.addEventListener('visibilitychange', onVisibilityChange)

    const state: RenderState = {
      camera,
      dispose: () => {
        disposed = true
        if (raf !== null) cancelAnimationFrame(raf)
        stopSparkLoop()
        resizeObserver.disconnect()
        mutationObserver.disconnect()
        motionMedia.removeEventListener('change', onMotionChange)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        scroller?.removeEventListener('scroll', requestRender)
        disposeSparkSystem(sparkSystem)
        sparkSystem = null
        clearGroup(verticalGridGroup)
        clearGroup(horizontalGridGroup)
        clearGroup(fillGroup)
        clearGroup(lineGroup)
        renderer.dispose()
        renderer.domElement.remove()
      },
      fillGroup,
      horizontalGridGroup,
      lineGroup,
      projectionUniforms,
      rebuild,
      renderer,
      render,
      requestRender,
      scene: threeScene,
      verticalGridGroup,
    }
    stateRef.current = state

    rebuild()
    render()

    return () => {
      state.dispose()
      if (stateRef.current === state) stateRef.current = null
    }
  }, [scrollerRef])

  useEffect(() => {
    latestRef.current = { horizonY, scene }
    const state = stateRef.current
    if (!state) return
    state.projectionUniforms.uOrigin.value.set(
      state.renderer.domElement.clientWidth / 2,
      horizonY,
    )
    state.rebuild()
    state.requestRender()
  }, [horizonY, scene])

  return <div ref={mountRef} className="home-three-background" />
}
