export type HomeBackgroundShape =
  | 'cube'
  | 'pyramid'
  | 'tent'
  | 'halfCylinder'
  | 'slope'
export type HomeBackgroundFacing = 'left' | 'right' | 'front' | 'back'
export type HomeBackgroundHatKind = Exclude<HomeBackgroundShape, 'cube'>

export type HomeBackgroundHat = {
  kind: HomeBackgroundHatKind
  heightPx: number
  facing?: HomeBackgroundFacing
}

export type HomeBackgroundBox = {
  id: string
  kind: HomeBackgroundShape
  hat?: HomeBackgroundHat
  xTiles: number
  yTiles: number
  widthTiles: number
  depthTiles: number
  heightPx: number
  opacity: number
  facing?: HomeBackgroundFacing
}

export type HomeBackgroundScene = {
  schemaVersion: 1
  tileSize: number
  horizonGapPx: number
  groundScrollFactor: number
  halfCylinderShellArcAngleDeg: number
  boxes: HomeBackgroundBox[]
}

type RawStream = {
  id?: string
  xTiles?: number
  startYTiles?: number
  stepYTiles?: number
  count?: number
  widthTiles?: number
  depthTiles?: number
  heightPx?: number
  opacity?: number
  kind?: HomeBackgroundShape | 'box'
  facing?: HomeBackgroundFacing
  hat?: Partial<HomeBackgroundHat>
}

export type Cell = {
  x: number
  y: number
}

export type Brush = {
  heightPx: number
  widthTiles: number
  depthTiles: number
  kind: HomeBackgroundShape
  facing: HomeBackgroundFacing
}

export const DEFAULT_TILE_SIZE = 64
export const DEFAULT_HORIZON_GAP_PX = 48
export const DEFAULT_GROUND_SCROLL_FACTOR = 0.2
export const DEFAULT_HALF_CYLINDER_SHELL_ARC_ANGLE_DEG = 45

