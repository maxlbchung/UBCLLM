import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Brush,
  ClipboardPaste,
  Copy,
  Download,
  Eraser,
  FileJson,
  FlipHorizontal2,
  FolderOpen,
  Minimize2,
  MousePointer2,
  Paintbrush,
  Redo2,
  RotateCcw,
  Save,
  StretchHorizontal,
  StretchVertical,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react'
import { EditorViewport, type EditorMode } from './EditorViewport'
import {
  boxAnchorKey,
  boxCells,
  boxIntersectsCells,
  cellBounds,
  cellKey,
  createDefaultScene,
  flipFacing,
  jsonForScene,
  makeBoxForArea,
  normalizeScene,
  parseCellKey,
  serializeScene,
  uniqueCells,
  type Brush as BrushState,
  type Cell,
  type HomeBackgroundBox,
  type HomeBackgroundFacing,
  type HomeBackgroundHatKind,
  type HomeBackgroundScene,
  type HomeBackgroundShape,
} from './scene'

type PopupAnchor = {
  x: number
  y: number
}

type HistoryState = {
  past: HomeBackgroundScene[]
  future: HomeBackgroundScene[]
}

type HeightEditState = {
  scene: HomeBackgroundScene
  selectedIds: string[]
  referenceHeightPx: number
}

type HatEditState = HeightEditState

type CopyBuffer = {
  boxes: HomeBackgroundBox[]
  origin: Cell
  widthTiles: number
}

type RightPanelTab = 'selection' | 'scene'
type HatOptionValue = 'none' | HomeBackgroundHatKind

const API_PATH = '/api/home-background'
const MAX_HEIGHT_PX = 720
const SHAPE_OPTIONS: { value: HomeBackgroundShape; label: string }[] = [
  { value: 'cube', label: 'Cube' },
  { value: 'pyramid', label: 'Pyramid' },
  { value: 'tent', label: 'Tent' },
  { value: 'halfCylinder', label: 'Semi-cylinder' },
  { value: 'slope', label: 'Slope' },
]
const HAT_OPTIONS: { value: HatOptionValue; label: string }[] = [
  { value: 'none', label: 'No hat' },
  { value: 'pyramid', label: 'Pyramid' },
  { value: 'tent', label: 'Tent' },
  { value: 'halfCylinder', label: 'Semi-cylinder' },
  { value: 'slope', label: 'Slope' },
]
const SHAPE_LABELS: Record<HomeBackgroundShape, string> = {
  cube: 'Cube',
  pyramid: 'Pyramid',
  tent: 'Tent',
  halfCylinder: 'Semi-cylinder',
  slope: 'Slope',
}
const FACING_OPTIONS: { value: HomeBackgroundFacing; label: string }[] = [
  { value: 'right', label: 'Right' },
  { value: 'left', label: 'Left' },
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
]
const MODE_LABELS: Record<EditorMode, string> = {
  select: 'Select',
  area: 'Area',
  paint: 'Paint',
  erase: 'Erase',
}

function cloneScene(scene: HomeBackgroundScene): HomeBackgroundScene {
  return normalizeScene(serializeScene(scene))
}

function cloneBox(box: HomeBackgroundBox): HomeBackgroundBox {
  return {
    ...box,
    hat: box.hat ? { ...box.hat } : undefined,
    facing: box.facing,
  }
}

function boxBounds(boxes: HomeBackgroundBox[]) {
  if (boxes.length === 0) return null
  const cells = boxes.flatMap(boxCells)
  return cellBounds(cells)
}

function sceneBounds(boxes: HomeBackgroundBox[]) {
  if (boxes.length === 0) return 'empty'
  const minX = Math.min(...boxes.map((box) => box.xTiles))
  const maxX = Math.max(...boxes.map((box) => box.xTiles + box.widthTiles - 1))
  const minY = Math.min(...boxes.map((box) => box.yTiles))
  const maxY = Math.max(...boxes.map((box) => box.yTiles + box.depthTiles - 1))
  return `x ${minX}..${maxX}, y ${minY}..${maxY}`
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json;charset=utf-8' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function NumberField({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
}: {
  label: string
  min?: number
  max?: number
  step?: number
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isInteger(value) ? value : Number(value.toFixed(3))}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
    </label>
  )
}

