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

type MaterialWithOpacity = THREE.ShaderMaterial & {
  uniforms: {
    uBottomFadeEnd: { value: number }
    uBottomFadeStart: { value: number }
    uColor: { value: THREE.Color }
    uFadeByGroundY: { value: number }
    uHorizonFadeEnd: { value: number }
    uHorizonFadeStart: { value: number }
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

type RenderState = {
  camera: THREE.Camera
  dispose: () => void
  fillGroup: THREE.Group
  horizontalGridGroup: THREE.Group
  lineGroup: THREE.Group
  projectionUniforms: ProjectionUniforms
  rebuild: () => void
  renderer: THREE.WebGLRenderer
  render: () => void
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
const PLANE_SCALE = 2.6
const HORIZON_FADE_START_TILES = -3
const HORIZON_FADE_END_TILES = 4
const BOTTOM_FADE_OUT_DISTANCE_TILES = 3
const HALF_CYLINDER_SEGMENTS = 18
const HALF_CYLINDER_SHELL_MAX_HEIGHT_PX = 248
const HALF_CYLINDER_SHELL_MAX_ARC_ANGLE_DEG = 90
const OUTLINE_DEPTH_BIAS = 0.0001

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
  const tiltRad = (GROUND_TILT_DEG * Math.PI) / 180
  return {
    uCosTilt: { value: Math.cos(tiltRad) },
    uDepthFar: { value: CSS_PERSPECTIVE_PX * 2 },
    uDepthNear: { value: 1 },
    uOrigin: { value: new THREE.Vector2(0, 0) },
    uPerspective: { value: CSS_PERSPECTIVE_PX },
    uSinTilt: { value: Math.sin(tiltRad) },
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

function makeVisibleLinePusher(vertices: number[]): PushVisibleLine {
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
  const pushVisibleLine = makeVisibleLinePusher(lineVertices)

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
  const pushVisibleLine = makeVisibleLinePusher(lineVertices)

  for (const face of [front, side]) {
    pushTriangle(fillVertices, fillIndices, face[0], face[1], face[2])
    pushFaceOutline(pushVisibleLine, face)
  }

  return {
    fill: geometryFrom(fillVertices, fillIndices),
    lines: geometryFrom(lineVertices),
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
  const pushVisibleLine = makeVisibleLinePusher(lineVertices)

  pushTriangle(fillVertices, fillIndices, front[0], front[1], front[2])
  pushFaceOutline(pushVisibleLine, front)
  pushQuad(fillVertices, fillIndices, plane[0], plane[1], plane[2], plane[3])
  pushFaceOutline(pushVisibleLine, plane)

  return {
    fill: geometryFrom(fillVertices, fillIndices),
    lines: geometryFrom(lineVertices),
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
  const pushVisibleLine = makeVisibleLinePusher(lineVertices)

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
  const pushVisibleLine = makeVisibleLinePusher(lineVertices)
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
  }
}

function buildShapeGeometry(
  box: HomeBackgroundBox,
  tileSize: number,
  zOffset: number,
  kind: RenderableShapeKind,
  heightPx: number,
  shellArcAngleDeg: number,
) {
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

function buildVerticalGridGeometry(
  width: number,
  height: number,
  tileSize: number,
) {
  const { maxDepth, maxX, minX } = getGridExtents(width, height, tileSize)
  const xStart = Math.floor(minX / tileSize) * tileSize
  const vertices: number[] = []
  for (let x = xStart; x <= maxX; x += tileSize) {
    pushLine(vertices, v(x, -tileSize, 0), v(x, maxDepth, 0))
  }
  return geometryFrom(vertices)
}

function buildHorizontalGridGeometry(
  width: number,
  height: number,
  tileSize: number,
) {
  const { maxDepth, maxX, minX } = getGridExtents(width, height, tileSize)
  const vertices: number[] = []
  for (let y = -tileSize; y <= maxDepth; y += tileSize) {
    pushLine(vertices, v(minX, y, 0), v(maxX, y, 0))
  }
  return geometryFrom(vertices)
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
  const addShape = (
    kind: RenderableShapeKind,
    zOffset: number,
    heightPx: number,
    shapeBox = box,
  ) => {
    const { fill, lines } = buildShapeGeometry(
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
    const lineMaterial = makeMaterial(
      projectionUniforms,
      colors.accent,
      box.opacity ?? 1,
      true,
      false,
      true,
      false,
      true,
      OUTLINE_DEPTH_BIAS,
    )
    updateMaterialDisplayColor(fillMaterial, colors.background)
    materials.push(fillMaterial, lineMaterial)
    const fillMesh = new THREE.Mesh(fill, fillMaterial)
    const lineMesh = new THREE.LineSegments(lines, lineMaterial)
    fillMesh.frustumCulled = false
    lineMesh.frustumCulled = false
    fillMesh.renderOrder = 10
    lineMesh.renderOrder = 20
    fillGroup.add(fillMesh)
    lineGroup.add(lineMesh)
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
  material: MaterialWithOpacity,
  bounds: {
    bottomFadeEnd: number
    bottomFadeStart: number
    horizonFadeEnd: number
    horizonFadeStart: number
  },
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

  latestRef.current = { horizonY, scene }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let raf: number | null = null
    let disposed = false
    let fadeTargets: FadeTarget[] = []
    let gridMaterials: MaterialWithOpacity[] = []
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
      for (const target of fadeTargets) {
        for (let i = 0; i < target.materials.length; i += 2) {
          updateMaterialDisplayColor(target.materials[i], colors.background)
          updateMaterialColor(target.materials[i + 1], colors.accent)
        }
      }
    }

    const rebuild = () => {
      clearGroup(verticalGridGroup)
      clearGroup(horizontalGridGroup)
      clearGroup(fillGroup)
      clearGroup(lineGroup)
      fadeTargets = []
      gridMaterials = []
      updateViewport()
      const activeScene = latestRef.current.scene
      const floorHeight = mount.clientHeight - latestRef.current.horizonY
      const verticalGridMaterial = makeMaterial(
        projectionUniforms,
        colors.accent,
        1,
        true,
        false,
        true,
        false,
      )
      const horizontalGridMaterial = makeMaterial(
        projectionUniforms,
        colors.accent,
        1,
        true,
        false,
        true,
        false,
      )
      gridMaterials.push(verticalGridMaterial, horizontalGridMaterial)
      const verticalGrid = new THREE.LineSegments(
        buildVerticalGridGeometry(mount.clientWidth, floorHeight, activeScene.tileSize),
        verticalGridMaterial,
      )
      const horizontalGrid = new THREE.LineSegments(
        buildHorizontalGridGeometry(mount.clientWidth, floorHeight, activeScene.tileSize),
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
      }
      syncColors()
    }

    const render = () => {
      if (disposed) return
      const activeScene = latestRef.current.scene
      const scroller = scrollerRef.current
      const scrollTop = scroller?.scrollTop ?? 0
      const groundOffset = scrollTop * activeScene.groundScrollFactor
      const tileSize = activeScene.tileSize
      const floorHeight = Math.max(1, mount.clientHeight - latestRef.current.horizonY)
      const streamerHeight = floorHeight * PLANE_SCALE
      const horizonFadeStart = tileSize * HORIZON_FADE_START_TILES
      const horizonFadeEnd = tileSize * HORIZON_FADE_END_TILES
      const bottomFadeStart = Math.max(
        horizonFadeEnd + tileSize * 4,
        streamerHeight - tileSize * 6,
      )
      const bottomFadeEnd = bottomFadeStart + tileSize * BOTTOM_FADE_OUT_DISTANCE_TILES
      const fadeBounds = {
        bottomFadeEnd,
        bottomFadeStart,
        horizonFadeEnd,
        horizonFadeStart,
      }

      horizontalGridGroup.position.y = groundOffset % tileSize
      fillGroup.position.y = groundOffset
      lineGroup.position.y = groundOffset

      for (const material of gridMaterials) {
        updateFadeBounds(material, fadeBounds)
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

      renderer.render(threeScene, camera)
    }

    const requestRender = () => {
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

    const state: RenderState = {
      camera,
      dispose: () => {
        disposed = true
        if (raf !== null) cancelAnimationFrame(raf)
        resizeObserver.disconnect()
        mutationObserver.disconnect()
        scroller?.removeEventListener('scroll', requestRender)
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