const DEFAULT_INPUT = {
  schemaVersion: 1,
  tileSize: DEFAULT_TILE_SIZE,
  horizonGapPx: DEFAULT_HORIZON_GAP_PX,
  groundScrollFactor: DEFAULT_GROUND_SCROLL_FACTOR,
  halfCylinderShellArcAngleDeg: DEFAULT_HALF_CYLINDER_SHELL_ARC_ANGLE_DEG,
  boxStreams: [
    {
      id: 'cube-left',
      xTiles: -7,
      startYTiles: -1,
      stepYTiles: -1,
      count: 48,
      widthTiles: 1,
      depthTiles: 1,
      heightPx: 64,
      opacity: 0.62,
      kind: 'cube',
    },
    {
      id: 'cube-right',
      xTiles: 6,
      startYTiles: -1,
      stepYTiles: -1,
      count: 48,
      widthTiles: 1,
      depthTiles: 1,
      heightPx: 64,
      opacity: 0.62,
      kind: 'cube',
    },
  ],
  boxes: [],
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveNumber(value: unknown, fallback: number) {
  const n = numberOr(value, fallback)
  return n > 0 ? n : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  return clamp(numberOr(value, fallback), min, max)
}

function normalizeShape(value: unknown): HomeBackgroundShape {
  if (value === 'slope') return value
  if (value === 'halfCylinder') return value
  if (value === 'pyramid' || value === 'tent') return value
  return 'cube'
}

function defaultSlopeFacing(xTiles: number): HomeBackgroundFacing {
  return xTiles <= 0 ? 'left' : 'right'
}

function normalizeFacing(
  value: unknown,
  fallback: HomeBackgroundFacing,
): HomeBackgroundFacing {
  return value === 'left' ||
    value === 'right' ||
    value === 'front' ||
    value === 'back'
    ? value
    : fallback
}

export function flipFacing(facing: HomeBackgroundFacing | undefined) {
  if (facing === 'left') return 'right'
  if (facing === 'right') return 'left'
  return facing ?? 'right'
}

function normalizeHatKind(value: unknown): HomeBackgroundHatKind | null {
  if (
    value === 'pyramid' ||
    value === 'tent' ||
    value === 'halfCylinder' ||
    value === 'slope'
  ) {
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
    heightPx: positiveNumber(raw.heightPx, DEFAULT_TILE_SIZE * 0.75),
    facing: kind === 'slope' ? normalizeFacing(raw.facing, 'right') : undefined,
  }
}

function serializedHeightPx(
  kind: HomeBackgroundShape,
  widthTiles: number,
  heightPx: number,
  tileSize: number,
) {
  return kind === 'halfCylinder'
    ? Math.max(1, Math.round((widthTiles * tileSize) / 2))
    : heightPx
}

function normalizeBox(raw: unknown, index: number): HomeBackgroundBox | null {
  if (!raw || typeof raw !== 'object') return null
  const box = raw as Partial<HomeBackgroundBox>
  const xTiles = numberOr(box.xTiles, NaN)
  const yTiles = numberOr(box.yTiles, NaN)
  if (!Number.isFinite(xTiles) || !Number.isFinite(yTiles)) return null
  const kind = normalizeShape(box.kind)

  return {
    id:
      typeof box.id === 'string' && box.id.trim()
        ? box.id.trim()
        : `box-${index}-${xTiles}-${yTiles}`,
    xTiles,
    yTiles,
    kind,
    hat: kind === 'cube' ? normalizeHat(box.hat) : undefined,
    widthTiles: positiveNumber(box.widthTiles, 1),
    depthTiles: positiveNumber(box.depthTiles, 1),
    heightPx: positiveNumber(box.heightPx, DEFAULT_TILE_SIZE),
    opacity: clamp(numberOr(box.opacity, 0.72), 0, 1),
    facing:
      kind === 'slope'
        ? normalizeFacing(box.facing, defaultSlopeFacing(xTiles))
        : undefined,
  }
}

function expandStream(raw: unknown, index: number): HomeBackgroundBox[] {
  if (!raw || typeof raw !== 'object') return []
  const stream = raw as RawStream
  const xTiles = numberOr(stream.xTiles, NaN)
  const startYTiles = numberOr(stream.startYTiles, NaN)
  const count = Math.max(0, Math.floor(numberOr(stream.count, 0)))
  if (!Number.isFinite(xTiles) || !Number.isFinite(startYTiles) || count < 1) {
    return []
  }

  const id = typeof stream.id === 'string' && stream.id.trim()
    ? stream.id.trim()
    : `stream-${index}`
  const stepYTiles = numberOr(stream.stepYTiles, -1)
  const widthTiles = positiveNumber(stream.widthTiles, 1)
  const depthTiles = positiveNumber(stream.depthTiles, 1)
  const heightPx = positiveNumber(stream.heightPx, DEFAULT_TILE_SIZE)
  const opacity = clamp(numberOr(stream.opacity, 0.72), 0, 1)
  const kind = normalizeShape(stream.kind)
  const hat = kind === 'cube' ? normalizeHat(stream.hat) : undefined

  return Array.from({ length: count }, (_, i) => {
    const yTiles = startYTiles + i * stepYTiles
    return {
      id: `${id}-${yTiles}`,
      xTiles,
      yTiles,
      kind,
      hat: hat ? { ...hat } : undefined,
      widthTiles,
      depthTiles,
      heightPx,
      opacity,
      facing:
        kind === 'slope'
          ? normalizeFacing(stream.facing, defaultSlopeFacing(xTiles))
          : undefined,
    }
  })
}

export function normalizeScene(raw: unknown): HomeBackgroundScene {
  const source = raw && typeof raw === 'object' ? raw : DEFAULT_INPUT
  const scene = source as Partial<HomeBackgroundScene> & {
    boxStreams?: unknown[]
  }
  const rawBoxes = scene.boxes
  const rawStreams = scene.boxStreams
  const hasBoxList = Array.isArray(rawBoxes)
  const hasStreamList = Array.isArray(rawStreams)
  const streamBoxes = hasStreamList
    ? rawStreams.flatMap(expandStream)
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
    tileSize: positiveNumber(scene.tileSize, DEFAULT_TILE_SIZE),
    horizonGapPx: positiveNumber(scene.horizonGapPx, DEFAULT_HORIZON_GAP_PX),
    groundScrollFactor: positiveNumber(
      scene.groundScrollFactor,
      DEFAULT_GROUND_SCROLL_FACTOR,
    ),
    halfCylinderShellArcAngleDeg: boundedNumber(
      scene.halfCylinderShellArcAngleDeg,
      DEFAULT_HALF_CYLINDER_SHELL_ARC_ANGLE_DEG,
      0,
      90,
    ),
    boxes: hasExplicitObjectList ? allBoxes : normalizeScene(DEFAULT_INPUT).boxes,
  }
}

export function createDefaultScene() {
  return normalizeScene(DEFAULT_INPUT)
}

export function serializeScene(scene: HomeBackgroundScene): HomeBackgroundScene {
  return {
    schemaVersion: 1,
    tileSize: scene.tileSize,
    horizonGapPx: scene.horizonGapPx,
    groundScrollFactor: scene.groundScrollFactor,
    halfCylinderShellArcAngleDeg: scene.halfCylinderShellArcAngleDeg,
    boxes: [...scene.boxes]
      .sort((a, b) => a.yTiles - b.yTiles || a.xTiles - b.xTiles)
      .map((box) => ({
        id: box.id,
        kind: box.kind,
        ...(box.kind === 'cube' && box.hat
          ? {
              hat: {
                kind: box.hat.kind,
                ...(box.hat.kind === 'slope'
                  ? {
                      facing: normalizeFacing(box.hat.facing, 'right'),
                    }
                  : {}),
                heightPx: serializedHeightPx(
                  box.hat.kind,
                  box.widthTiles,
                  box.hat.heightPx,
                  scene.tileSize,
                ),
              },
            }
          : {}),
        xTiles: box.xTiles,
        yTiles: box.yTiles,
        ...(box.kind === 'slope'
          ? {
              facing: normalizeFacing(
                box.facing,
                defaultSlopeFacing(box.xTiles),
              ),
            }
          : {}),
        widthTiles: box.widthTiles,
        depthTiles: box.depthTiles,
        heightPx: serializedHeightPx(
          box.kind,
          box.widthTiles,
          box.heightPx,
          scene.tileSize,
        ),
        opacity: box.opacity,
      })),
  }
}

