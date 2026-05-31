export type HomeBackgroundObjectKind =
  | 'cube'
  | 'box'
  | 'pyramid'
  | 'tent'
  | 'halfCylinder';

export type HomeBackgroundHatKind = Exclude<HomeBackgroundObjectKind, 'cube' | 'box'>

export type HomeBackgroundHat = {
  kind: HomeBackgroundHatKind
  heightPx: number
}

export type HomeBackgroundBox = {
  id: string
  kind?: HomeBackgroundObjectKind
  hat?: HomeBackgroundHat
  xTiles: number
  yTiles: number
  widthTiles?: number
  depthTiles?: number
  heightPx?: number
  opacity?: number
}

export type HomeBackgroundScene = {
  schemaVersion: 1
  tileSize: number
  horizonGapPx: number
  groundScrollFactor: number
  halfCylinderShellArcAngleDeg: number
  boxes: HomeBackgroundBox[]
}

type HomeBackgroundBoxStream = {
  id?: string
  kind?: HomeBackgroundObjectKind
  xTiles?: number
  startYTiles?: number
  stepYTiles?: number
  count?: number
  widthTiles?: number
  depthTiles?: number
  heightPx?: number
  opacity?: number
  hat?: Partial<HomeBackgroundHat>
}

export const HOME_BACKGROUND_TILE = 64
export const HOME_BACKGROUND_HORIZON_GAP_PX = 48
export const HOME_BACKGROUND_SCROLL_FACTOR = 0.2
export const HOME_BACKGROUND_HALF_CYLINDER_SHELL_ARC_ANGLE_DEG = 45

const CUBE_LANE_LEFT_X = -7
const CUBE_LANE_RIGHT_X = 6
const CUBE_STREAM_START_Y = -1
const CUBE_STREAM_COUNT = 48

function makeFallbackBoxes(count: number): HomeBackgroundBox[] {
  return Array.from({ length: count }, (_, i) => CUBE_STREAM_START_Y - i).flatMap(
    (yTiles) => [
      {
        id: `cube-left-${yTiles}`,
        xTiles: CUBE_LANE_LEFT_X,
        yTiles,
        heightPx: HOME_BACKGROUND_TILE,
        opacity: 1,
      },
      {
        id: `cube-right-${yTiles}`,
        xTiles: CUBE_LANE_RIGHT_X,
        yTiles,
        heightPx: HOME_BACKGROUND_TILE,
        opacity: 1,
      },
    ],
  )
}

export const FALLBACK_HOME_BACKGROUND_SCENE: HomeBackgroundScene = {
  schemaVersion: 1,
  tileSize: HOME_BACKGROUND_TILE,
  horizonGapPx: HOME_BACKGROUND_HORIZON_GAP_PX,
  groundScrollFactor: HOME_BACKGROUND_SCROLL_FACTOR,
  halfCylinderShellArcAngleDeg:
    HOME_BACKGROUND_HALF_CYLINDER_SHELL_ARC_ANGLE_DEG,
  boxes: makeFallbackBoxes(CUBE_STREAM_COUNT),
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveNumber(value: unknown, fallback: number) {
  const n = finiteNumber(value, fallback)
  return n > 0 ? n : fallback
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const n = finiteNumber(value, fallback)
  return Math.max(min, Math.min(max, n))
}

function normalizeKind(value: unknown): HomeBackgroundObjectKind {
  if (value === 'pyramid' || value === 'tent' || value === 'halfCylinder') {
    return value
  }
  return 'cube'
}

function normalizeHatKind(value: unknown): HomeBackgroundHatKind | null {
  if (value === 'pyramid' || value === 'tent' || value === 'halfCylinder') {
    return value
  }
  return null
}

function normalizeHat(value: unknown): HomeBackgroundHat | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<HomeBackgroundHat>
  const kind = normalizeHatKind(raw.kind)
  if (!kind) return undefined
  return {
    kind,
    heightPx: positiveNumber(raw.heightPx, HOME_BACKGROUND_TILE * 0.75),
  }
}