function ShapeField({
  value,
  onChange,
}: {
  value: HomeBackgroundShape
  onChange: (value: HomeBackgroundShape) => void
}) {
  return (
    <label className="field">
      <span>Shape</span>
      <select
        value={value}
        title="Brush shape (Shift+1, Shift+2, Shift+3, Shift+4, Shift+5)"
        onChange={(event) => onChange(event.target.value as HomeBackgroundShape)}
      >
        {SHAPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function FacingField({
  label = 'Slope faces',
  value,
  onChange,
}: {
  label?: string
  value: HomeBackgroundFacing
  onChange: (value: HomeBackgroundFacing) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value}
        title="Direction for slope blocks"
        onChange={(event) => onChange(event.target.value as HomeBackgroundFacing)}
      >
        {FACING_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function RangeField({
  label,
  min,
  max,
  step,
  value,
  onChange,
  onCommit,
  suffix,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  onCommit?: (value: number) => void
  suffix?: string
}) {
  const commitValue = (input: HTMLInputElement) => {
    const next = Number(input.value)
    if (Number.isFinite(next)) onCommit?.(next)
  }

  return (
    <label className="range-field">
      <span>
        {label}
        <strong>
          {Number.isInteger(value) ? value : value.toFixed(2)}
          {suffix}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={(event) => commitValue(event.currentTarget)}
        onMouseUp={(event) => commitValue(event.currentTarget)}
        onTouchEnd={(event) => commitValue(event.currentTarget)}
        onKeyUp={(event) => commitValue(event.currentTarget)}
        onBlur={(event) => commitValue(event.currentTarget)}
      />
    </label>
  )
}

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [scene, setScene] = useState<HomeBackgroundScene>(() => createDefaultScene())
  const sceneRef = useRef(scene)
  const initialLoadRequestRef = useRef(0)
  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] })
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const selectedKeysRef = useRef(selectedKeys)
  const [hoverCell, setHoverCell] = useState<Cell | null>(null)
  const hoverCellRef = useRef<Cell | null>(null)
  const [copyBuffer, setCopyBuffer] = useState<CopyBuffer | null>(null)
  const copyBufferRef = useRef<CopyBuffer | null>(null)
  const pasteCountRef = useRef(0)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('selection')
  const [mode, setMode] = useState<EditorMode>('select')
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [brush, setBrush] = useState<BrushState>({
    heightPx: 64,
    widthTiles: 1,
    depthTiles: 1,
    kind: 'cube',
    facing: 'left',
  })
  const heightStepPx = scene.tileSize / 8
  const brushRef = useRef(brush)
  const heightEditStartRef = useRef<HeightEditState | null>(null)
  const hatEditStartRef = useRef<HatEditState | null>(null)

  useEffect(() => {
    sceneRef.current = scene
  }, [scene])

  useEffect(() => {
    selectedKeysRef.current = selectedKeys
  }, [selectedKeys])

  useEffect(() => {
    hoverCellRef.current = hoverCell
  }, [hoverCell])

  useEffect(() => {
    brushRef.current = brush
  }, [brush])

  const clampHeightPx = (heightPx: number, minHeightPx = heightStepPx) =>
    Math.min(MAX_HEIGHT_PX, Math.max(minHeightPx, Math.round(heightPx)))

  const updateBrush = (patch: Partial<BrushState>) => {
    setBrush((current) => {
      const next = { ...current, ...patch }
      if (patch.heightPx != null) next.heightPx = clampHeightPx(patch.heightPx)
      brushRef.current = next
      return next
    })
  }

  const selectedCells = useMemo(
    () => Array.from(selectedKeys).map(parseCellKey),
    [selectedKeys],
  )
  const selectedBoxes = useMemo(
    () => scene.boxes.filter((box) => boxIntersectsCells(box, selectedCells)),
    [scene.boxes, selectedCells],
  )
  const selectedCubeBoxes = useMemo(
    () => selectedBoxes.filter((box) => box.kind === 'cube'),
    [selectedBoxes],
  )
  const selectedSlopeBoxes = useMemo(
    () => selectedBoxes.filter((box) => box.kind === 'slope'),
    [selectedBoxes],
  )
  const selectedHat = useMemo(
    () => selectedCubeBoxes.find((box) => box.hat)?.hat,
    [selectedCubeBoxes],
  )
  const selectedHatKind = selectedHat?.kind ?? 'none'
  const selectedHatValue: HatOptionValue = selectedHatKind
  const selectedHatFacing = selectedHat?.facing ?? brush.facing
  const selectedHatHeightPx =
    selectedHat?.heightPx == null
      ? Math.round(scene.tileSize * 0.75)
      : Math.min(MAX_HEIGHT_PX, selectedHat.heightPx)
  const bounds = useMemo(() => sceneBounds(scene.boxes), [scene.boxes])

  const commitScene = (nextScene: HomeBackgroundScene, label: string) => {
    const previous = cloneScene(sceneRef.current)
    const cloned = cloneScene(nextScene)
    setHistory((current) => ({
      past: [...current.past.slice(-80), previous],
      future: [],
    }))
    sceneRef.current = cloned
    setScene(cloned)
    setDirty(true)
    setStatus(label)
  }

  const replaceScene = (nextScene: HomeBackgroundScene, label: string) => {
    const cloned = cloneScene(nextScene)
    sceneRef.current = cloned
    setScene(cloned)
    setHistory({ past: [], future: [] })
    selectedKeysRef.current = new Set()
    setSelectedKeys(new Set())
    setDirty(false)
    setStatus(label)
  }

  const updateSceneSettings = (patch: Partial<HomeBackgroundScene>) => {
    commitScene({ ...scene, ...patch }, 'Scene settings changed')
  }

  const setEditorMode = (nextMode: EditorMode) => {
    setMode(nextMode)
    setStatus(`${MODE_LABELS[nextMode]} tool selected`)
  }

  const setBrushShape = (kind: HomeBackgroundShape) => {
    updateBrush({ kind })
    setStatus(`${SHAPE_LABELS[kind]} brush selected`)
  }

  const applyAreaCells = (cells: Cell[], _anchor?: PopupAnchor) => {
    if (cells.length === 0) return
    const sourceScene = sceneRef.current
    const currentBrush = brushRef.current
    const overlapping = sourceScene.boxes.filter((box) => boxIntersectsCells(box, cells))
    const remaining = sourceScene.boxes.filter((box) => !boxIntersectsCells(box, cells))
    const nextBox = makeBoxForArea(cells, currentBrush, overlapping[0])
    commitScene({ ...sourceScene, boxes: [...remaining, nextBox] }, 'Area applied')
    const nextKeys = new Set(boxCells(nextBox).map(cellKey))
    selectedKeysRef.current = nextKeys
    setSelectedKeys(nextKeys)
    setRightPanelTab('selection')
  }

  const paintStrokeCells = (cells: Cell[], _anchor?: PopupAnchor) => {
    const paintedCells = uniqueCells(cells)
    if (paintedCells.length === 0) return

    const sourceScene = sceneRef.current
    const currentBrush = brushRef.current
    const overlapping = sourceScene.boxes.filter((box) =>
      boxIntersectsCells(box, paintedCells),
    )
    const existingByAnchor = new Map(overlapping.map((box) => [boxAnchorKey(box), box]))
    const remaining = sourceScene.boxes.filter(
      (box) => !boxIntersectsCells(box, paintedCells),
    )
    const stamp = Date.now().toString(36)
    const nextBoxes: HomeBackgroundBox[] = paintedCells.map((cell, index) => {
      const existing = existingByAnchor.get(cellKey(cell))
      return {
        id: existing?.id ?? `paint-${cell.x}-${cell.y}-${stamp}-${index}`,
        kind: currentBrush.kind,
        hat:
          currentBrush.kind === 'cube' && existing?.kind === 'cube'
            ? existing.hat
            : undefined,
        facing: currentBrush.kind === 'slope' ? currentBrush.facing : undefined,
        xTiles: cell.x,
        yTiles: cell.y,
        widthTiles: 1,
        depthTiles: 1,
        heightPx: Math.max(1, currentBrush.heightPx),
        opacity: existing?.opacity ?? 1,
      }
    })

    commitScene({ ...sourceScene, boxes: [...remaining, ...nextBoxes] }, 'Painted stroke')
    selectBoxesFootprint(nextBoxes)
    setRightPanelTab('selection')
  }

  const eraseCells = (cells: Cell[]) => {
    if (cells.length === 0) return
    commitScene(
      {
        ...scene,
        boxes: scene.boxes.filter((box) => !boxIntersectsCells(box, cells)),
      },
      'Erased cells',
    )
    selectedKeysRef.current = new Set()
    setSelectedKeys(new Set())
  }

  const selectCells = (cells: Cell[], _anchor: PopupAnchor, additive = false) => {
    const sourceScene = sceneRef.current
    const boxes = sourceScene.boxes.filter((box) => boxIntersectsCells(box, cells))
    if (boxes.length === 0) {
      if (additive && selectedKeysRef.current.size > 0) {
        setStatus('No additional block selected')
        return
      }
      selectedKeysRef.current = new Set()
      setSelectedKeys(new Set())
      setStatus('No block selected')
      return
    }

    const nextKeys = additive
      ? new Set(selectedKeysRef.current)
      : new Set<string>()
    const previouslySelectedBoxes = new Set(
      sourceScene.boxes
        .filter((box) =>
          boxIntersectsCells(box, Array.from(selectedKeysRef.current).map(parseCellKey)),
        )
        .map((box) => box.id),
    )
    for (const box of boxes) {
      for (const cell of boxCells(box)) {
        nextKeys.add(cellKey(cell))
      }
    }
    const firstBox = boxes[0]
    const nextBrush = {
      ...brushRef.current,
      heightPx: clampHeightPx(firstBox.heightPx),
      widthTiles: firstBox.widthTiles,
      depthTiles: firstBox.depthTiles,
      kind: firstBox.kind,
      facing: firstBox.facing ?? brushRef.current.facing,
    }
    brushRef.current = nextBrush
    setBrush(nextBrush)
    selectedKeysRef.current = nextKeys
    setSelectedKeys(nextKeys)
    setRightPanelTab('selection')
    if (additive) {
      const addedCount = boxes.filter((box) => !previouslySelectedBoxes.has(box.id)).length
      setStatus(
        addedCount > 0
          ? `Added ${addedCount} ${addedCount === 1 ? 'block' : 'blocks'} to selection`
          : 'Selection unchanged',
      )
    } else {
      setStatus(`Selected ${boxes.length} ${boxes.length === 1 ? 'block' : 'blocks'}`)
    }
  }

  const selectedBoxesForCells = (
    sourceScene: HomeBackgroundScene,
    cells: Cell[],
  ) => sourceScene.boxes.filter((box) => boxIntersectsCells(box, cells))

  const buildExistingBoxUpdate = (
    sourceScene: HomeBackgroundScene,
    cells: Cell[],
    patch: Partial<BrushState>,
    selectedIds?: string[],
    referenceHeightPx?: number,
  ) => {
    const selected = selectedIds
      ? sourceScene.boxes.filter((box) => selectedIds.includes(box.id))
      : selectedBoxesForCells(sourceScene, cells)
    if (selected.length === 0) return null

    const selectedIdSet = new Set(selected.map((box) => box.id))
    const referenceHeight = referenceHeightPx ?? selected[0].heightPx
    const heightDelta = patch.heightPx == null ? 0 : patch.heightPx - referenceHeight
    const boxes = sourceScene.boxes.map((box) => {
      if (!selectedIdSet.has(box.id)) return box
      const kind = patch.kind ?? box.kind
      const facing =
        kind === 'slope'
          ? patch.facing ?? box.facing ?? brushRef.current.facing
          : undefined
      return {
        ...box,
        kind,
        hat: kind === 'cube' && box.kind === 'cube' ? box.hat : undefined,
        facing,
        widthTiles: patch.widthTiles ?? box.widthTiles,
        depthTiles: patch.depthTiles ?? box.depthTiles,
        heightPx:
          patch.heightPx == null
            ? box.heightPx
            : Math.min(MAX_HEIGHT_PX, Math.max(1, Math.round(box.heightPx + heightDelta))),
      }
    })
    const updatedSelected = boxes.filter((box) => selectedIdSet.has(box.id))
    return {
      scene: { ...sourceScene, boxes },
      selectedBoxes: updatedSelected,
    }
  }

  const buildHatHeightUpdate = (
    sourceScene: HomeBackgroundScene,
    cells: Cell[],
    heightPx: number,
    selectedIds?: string[],
    referenceHeightPx?: number,
  ) => {
    const selected = selectedIds
      ? sourceScene.boxes.filter((box) => selectedIds.includes(box.id))
      : selectedBoxesForCells(sourceScene, cells)
    const selectedWithHats = selected.filter((box) => box.kind === 'cube' && box.hat)
    if (selectedWithHats.length === 0) return null

    const selectedIdSet = new Set(selectedWithHats.map((box) => box.id))
    const referenceHeight = referenceHeightPx ?? selectedWithHats[0].hat!.heightPx
    const heightDelta = heightPx - referenceHeight
    const boxes = sourceScene.boxes.map((box) => {
      if (!selectedIdSet.has(box.id) || box.kind !== 'cube' || !box.hat) return box
      return {
        ...box,
        hat: {
          ...box.hat,
          heightPx: Math.min(
            MAX_HEIGHT_PX,
            Math.max(1, Math.round(box.hat.heightPx + heightDelta)),
          ),
        },
      }
    })
    const updatedSelected = boxes.filter((box) => selectedIdSet.has(box.id))
    return {
      scene: { ...sourceScene, boxes },
      selectedBoxes: updatedSelected,
    }
  }

  const selectBoxesFootprint = (boxes: HomeBackgroundBox[]) => {
    const nextKeys = new Set<string>()
    for (const box of boxes) {
      for (const cell of boxCells(box)) {
        nextKeys.add(cellKey(cell))
      }
    }
    selectedKeysRef.current = nextKeys
    setSelectedKeys(nextKeys)
  }

  const clearSelection = () => {
    if (selectedKeysRef.current.size === 0) {
      setEditorMode('select')
      return
    }
    selectedKeysRef.current = new Set()
    setSelectedKeys(new Set())
    setStatus('Selection cleared')
  }

  const selectAllBlocks = () => {
    const boxes = sceneRef.current.boxes
    if (boxes.length === 0) {
      setStatus('No blocks to select')
      return
    }
    selectBoxesFootprint(boxes)
    setRightPanelTab('selection')
    setStatus(`Selected all ${boxes.length} blocks`)
  }

  const deleteSelected = () => {
    const cells = Array.from(selectedKeysRef.current).map(parseCellKey)
    const selected = selectedBoxesForCells(sceneRef.current, cells)
    if (selected.length === 0) {
      setStatus('Select blocks before deleting')
      return
    }

    const selectedIds = new Set(selected.map((box) => box.id))
    commitScene(
      {
        ...sceneRef.current,
        boxes: sceneRef.current.boxes.filter((box) => !selectedIds.has(box.id)),
      },
      `Deleted ${selected.length} ${selected.length === 1 ? 'block' : 'blocks'}`,
    )
    selectedKeysRef.current = new Set()
    setSelectedKeys(new Set())
    setRightPanelTab('selection')
  }

  const copySelection = () => {
    const cells = Array.from(selectedKeysRef.current).map(parseCellKey)
    const selected = selectedBoxesForCells(sceneRef.current, cells)
    const bounds = boxBounds(selected)
    if (selected.length === 0 || !bounds) {
      setStatus('Select blocks before copying')
      return
    }

    const buffer = {
      boxes: selected.map(cloneBox),
      origin: { x: bounds.minX, y: bounds.minY },
      widthTiles: bounds.widthTiles,
    }
    copyBufferRef.current = buffer
    pasteCountRef.current = 0
    setCopyBuffer(buffer)
    setStatus(`Copied ${selected.length} ${selected.length === 1 ? 'block' : 'blocks'}`)
  }

  const pasteSelection = () => {
    const buffer = copyBufferRef.current
    if (!buffer || buffer.boxes.length === 0) {
      setStatus('Copy blocks before pasting')
      return
    }

    const nextPasteCount = pasteCountRef.current + 1
    const hoverTarget = hoverCellRef.current
    const hoverInsideSelection =
      hoverTarget && selectedKeysRef.current.has(cellKey(hoverTarget))
    const targetOrigin = hoverTarget && !hoverInsideSelection ? hoverTarget : {
      x: buffer.origin.x + nextPasteCount * (buffer.widthTiles + 1),
      y: buffer.origin.y,
    }
    const dx = targetOrigin.x - buffer.origin.x
    const dy = targetOrigin.y - buffer.origin.y
    const stamp = `${Date.now().toString(36)}-${nextPasteCount}`
    const pasted = buffer.boxes.map((box, index) => ({
      ...cloneBox(box),
      id: `${box.id}-copy-${stamp}-${index}`,
      xTiles: box.xTiles + dx,
      yTiles: box.yTiles + dy,
    }))

    pasteCountRef.current = nextPasteCount
    commitScene(
      { ...sceneRef.current, boxes: [...sceneRef.current.boxes, ...pasted] },
      `Pasted ${pasted.length} ${pasted.length === 1 ? 'block' : 'blocks'}`,
    )
    selectBoxesFootprint(pasted)
    setRightPanelTab('selection')
  }

  const resizeSelectedFootprint = (axis: 'x' | 'y', delta: number) => {
    const cells = Array.from(selectedKeysRef.current).map(parseCellKey)
    const selected = selectedBoxesForCells(sceneRef.current, cells)
    if (selected.length === 0) {
      setStatus('Select blocks before resizing')
      return
    }

    const selectedIds = new Set(selected.map((box) => box.id))
    let changed = false
    const boxes = sceneRef.current.boxes.map((box) => {
      if (!selectedIds.has(box.id)) return box
      const widthTiles = axis === 'x' ? Math.max(1, box.widthTiles + delta) : box.widthTiles
      const depthTiles = axis === 'y' ? Math.max(1, box.depthTiles + delta) : box.depthTiles
      changed ||= widthTiles !== box.widthTiles || depthTiles !== box.depthTiles
      return { ...box, widthTiles, depthTiles }
    })

    if (!changed) {
      setStatus('Selection already at minimum size')
      return
    }

    const updatedSelected = boxes.filter((box) => selectedIds.has(box.id))
    const firstBox = updatedSelected[0]
    if (firstBox) {
      const nextBrush = {
        ...brushRef.current,
        widthTiles: firstBox.widthTiles,
        depthTiles: firstBox.depthTiles,
      }
      brushRef.current = nextBrush
      setBrush(nextBrush)
    }
    commitScene({ ...sceneRef.current, boxes }, delta > 0 ? 'Stretched selection' : 'Shrank selection')
    selectBoxesFootprint(updatedSelected)
    setRightPanelTab('selection')
  }

  const updateSelected = (patch: Partial<BrushState>) => {
    const normalizedPatch =
      patch.heightPx == null
        ? patch
        : { ...patch, heightPx: clampHeightPx(patch.heightPx) }
    const nextBrush = { ...brushRef.current, ...normalizedPatch }
    brushRef.current = nextBrush
    setBrush(nextBrush)
    const result = buildExistingBoxUpdate(sceneRef.current, selectedCells, normalizedPatch)
    if (!result) {
      setStatus('Select an existing block first')
      return
    }

    commitScene(result.scene, 'Updated selection')
    selectBoxesFootprint(result.selectedBoxes)
  }

  const updateSelectedHat = (value: HatOptionValue) => {
    const cells = Array.from(selectedKeysRef.current).map(parseCellKey)
    const sourceScene = sceneRef.current
    const selected = selectedBoxesForCells(sourceScene, cells).filter(
      (box) => box.kind === 'cube',
    )
    if (selected.length === 0) {
      setStatus('Select a cube block first')
      return
    }

    hatEditStartRef.current = null
    const selectedIdSet = new Set(selected.map((box) => box.id))
    if (value === 'none') {
      const boxes = sourceScene.boxes.map((box) => {
        if (!selectedIdSet.has(box.id) || box.kind !== 'cube') return box
        const { hat: _hat, ...rest } = box
        return rest
      })
      const updatedSelected = boxes.filter((box) => selectedIdSet.has(box.id))
      commitScene({ ...sourceScene, boxes }, 'Removed hats')
      selectBoxesFootprint(updatedSelected)
      return
    }

    const kind: HomeBackgroundHatKind = value
    const existingHatHeight = selected.find((box) => box.hat)?.hat?.heightPx
    const fallbackHeight =
      existingHatHeight == null
        ? Math.round(sourceScene.tileSize * 0.75)
        : clampHeightPx(existingHatHeight)
    const boxes = sourceScene.boxes.map((box) => {
      if (!selectedIdSet.has(box.id) || box.kind !== 'cube') return box
      return {
        ...box,
        hat: {
          kind,
          facing: kind === 'slope'
            ? box.hat?.facing ?? brushRef.current.facing
            : undefined,
          heightPx: box.hat?.heightPx ?? fallbackHeight,
        },
      }
    })
    const updatedSelected = boxes.filter((box) => selectedIdSet.has(box.id))
    commitScene({ ...sourceScene, boxes }, 'Updated hats')
    selectBoxesFootprint(updatedSelected)
  }

  const updateSelectedHatFacing = (facing: HomeBackgroundFacing) => {
    const cells = Array.from(selectedKeysRef.current).map(parseCellKey)
    const sourceScene = sceneRef.current
    const selected = selectedBoxesForCells(sourceScene, cells).filter(
      (box) => box.kind === 'cube' && box.hat?.kind === 'slope',
    )
    if (selected.length === 0) {
      setStatus('Select cubes with slope hats first')
      return
    }

    const selectedIdSet = new Set(selected.map((box) => box.id))
    const boxes = sourceScene.boxes.map((box) => {
      if (!selectedIdSet.has(box.id) || box.kind !== 'cube' || box.hat?.kind !== 'slope') {
        return box
      }
      return {
        ...box,
        hat: {
          ...box.hat,
          facing,
        },
      }
    })
    const updatedSelected = boxes.filter((box) => selectedIdSet.has(box.id))
    commitScene({ ...sourceScene, boxes }, 'Updated slope hat direction')
    selectBoxesFootprint(updatedSelected)
  }

  const previewSelectedHatHeight = (heightPx: number) => {
    const nextHeightPx = clampHeightPx(heightPx)
    const cells = Array.from(selectedKeysRef.current).map(parseCellKey)
    if (!hatEditStartRef.current) {
      const selected = selectedBoxesForCells(sceneRef.current, cells).filter(
        (box) => box.kind === 'cube' && box.hat,
      )
      if (selected.length === 0) return
      hatEditStartRef.current = {
        scene: cloneScene(sceneRef.current),
        selectedIds: selected.map((box) => box.id),
        referenceHeightPx: selected[0].hat!.heightPx,
      }
    }
    const edit = hatEditStartRef.current
    const result = buildHatHeightUpdate(
      edit.scene,
      cells,
      nextHeightPx,
      edit.selectedIds,
      edit.referenceHeightPx,
    )
    if (!result) return

    const cloned = cloneScene(result.scene)
    sceneRef.current = cloned
    setScene(cloned)
    selectBoxesFootprint(result.selectedBoxes)
    setDirty(true)
    setStatus('Adjusting hat height')
  }

  const commitSelectedHatHeightPreview = () => {
    const edit = hatEditStartRef.current
    if (!edit) return
    hatEditStartRef.current = null
    const startingScene = edit.scene
    if (jsonForScene(startingScene) === jsonForScene(sceneRef.current)) return

    setHistory((current) => ({
      past: [...current.past.slice(-80), startingScene],
      future: [],
    }))
    setDirty(true)
    setStatus('Updated hats')
  }

  const previewSelectedHeight = (heightPx: number) => {
    const nextHeightPx = clampHeightPx(heightPx)
    const previousBrushHeight = brushRef.current.heightPx
    const nextBrush = { ...brushRef.current, heightPx: nextHeightPx }
    const cells = Array.from(selectedKeysRef.current).map(parseCellKey)
    if (!heightEditStartRef.current) {
      const selected = selectedBoxesForCells(sceneRef.current, cells)
      if (selected.length === 0) return
      heightEditStartRef.current = {
        scene: cloneScene(sceneRef.current),
        selectedIds: selected.map((box) => box.id),
        referenceHeightPx: previousBrushHeight,
      }
    }
    const edit = heightEditStartRef.current
    const result = buildExistingBoxUpdate(
      edit.scene,
      cells,
      { heightPx: nextHeightPx },
      edit.selectedIds,
      edit.referenceHeightPx,
    )
    brushRef.current = nextBrush
    setBrush(nextBrush)
    if (!result) return

    const cloned = cloneScene(result.scene)
    sceneRef.current = cloned
    setScene(cloned)
    selectBoxesFootprint(result.selectedBoxes)
    setDirty(true)
    setStatus('Adjusting height')
  }

  const commitSelectedHeightPreview = () => {
    const edit = heightEditStartRef.current
    if (!edit) return
    heightEditStartRef.current = null
    const startingScene = edit.scene
    if (jsonForScene(startingScene) === jsonForScene(sceneRef.current)) return

    setHistory((current) => ({
      past: [...current.past.slice(-80), startingScene],
      future: [],
    }))
    setDirty(true)
    setStatus('Updated selection')
  }

  useEffect(() => {
    const commitActiveHeightPreview = () => {
      commitSelectedHeightPreview()
      commitSelectedHatHeightPreview()
    }
    window.addEventListener('pointerup', commitActiveHeightPreview)
    window.addEventListener('mouseup', commitActiveHeightPreview)
    window.addEventListener('touchend', commitActiveHeightPreview)
    return () => {
      window.removeEventListener('pointerup', commitActiveHeightPreview)
      window.removeEventListener('mouseup', commitActiveHeightPreview)
      window.removeEventListener('touchend', commitActiveHeightPreview)
    }
  })

  const nudgeSelected = (dx: number, dy: number, anchor?: PopupAnchor) => {
    if (selectedBoxes.length === 0) {
      setStatus('Select blocks before moving')
      return
    }
    if (dx === 0 && dy === 0) {
      if (anchor) setRightPanelTab('selection')
      return
    }

    const sourceScene = sceneRef.current
    const moving = new Set(selectedBoxes.map((box) => box.id))
    const movedBlockKeys = new Set<string>()
    const boxes = sourceScene.boxes.map((box) => {
      if (!moving.has(box.id)) return box
      const next = { ...box, xTiles: box.xTiles + dx, yTiles: box.yTiles + dy }
      for (const cell of boxCells(next)) {
        movedBlockKeys.add(cellKey(cell))
      }
      return next
    })
    commitScene({ ...sourceScene, boxes }, 'Moved selection')
    selectedKeysRef.current = movedBlockKeys
    setSelectedKeys(movedBlockKeys)
    setRightPanelTab('selection')
  }

  const mirrorSelected = () => {
    if (selectedBoxes.length === 0) return
    const existing = new Map(scene.boxes.map((box) => [boxAnchorKey(box), box]))
    const mirroredKeys = new Set<string>()
    for (const box of selectedBoxes) {
      const mirrored: HomeBackgroundBox = {
        ...box,
        id: `${box.id}-mirror-${Date.now().toString(36)}`,
        xTiles: -box.xTiles - box.widthTiles,
        facing:
          box.kind === 'slope'
            ? flipFacing(box.facing ?? brushRef.current.facing)
            : box.facing,
      }
      existing.set(boxAnchorKey(mirrored), mirrored)
      for (const cell of boxCells(mirrored)) {
        mirroredKeys.add(cellKey(cell))
      }
    }
    commitScene({ ...scene, boxes: Array.from(existing.values()) }, 'Mirrored selection')
    selectedKeysRef.current = mirroredKeys
    setSelectedKeys(mirroredKeys)
  }

  const randomizeSelected = () => {
    const cells = Array.from(selectedKeysRef.current).map(parseCellKey)
    const selected = selectedBoxesForCells(sceneRef.current, cells)
    if (selected.length === 0) {
      setStatus('Select blocks before randomizing height')
      return
    }

    const selectedIds = new Set(selected.map((box) => box.id))
    const maxDeltaPx = 8
    const stepPx = sceneRef.current.tileSize / 8
    const boxes = sceneRef.current.boxes.map((box) => {
      if (!selectedIds.has(box.id)) return box
      const deltaPx = (Math.random() * 2 - 1) * maxDeltaPx
      const nextHeightPx = Math.round(box.heightPx + deltaPx)
      return {
        ...box,
        heightPx: Math.min(MAX_HEIGHT_PX, Math.max(stepPx, nextHeightPx)),
      }
    })
    const updatedSelected = boxes.filter((box) => selectedIds.has(box.id))
    commitScene({ ...sceneRef.current, boxes }, 'Randomized selected heights +/-8 px')
    selectBoxesFootprint(updatedSelected)
    setRightPanelTab('selection')
  }

  const applyBrushToSelection = () => {
    updateSelected(brushRef.current)
    setRightPanelTab('selection')
  }

  const adjustHeightBy = (deltaPx: number) => {
    const sourceScene = sceneRef.current
    const minHeightPx = sourceScene.tileSize / 8
    const nextHeightPx = Math.min(
      MAX_HEIGHT_PX,
      Math.max(minHeightPx, Math.round(brushRef.current.heightPx + deltaPx)),
    )

    if (selectedKeysRef.current.size > 0) {
      updateSelected({ heightPx: nextHeightPx })
      setRightPanelTab('selection')
      return
    }

    updateBrush({ heightPx: nextHeightPx })
    setStatus(`Brush height ${nextHeightPx}px`)
  }

  const adjustFootprintBy = (axis: 'x' | 'y', delta: number) => {
    if (selectedKeysRef.current.size > 0) {
      resizeSelectedFootprint(axis, delta)
      return
    }

    const currentBrush = brushRef.current
    if (axis === 'x') {
      const widthTiles = Math.min(8, Math.max(1, currentBrush.widthTiles + delta))
      updateBrush({ widthTiles })
      setStatus(`Brush width ${widthTiles}`)
      return
    }

    const depthTiles = Math.min(8, Math.max(1, currentBrush.depthTiles + delta))
    updateBrush({ depthTiles })
    setStatus(`Brush depth ${depthTiles}`)
  }

  const copySceneJson = async () => {
    await navigator.clipboard.writeText(jsonForScene(sceneRef.current))
    setStatus('Copied scene JSON')
  }

  const runAction = async (action: () => void | Promise<void>) => {
    try {
      await action()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Action failed')
    }
  }

  const undo = useCallback(() => {
    const previous = history.past.at(-1)
    if (!previous) return
    setHistory({
      past: history.past.slice(0, -1),
      future: [cloneScene(scene), ...history.future],
    })
    const cloned = cloneScene(previous)
    sceneRef.current = cloned
    setScene(cloned)
    setDirty(true)
    setStatus('Undid change')
  }, [history.future, history.past, scene])

  const redo = useCallback(() => {
    const next = history.future[0]
    if (!next) return
    setHistory({
      past: [...history.past, cloneScene(scene)],
      future: history.future.slice(1),
    })
    const cloned = cloneScene(next)
    sceneRef.current = cloned
    setScene(cloned)
    setDirty(true)
    setStatus('Redid change')
  }, [history.future, history.past, scene])

  useEffect(() => {
    const isTextEditingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      if (target.isContentEditable) return true
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEditingTarget(event.target)) return

      const commandKey = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      const code = event.code
      const runShortcut = (action: () => void | Promise<void>) => {
        event.preventDefault()
        void runAction(action)
      }

      if (commandKey && !event.altKey) {
        if (code === 'KeyZ' && event.shiftKey) {
          runShortcut(redo)
        } else if (code === 'KeyZ') {
          runShortcut(undo)
        } else if (code === 'KeyY') {
          runShortcut(redo)
        } else if (code === 'KeyC') {
          runShortcut(copySelection)
        } else if (code === 'KeyV') {
          runShortcut(pasteSelection)
        } else if (code === 'KeyA') {
          runShortcut(selectAllBlocks)
        } else if (code === 'KeyS' && event.shiftKey) {
          runShortcut(saveAsFile)
        } else if (code === 'KeyS') {
          runShortcut(saveHomeFile)
        } else if (code === 'KeyO') {
          runShortcut(loadHomeFile)
        } else if (code === 'KeyI') {
          event.preventDefault()
          fileInputRef.current?.click()
        }
        return
      }

      if (event.altKey) return

      if (code === 'Digit1' && event.shiftKey) {
        runShortcut(() => setBrushShape('cube'))
      } else if (code === 'Digit2' && event.shiftKey) {
        runShortcut(() => setBrushShape('pyramid'))
      } else if (code === 'Digit3' && event.shiftKey) {
        runShortcut(() => setBrushShape('tent'))
      } else if (code === 'Digit4' && event.shiftKey) {
        runShortcut(() => setBrushShape('halfCylinder'))
      } else if (code === 'Digit5' && event.shiftKey) {
        runShortcut(() => setBrushShape('slope'))
      } else if (code === 'Digit1') {
        runShortcut(() => setEditorMode('select'))
      } else if (code === 'Digit2') {
        runShortcut(() => setEditorMode('area'))
      } else if (code === 'Digit3') {
        runShortcut(() => setEditorMode('paint'))
      } else if (code === 'Digit4') {
        runShortcut(() => setEditorMode('erase'))
      } else if (key === 'escape') {
        runShortcut(clearSelection)
      } else if (key === 'delete' || key === 'backspace') {
        runShortcut(deleteSelected)
      } else if (key === 'arrowup') {
        runShortcut(() => nudgeSelected(0, event.shiftKey ? -5 : -1))
      } else if (key === 'arrowdown') {
        runShortcut(() => nudgeSelected(0, event.shiftKey ? 5 : 1))
      } else if (key === 'arrowleft') {
        runShortcut(() => nudgeSelected(event.shiftKey ? -5 : -1, 0))
      } else if (key === 'arrowright') {
        runShortcut(() => nudgeSelected(event.shiftKey ? 5 : 1, 0))
      } else if (code === 'BracketLeft') {
        runShortcut(() => adjustFootprintBy(event.shiftKey ? 'y' : 'x', -1))
      } else if (code === 'BracketRight') {
        runShortcut(() => adjustFootprintBy(event.shiftKey ? 'y' : 'x', 1))
      } else if (code === 'PageUp') {
        runShortcut(() => adjustHeightBy(event.shiftKey ? sceneRef.current.tileSize : 8))
      } else if (code === 'PageDown') {
        runShortcut(() => adjustHeightBy(event.shiftKey ? -sceneRef.current.tileSize : -8))
      } else if (code === 'Enter') {
        runShortcut(applyBrushToSelection)
      } else if (code === 'KeyM') {
        runShortcut(mirrorSelected)
      } else if (code === 'KeyH') {
        runShortcut(randomizeSelected)
      } else if (code === 'KeyJ') {
        runShortcut(copySceneJson)
      } else if (code === 'KeyT') {
        runShortcut(() => {
          setRightPanelTab((current) => current === 'selection' ? 'scene' : 'selection')
          setStatus('Toggled details panel')
        })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const loadHomeFile = async () => {
    const response = await fetch(API_PATH)
    if (!response.ok) throw new Error(`Load failed: ${response.status}`)
    replaceScene(normalizeScene(await response.json()), 'Loaded home-background.json')
  }

  useEffect(() => {
    const requestId = initialLoadRequestRef.current + 1
    initialLoadRequestRef.current = requestId
    let cancelled = false

    const loadInitialHomeFile = async () => {
      try {
        setStatus('Loading home-background.json')
        const response = await fetch(API_PATH)
        if (!response.ok) throw new Error(`Load failed: ${response.status}`)
        const loadedScene = normalizeScene(await response.json())
        if (!cancelled && initialLoadRequestRef.current === requestId) {
          replaceScene(loadedScene, 'Loaded home-background.json')
        }
      } catch (error) {
        if (!cancelled && initialLoadRequestRef.current === requestId) {
          setStatus(
            error instanceof Error
              ? error.message
              : 'Could not load home-background.json',
          )
        }
      }
    }

    void loadInitialHomeFile()
    return () => {
      cancelled = true
    }
  }, [])

  const saveHomeFile = async () => {
    const response = await fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonForScene(scene),
    })
    if (!response.ok) throw new Error(`Save failed: ${response.status}`)
    setDirty(false)
    setStatus('Saved web/public/data/home-background.json')
  }

  const importFile = async (file: File) => {
    replaceScene(normalizeScene(JSON.parse(await file.text())), `Imported ${file.name}`)
  }

  const saveAsFile = async () => {
    const text = jsonForScene(scene)
    const picker = window as Window & {
      showSaveFilePicker?: (options: unknown) => Promise<{
        createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>
      }>
    }
    if (picker.showSaveFilePicker) {
      const handle = await picker.showSaveFilePicker({
        suggestedName: 'home-background.json',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      setStatus('Saved JSON file')
    } else {
      downloadText('home-background.json', text)
      setStatus('Downloaded JSON file')
    }
  }

  const loadPreset = (name: 'default' | 'clear' | 'canyon' | 'wave') => {
    if (name === 'default') {
      commitScene(createDefaultScene(), 'Loaded default two-lane stream')
      return
    }
    if (name === 'clear') {
      commitScene({ ...scene, boxes: [] }, 'Cleared scene')
      selectedKeysRef.current = new Set()
      setSelectedKeys(new Set())
      return
    }

    const boxes: HomeBackgroundBox[] = []
    const add = (x: number, y: number, heightTiles: number, opacity = 0.64) => {
      boxes.push({
        id: `${name}-${x}-${y}`,
        kind: 'cube',
        xTiles: x,
        yTiles: y,
        widthTiles: 1,
        depthTiles: 1,
        heightPx: Math.round(scene.tileSize * heightTiles),
        opacity,
      })
    }

    if (name === 'canyon') {
      for (let y = -1; y > -52; y -= 1) {
        const pulse = 1 + Math.sin(Math.abs(y) * 0.42) * 0.7
        add(-8, y, 1.1 + pulse, 0.58)
        add(7, y, 1.1 + pulse, 0.58)
        if (y % 5 === 0) {
          add(-5, y, 0.75, 0.48)
          add(4, y, 0.75, 0.48)
        }
      }
    } else {
      for (let y = -1; y > -60; y -= 2) {
        const leftX = -7 + Math.round(Math.sin(Math.abs(y) * 0.22) * 2)
        const rightX = 6 + Math.round(Math.cos(Math.abs(y) * 0.22) * 2)
        add(leftX, y, 0.7 + (Math.abs(y) % 8) * 0.18, 0.62)
        add(rightX, y - 1, 0.7 + (Math.abs(y + 4) % 8) * 0.18, 0.62)
      }
    }

    commitScene({ ...scene, boxes }, `Loaded ${name} preset`)
    selectedKeysRef.current = new Set()
    setSelectedKeys(new Set())
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">HB</span>
          <div>
            <h1>Home Background Editor</h1>
            <p>True 3D scene editor for Reodite's fixed grid landscape.</p>
          </div>
        </div>
        <div className="command-row">
          <button
            type="button"
            onClick={undo}
            disabled={history.past.length === 0}
            title="Undo (Ctrl+Z)"
            aria-keyshortcuts="Control+Z Meta+Z"
          >
            <Undo2 size={17} /> Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={history.future.length === 0}
            title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
            aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z"
          >
            <Redo2 size={17} /> Redo
          </button>
          <button
            type="button"
            onClick={() => runAction(loadHomeFile)}
            title="Open home file (Ctrl+O)"
            aria-keyshortcuts="Control+O Meta+O"
          >
            <FolderOpen size={17} /> Open home file
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => runAction(saveHomeFile)}
            title="Save to repo (Ctrl+S)"
            aria-keyshortcuts="Control+S Meta+S"
          >
            <Save size={17} /> Save to repo
          </button>
          <button
            type="button"
            onClick={() => runAction(saveAsFile)}
            title="Save as JSON (Ctrl+Shift+S)"
            aria-keyshortcuts="Control+Shift+S Meta+Shift+S"
          >
            <Download size={17} /> Save as
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Import JSON (Ctrl+I)"
            aria-keyshortcuts="Control+I Meta+I"
          >
            <Upload size={17} /> Import
          </button>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) runAction(() => importFile(file))
              event.target.value = ''
            }}
          />
        </div>
      </header>

      <aside className="panel left-panel">
        <section>
          <h2>Tools</h2>
          <div className="segmented">
            <button
              type="button"
              className={mode === 'select' ? 'active' : ''}
              onClick={() => setEditorMode('select')}
              title="Select existing blocks (1)"
              aria-keyshortcuts="1"
            >
              <MousePointer2 size={18} /> Select
            </button>
            <button
              type="button"
              className={mode === 'area' ? 'active' : ''}
              onClick={() => setEditorMode('area')}
              title="Create one stretched cuboid from the dragged rectangle (2)"
              aria-keyshortcuts="2"
            >
              <Paintbrush size={18} /> Area
            </button>
            <button
              type="button"
              className={mode === 'paint' ? 'active' : ''}
              onClick={() => setEditorMode('paint')}
              title="Draw a brush-sized line of cubes (3)"
              aria-keyshortcuts="3"
            >
              <Brush size={18} /> Paint
            </button>
            <button
              type="button"
              className={mode === 'erase' ? 'active' : ''}
              onClick={() => setEditorMode('erase')}
              title="Erase cells (4)"
              aria-keyshortcuts="4"
            >
              <Eraser size={18} /> Erase
            </button>
          </div>
        </section>

        <section>
          <h2>Brush</h2>
          <RangeField
            label="Height"
            min={heightStepPx}
            max={MAX_HEIGHT_PX}
            step={heightStepPx}
            value={brush.heightPx}
            suffix=" px"
            onChange={(heightPx) => updateBrush({ heightPx })}
          />
          <ShapeField
            value={brush.kind}
            onChange={(kind) => updateBrush({ kind })}
          />
          {brush.kind === 'slope' && (
            <FacingField
              value={brush.facing}
              onChange={(facing) => updateBrush({ facing })}
            />
          )}
          <div className="two-up">
            <NumberField
              label="Width"
              min={1}
              max={8}
              value={brush.widthTiles}
              onChange={(widthTiles) => updateBrush({ widthTiles })}
            />
            <NumberField
              label="Depth"
              min={1}
              max={8}
              value={brush.depthTiles}
              onChange={(depthTiles) => updateBrush({ depthTiles })}
            />
          </div>
          <button
            type="button"
            className="wide"
            onClick={applyBrushToSelection}
            title="Apply brush to selection (Enter)"
            aria-keyshortcuts="Enter"
          >
            <Brush size={17} /> Apply brush to selection
          </button>
        </section>

      </aside>

      <main className="stage">
        <EditorViewport
          scene={scene}
          selectedKeys={selectedKeys}
          mode={mode}
          brush={brush}
          onHoverCell={setHoverCell}
          onSelectCells={selectCells}
          onAreaCells={applyAreaCells}
          onPaintCells={paintStrokeCells}
          onEraseCells={eraseCells}
          onMoveSelection={nudgeSelected}
        />
        <div className="viewport-hud">
          <span>WASD fly</span>
          <span>Space/Shift vertical</span>
          <span>Alt/middle-drag look</span>
          <span>Right-click erase</span>
          <span>Area rectangles</span>
          <span>Paint brush lines</span>
          <strong>{hoverCell ? `x ${hoverCell.x}, y ${hoverCell.y}` : 'no cell'}</strong>
        </div>
      </main>

      <aside className="panel right-panel">
        <div className="side-tabs" role="tablist" aria-label="Editor details">
          <button
            type="button"
            role="tab"
            aria-selected={rightPanelTab === 'selection'}
            className={rightPanelTab === 'selection' ? 'active' : ''}
            onClick={() => setRightPanelTab('selection')}
            title="Selection details (T toggles panel)"
            aria-keyshortcuts="T"
          >
            Selected
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={rightPanelTab === 'scene'}
            className={rightPanelTab === 'scene' ? 'active' : ''}
            onClick={() => setRightPanelTab('scene')}
            title="Scene data (T toggles panel)"
            aria-keyshortcuts="T"
          >
            Scene Data
          </button>
        </div>

        {rightPanelTab === 'selection' ? (
          <div className="tab-panel">
            <section>
              <h2>Selected Object</h2>
              <div className="stats-grid">
                <span>Cells</span>
                <strong>{selectedKeys.size}</strong>
                <span>Blocks</span>
                <strong>{selectedBoxes.length}</strong>
                <span>Cubes</span>
                <strong>{selectedCubeBoxes.length}</strong>
                <span>Slopes</span>
                <strong>{selectedSlopeBoxes.length}</strong>
              </div>
              <p className="status-line">{status}</p>
              <div className="button-grid">
                <button
                  type="button"
                  disabled={selectedBoxes.length === 0}
                  onClick={copySelection}
                  title="Copy selected blocks (Ctrl+C)"
                  aria-keyshortcuts="Control+C Meta+C"
                >
                  <Copy size={17} /> Copy
                </button>
                <button
                  type="button"
                  disabled={!copyBuffer}
                  onClick={pasteSelection}
                  title="Paste copied blocks (Ctrl+V)"
                  aria-keyshortcuts="Control+V Meta+V"
                >
                  <ClipboardPaste size={17} /> Paste
                </button>
              </div>
              {selectedBoxes.length === 0 && (
                <p className="status-line">
                  Select a block or drag-select an area in the viewport.
                </p>
              )}
            </section>

            {selectedBoxes.length > 0 && (
              <>
                <section>
                  <h2>Shape</h2>
                  <ShapeField
                    value={brush.kind}
                    onChange={(kind) =>
                      updateSelected({ kind, facing: brushRef.current.facing })
                    }
                  />
                  {brush.kind === 'slope' && (
                    <FacingField
                      value={brush.facing}
                      onChange={(facing) => updateSelected({ facing })}
                    />
                  )}
                  <RangeField
                    label="Height"
                    min={heightStepPx}
                    max={MAX_HEIGHT_PX}
                    step={heightStepPx}
                    value={brush.heightPx}
                    suffix=" px"
                    onChange={previewSelectedHeight}
                    onCommit={commitSelectedHeightPreview}
                  />
                  <div className="preset-row">
                    {[0.5, 1, 1.5, 2, 3].map((tiles) => (
                      <button
                        type="button"
                        key={tiles}
                        onClick={() => updateSelected({ heightPx: scene.tileSize * tiles })}
                      >
                        {tiles}x
                      </button>
                    ))}
                  </div>
                  <div className="button-grid">
                    <button
                      type="button"
                      onClick={() => resizeSelectedFootprint('x', -1)}
                      title="Shrink selected width ([)"
                      aria-keyshortcuts="["
                    >
                      <Minimize2 size={17} /> Width -
                    </button>
                    <button
                      type="button"
                      onClick={() => resizeSelectedFootprint('x', 1)}
                      title="Stretch selected width (])"
                      aria-keyshortcuts="]"
                    >
                      <StretchHorizontal size={17} /> Width +
                    </button>
                    <button
                      type="button"
                      onClick={() => resizeSelectedFootprint('y', -1)}
                      title="Shrink selected depth (Shift+[)"
                      aria-keyshortcuts="Shift+["
                    >
                      <Minimize2 size={17} /> Depth -
                    </button>
                    <button
                      type="button"
                      onClick={() => resizeSelectedFootprint('y', 1)}
                      title="Stretch selected depth (Shift+])"
                      aria-keyshortcuts="Shift+]"
                    >
                      <StretchVertical size={17} /> Depth +
                    </button>
                  </div>
                </section>

                <section>
                  <h2>Transform</h2>
                  <div className="nudge-pad">
                    <button
                      type="button"
                      onClick={() => nudgeSelected(0, -1)}
                      title="Move selection up (ArrowUp, Shift+ArrowUp x5)"
                      aria-keyshortcuts="ArrowUp Shift+ArrowUp"
                    >
                      Y-
                    </button>
                    <button
                      type="button"
                      onClick={() => nudgeSelected(-1, 0)}
                      title="Move selection left (ArrowLeft, Shift+ArrowLeft x5)"
                      aria-keyshortcuts="ArrowLeft Shift+ArrowLeft"
                    >
                      X-
                    </button>
                    <button
                      type="button"
                      onClick={() => nudgeSelected(1, 0)}
                      title="Move selection right (ArrowRight, Shift+ArrowRight x5)"
                      aria-keyshortcuts="ArrowRight Shift+ArrowRight"
                    >
                      X+
                    </button>
                    <button
                      type="button"
                      onClick={() => nudgeSelected(0, 1)}
                      title="Move selection down (ArrowDown, Shift+ArrowDown x5)"
                      aria-keyshortcuts="ArrowDown Shift+ArrowDown"
                    >
                      Y+
                    </button>
                  </div>
                  <div className="button-grid">
                    <button
                      type="button"
                      onClick={mirrorSelected}
                      title="Mirror selection (M)"
                      aria-keyshortcuts="M"
                    >
                      <FlipHorizontal2 size={17} /> Mirror
                    </button>
                    <button
                      type="button"
                      onClick={randomizeSelected}
                      title="Randomize selected heights +/-8 px (H)"
                      aria-keyshortcuts="H"
                    >
                      Height +/-8 px
                    </button>
                  </div>
                </section>

                {selectedCubeBoxes.length > 0 && (
                  <section>
                    <h2>Hat</h2>
                    <label className="field">
                      <span>Hat</span>
                      <select
                        value={selectedHatValue}
                        onChange={(event) =>
                          updateSelectedHat(
                            event.target.value as HatOptionValue,
                          )
                        }
                      >
                        {HAT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedHatKind === 'slope' && (
                      <FacingField
                        label="Direction"
                        value={selectedHatFacing}
                        onChange={updateSelectedHatFacing}
                      />
                    )}
                    {selectedHatKind !== 'none' && (
                      <RangeField
                        label="Hat height"
                        min={heightStepPx}
                        max={MAX_HEIGHT_PX}
                        step={heightStepPx}
                        value={selectedHatHeightPx}
                        suffix=" px"
                        onChange={previewSelectedHatHeight}
                        onCommit={commitSelectedHatHeightPreview}
                      />
                    )}
                  </section>
                )}

                <section>
                  <button
                    type="button"
                    className="wide danger"
                    disabled={selectedBoxes.length === 0}
                    onClick={deleteSelected}
                    title="Delete selected blocks (Delete or Backspace)"
                    aria-keyshortcuts="Delete Backspace"
                  >
                    <Trash2 size={17} /> Delete selected blocks
                  </button>
                </section>
              </>
            )}
          </div>
        ) : (
          <div className="tab-panel">
            <section>
              <h2>Scene File</h2>
              <div className="stats-grid">
                <span>Status</span>
                <strong>{dirty ? 'Unsaved' : 'Saved'}</strong>
                <span>Cubes</span>
                <strong>{scene.boxes.length}</strong>
                <span>Bounds</span>
                <strong>{bounds}</strong>
              </div>
              <p className="status-line">{status}</p>
              <div className="button-grid">
                <button
                  type="button"
                  onClick={undo}
                  disabled={history.past.length === 0}
                  title="Undo (Ctrl+Z)"
                  aria-keyshortcuts="Control+Z Meta+Z"
                >
                  <Undo2 size={17} /> Undo
                </button>
                <button
                  type="button"
                  onClick={redo}
                  disabled={history.future.length === 0}
                  title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
                  aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z"
                >
                  <Redo2 size={17} /> Redo
                </button>
                <button
                  type="button"
                  onClick={() => runAction(copySceneJson)}
                  title="Copy scene JSON (J)"
                  aria-keyshortcuts="J"
                >
                  <FileJson size={17} /> Copy JSON
                </button>
              </div>
            </section>

            <section>
              <h2>Home Runtime</h2>
              <NumberField
                label="Tile px"
                min={24}
                max={128}
                value={scene.tileSize}
                onChange={(tileSize) => updateSceneSettings({ tileSize })}
              />
              <NumberField
                label="Horizon gap"
                min={0}
                max={240}
                value={scene.horizonGapPx}
                onChange={(horizonGapPx) => updateSceneSettings({ horizonGapPx })}
              />
              <NumberField
                label="Scroll factor"
                min={0.02}
                max={1}
                step={0.01}
                value={scene.groundScrollFactor}
                onChange={(groundScrollFactor) =>
                  updateSceneSettings({ groundScrollFactor })
                }
              />
              <NumberField
                label="Cylinder angle"
                min={0}
                max={90}
                value={scene.halfCylinderShellArcAngleDeg}
                onChange={(halfCylinderShellArcAngleDeg) =>
                  updateSceneSettings({ halfCylinderShellArcAngleDeg })
                }
              />
            </section>

            <section>
              <h2>Presets</h2>
              <div className="button-grid">
                <button type="button" onClick={() => loadPreset('default')}>
                  <RotateCcw size={17} /> Default lanes
                </button>
                <button type="button" onClick={() => loadPreset('canyon')}>Canyon</button>
                <button type="button" onClick={() => loadPreset('wave')}>Wave</button>
                <button type="button" onClick={() => loadPreset('clear')}>Clear</button>
              </div>
            </section>

            <section className="json-section">
              <h2>Preview JSON</h2>
              <pre>{jsonForScene(scene).slice(0, 1800)}</pre>
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}