export function jsonForScene(scene: HomeBackgroundScene) {
  return `${JSON.stringify(serializeScene(scene), null, 2)}\n`
}

export function cellKey(cell: Cell) {
  return `${cell.x},${cell.y}`
}

export function parseCellKey(key: string): Cell {
  const [x, y] = key.split(',').map(Number)
  return { x, y }
}

export function boxAnchorKey(box: Pick<HomeBackgroundBox, 'xTiles' | 'yTiles'>) {
  return `${box.xTiles},${box.yTiles}`
}

export function cellBounds(cells: Cell[]) {
  if (cells.length === 0) return null
  const minX = Math.min(...cells.map((cell) => cell.x))
  const maxX = Math.max(...cells.map((cell) => cell.x))
  const minY = Math.min(...cells.map((cell) => cell.y))
  const maxY = Math.max(...cells.map((cell) => cell.y))
  return {
    minX,
    maxX,
    minY,
    maxY,
    widthTiles: maxX - minX + 1,
    depthTiles: maxY - minY + 1,
  }
}

export function boxIntersectsCells(box: HomeBackgroundBox, cells: Cell[]) {
  const boxMaxX = box.xTiles + box.widthTiles - 1
  const boxMaxY = box.yTiles + box.depthTiles - 1
  return cells.some(
    (cell) =>
      cell.x >= box.xTiles &&
      cell.x <= boxMaxX &&
      cell.y >= box.yTiles &&
      cell.y <= boxMaxY,
  )
}

export function boxCells(box: HomeBackgroundBox): Cell[] {
  const cells: Cell[] = []
  for (let y = box.yTiles; y < box.yTiles + box.depthTiles; y += 1) {
    for (let x = box.xTiles; x < box.xTiles + box.widthTiles; x += 1) {
      cells.push({ x, y })
    }
  }
  return cells
}

export function makeBoxForArea(
  cells: Cell[],
  brush: Brush,
  existing?: HomeBackgroundBox,
): HomeBackgroundBox {
  const bounds = cellBounds(cells)
  const anchor = bounds ?? { minX: 0, minY: 0, widthTiles: 1, depthTiles: 1 }
  return {
    id:
      existing?.id ??
      `box-${anchor.minX}-${anchor.minY}-${Date.now().toString(36)}`,
    xTiles: anchor.minX,
    yTiles: anchor.minY,
    kind: brush.kind,
    hat: brush.kind === 'cube' && existing?.kind === 'cube' ? existing.hat : undefined,
    facing: brush.kind === 'slope' ? brush.facing : undefined,
    widthTiles: Math.max(1, anchor.widthTiles),
    depthTiles: Math.max(1, anchor.depthTiles),
    heightPx: Math.max(1, brush.heightPx),
    opacity: existing?.opacity ?? 1,
  }
}

export function uniqueCells(cells: Cell[]): Cell[] {
  const seen = new Set<string>()
  const unique: Cell[] = []
  for (const cell of cells) {
    const key = cellKey(cell)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(cell)
  }
  return unique
}

export function cellsInLine(start: Cell, end: Cell): Cell[] {
  const cells: Cell[] = []
  let x = start.x
  let y = start.y
  const dx = Math.abs(end.x - start.x)
  const dy = Math.abs(end.y - start.y)
  const sx = start.x < end.x ? 1 : -1
  const sy = start.y < end.y ? 1 : -1
  let error = dx - dy

  while (true) {
    cells.push({ x, y })
    if (x === end.x && y === end.y) break
    const doubledError = error * 2
    if (doubledError > -dy) {
      error -= dy
      x += sx
    }
    if (doubledError < dx) {
      error += dx
      y += sy
    }
  }

  return cells
}

export function brushCellsForCell(cell: Cell, brush: Pick<Brush, 'widthTiles' | 'depthTiles'>): Cell[] {
  const width = Math.max(1, Math.floor(brush.widthTiles))
  const depth = Math.max(1, Math.floor(brush.depthTiles))
  const offsetX = -Math.floor((width - 1) / 2)
  const offsetY = -Math.floor((depth - 1) / 2)
  const cells: Cell[] = []

  for (let y = 0; y < depth; y += 1) {
    for (let x = 0; x < width; x += 1) {
      cells.push({
        x: cell.x + offsetX + x,
        y: cell.y + offsetY + y,
      })
    }
  }

  return cells
}

export function brushStrokeCells(path: Cell[], brush: Pick<Brush, 'widthTiles' | 'depthTiles'>): Cell[] {
  return uniqueCells(path.flatMap((cell) => brushCellsForCell(cell, brush)))
}

export function cellsInRect(start: Cell, end: Cell): Cell[] {
  const minX = Math.min(start.x, end.x)
  const maxX = Math.max(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const maxY = Math.max(start.y, end.y)
  const cells: Cell[] = []
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      cells.push({ x, y })
    }
  }
  return cells
}