function normalizeBox(raw: unknown, index: number): HomeBackgroundBox | null {
  if (!raw || typeof raw !== 'object') return null
  const box = raw as Partial<HomeBackgroundBox>
  const xTiles = finiteNumber(box.xTiles, NaN)
  const yTiles = finiteNumber(box.yTiles, NaN)
  if (!Number.isFinite(xTiles) || !Number.isFinite(yTiles)) return null
  const kind = normalizeKind(box.kind)

  return {
    id:
      typeof box.id === 'string' && box.id.trim()
        ? box.id.trim()
        : `box-${index}-${xTiles}-${yTiles}`,
    kind,
    hat: kind === 'cube' ? normalizeHat(box.hat) : undefined,
    xTiles,
    yTiles,
    widthTiles: positiveNumber(box.widthTiles, 1),
    depthTiles: positiveNumber(box.depthTiles, 1),
    heightPx: positiveNumber(box.heightPx, HOME_BACKGROUND_TILE),
    opacity: Math.max(0, Math.min(1, finiteNumber(box.opacity, 1))),
  }
}

function expandBoxStream(raw: unknown, index: number): HomeBackgroundBox[] {
  if (!raw || typeof raw !== 'object') return []
  const stream = raw as HomeBackgroundBoxStream
  const xTiles = finiteNumber(stream.xTiles, NaN)
  const startYTiles = finiteNumber(stream.startYTiles, NaN)
  const count = Math.max(0, Math.floor(finiteNumber(stream.count, 0)))
  if (!Number.isFinite(xTiles) || !Number.isFinite(startYTiles) || count < 1) {
    return []
  }

  const id = typeof stream.id === 'string' && stream.id.trim()
    ? stream.id.trim()
    : `stream-${index}`
  const stepYTiles = finiteNumber(stream.stepYTiles, -1)
  const kind = normalizeKind(stream.kind)
  const widthTiles = positiveNumber(stream.widthTiles, 1)
  const depthTiles = positiveNumber(stream.depthTiles, 1)
  const heightPx = positiveNumber(stream.heightPx, HOME_BACKGROUND_TILE)
  const opacity = Math.max(0, Math.min(1, finiteNumber(stream.opacity, 1)))
  const hat = kind === 'cube' ? normalizeHat(stream.hat) : undefined

  return Array.from({ length: count }, (_, i) => ({
    id: `${id}-${startYTiles + i * stepYTiles}`,
    kind,
    hat: hat ? { ...hat } : undefined,
    xTiles,
    yTiles: startYTiles + i * stepYTiles,
    widthTiles,
    depthTiles,
    heightPx,
    opacity,
  }))
}

export function normalizeHomeBackgroundScene(raw: unknown): HomeBackgroundScene {
  if (!raw || typeof raw !== 'object') return FALLBACK_HOME_BACKGROUND_SCENE
  const scene = raw as Partial<HomeBackgroundScene>
  const rawStreams = (scene as { boxStreams?: unknown }).boxStreams
  const rawBoxes = scene.boxes
  const hasBoxList = Array.isArray(rawBoxes)
  const hasStreamList = Array.isArray(rawStreams)
  const streamBoxes = hasStreamList
    ? rawStreams.flatMap(expandBoxStream)
    : []
  const boxes = hasBoxList
    ? rawBoxes
        .map((box, index) => normalizeBox(box, index))
        .filter((box): box is HomeBackgroundBox => box !== null)
    : []
  const allBoxes = [...streamBoxes, ...boxes]
  const hasExplicitObjectList = hasBoxList || hasStreamList

  return {
    schemaVersion: 1,
    tileSize: positiveNumber(scene.tileSize, HOME_BACKGROUND_TILE),
    horizonGapPx: positiveNumber(
      scene.horizonGapPx,
      HOME_BACKGROUND_HORIZON_GAP_PX,
    ),
    groundScrollFactor: positiveNumber(
      scene.groundScrollFactor,
      HOME_BACKGROUND_SCROLL_FACTOR,
    ),
    halfCylinderShellArcAngleDeg: boundedNumber(
      scene.halfCylinderShellArcAngleDeg,
      HOME_BACKGROUND_HALF_CYLINDER_SHELL_ARC_ANGLE_DEG,
      0,
      90,
    ),
    boxes: hasExplicitObjectList ? allBoxes : FALLBACK_HOME_BACKGROUND_SCENE.boxes,
  }
}

export async function loadHomeBackgroundScene(signal?: AbortSignal) {
  const response = await fetch(`${import.meta.env.BASE_URL}data/home-background.json`, {
    cache: 'no-cache',
    signal,
  })
  if (!response.ok) {
    throw new Error(`Failed to load home background: ${response.status}`)
  }
  return normalizeHomeBackgroundScene(await response.json())
}
