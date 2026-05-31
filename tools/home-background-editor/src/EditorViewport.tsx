import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import {
  boxAnchorKey,
  brushStrokeCells,
  cellKey,
  cellsInLine,
  cellsInRect,
  parseCellKey,
  type Brush,
  type Cell,
  type HomeBackgroundBox,
  type HomeBackgroundScene,
} from './scene'

export type EditorMode = 'select' | 'area' | 'paint' | 'erase'

type PointerAnchor = {
  x: number
  y: number
}

type EditorViewportProps = {
  scene: HomeBackgroundScene
  selectedKeys: Set<string>
  mode: EditorMode
  brush: Brush
  onHoverCell: (cell: Cell | null) => void
  onSelectCells: (cells: Cell[], anchor: PointerAnchor, additive: boolean) => void
  onAreaCells: (cells: Cell[], anchor: PointerAnchor) => void
  onPaintCells: (cells: Cell[], anchor: PointerAnchor) => void
  onEraseCells: (cells: Cell[]) => void
  onMoveSelection: (dx: number, dy: number, anchor: PointerAnchor) => void
}

type ViewHandles = {
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  cubeGroup: THREE.Group
  selectionGroup: THREE.Group
  draftGroup: THREE.Group
  hoverMesh: THREE.Mesh
}

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const FORWARD = new THREE.Vector3()
const RIGHT = new THREE.Vector3()

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
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

function geometryFromTriangles(vertices: number[], indices: number[]) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function halfCylinderGeometry(width: number, height: number, depth: number) {
  const halfWidth = width / 2
  const halfDepth = depth / 2
  const segments = 18
  const vertices: number[] = []
  const indices: number[] = []
  const frontArc: number[] = []
  const backArc: number[] = []

  const addVertex = (x: number, y: number, z: number) => {
    const index = vertices.length / 3
    vertices.push(x, y, z)
    return index
  }

  const frontCenter = addVertex(0, 0, -halfDepth)
  const backCenter = addVertex(0, 0, halfDepth)

  for (let i = 0; i <= segments; i += 1) {
    const angle = Math.PI - (Math.PI * i) / segments
    const x = Math.cos(angle) * halfWidth
    const y = Math.sin(angle) * height
    frontArc.push(addVertex(x, y, -halfDepth))
    backArc.push(addVertex(x, y, halfDepth))
  }

  for (let i = 0; i < segments; i += 1) {
    const frontA = frontArc[i]
    const frontB = frontArc[i + 1]
    const backA = backArc[i]
    const backB = backArc[i + 1]

    indices.push(frontCenter, frontA, frontB)
    indices.push(backCenter, backB, backA)
    indices.push(frontA, backA, backB, frontA, backB, frontB)
  }

  indices.push(frontArc[0], frontArc[segments], backArc[segments])
  indices.push(frontArc[0], backArc[segments], backArc[0])

  return geometryFromTriangles(vertices, indices)
}

function shapeGeometry(box: HomeBackgroundBox, tileSize: number) {
  const width = box.widthTiles * tileSize
  const depth = box.depthTiles * tileSize
  const height = box.kind === 'halfCylinder' ? width / 2 : box.heightPx
  const halfWidth = width / 2
  const halfDepth = depth / 2

  if (box.kind === 'pyramid') {
    return geometryFromTriangles(
      [
        -halfWidth, 0, -halfDepth,
        halfWidth, 0, -halfDepth,
        halfWidth, 0, halfDepth,
        -halfWidth, 0, halfDepth,
        0, height, 0,
      ],
      [
        0, 2, 1,
        0, 3, 2,
        0, 1, 4,
        1, 2, 4,
        2, 3, 4,
        3, 0, 4,
      ],
    )
  }

  if (box.kind === 'tent') {
    return geometryFromTriangles(
      [
        -halfWidth, 0, -halfDepth,
        halfWidth, 0, -halfDepth,
        0, height, -halfDepth,
        -halfWidth, 0, halfDepth,
        halfWidth, 0, halfDepth,
        0, height, halfDepth,
      ],
      [
        0, 3, 4,
        0, 4, 1,
        0, 2, 5,
        0, 5, 3,
        1, 4, 5,
        1, 5, 2,
        0, 1, 2,
        3, 5, 4,
      ],
    )
  }

  if (box.kind === 'halfCylinder') {
    return halfCylinderGeometry(width, height, depth)
  }

  const geometry = new THREE.BoxGeometry(width, height, depth)
  geometry.translate(0, height / 2, 0)
  return geometry
}

function shapeColor(kind: HomeBackgroundBox['kind']) {
  if (kind === 'pyramid') return 0xfbbf24
  if (kind === 'tent') return 0x34d399
  if (kind === 'halfCylinder') return 0xf472b6
  return 0x32d4ff
}

function cubeObject(box: HomeBackgroundBox, tileSize: number, selected: boolean) {
  const group = new THREE.Group()
  const addShape = (shapeBox: HomeBackgroundBox, yOffset: number) => {
    const geometry = shapeGeometry(shapeBox, tileSize)
    const material = new THREE.MeshStandardMaterial({
      color: selected ? 0xffcf5a : shapeColor(shapeBox.kind),
      emissive: selected ? 0x7a4b00 : 0x08364b,
      metalness: 0.16,
      roughness: 0.48,
      flatShading: shapeBox.kind === 'halfCylinder',
      transparent: true,
      opacity: selected ? Math.min(1, box.opacity + 0.18) : box.opacity,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(
      (box.xTiles + box.widthTiles / 2) * tileSize,
      yOffset,
      (box.yTiles + box.depthTiles / 2) * tileSize,
    )
    mesh.castShadow = true
    mesh.receiveShadow = true

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: selected ? 0xfff1a8 : 0xa5f3fc,
        transparent: true,
        opacity: selected ? 0.95 : 0.56,
      }),
    )
    edges.position.copy(mesh.position)
    group.add(mesh, edges)
  }

  addShape(box, 0)
  if (box.kind === 'cube' && box.hat) {
    addShape(
      {
        ...box,
        kind: box.hat.kind,
        heightPx: box.hat.heightPx,
      },
      box.heightPx,
    )
  }
  return group
}

function cellPlate(cell: Cell, tileSize: number, color: number, opacity: number) {
  const geometry = new THREE.PlaneGeometry(tileSize, tileSize)
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const plate = new THREE.Mesh(geometry, material)
  plate.rotation.x = -Math.PI / 2
  plate.position.set((cell.x + 0.5) * tileSize, 1, (cell.y + 0.5) * tileSize)
  return plate
}

export function EditorViewport(props: EditorViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const handlesRef = useRef<ViewHandles | null>(null)
  const propsRef = useRef(props)

  useEffect(() => {
    propsRef.current = props
  }, [props])

  useEffect(() => {
    const handles = handlesRef.current
    if (!handles) return
    const selectedAnchors = props.selectedKeys
    clearGroup(handles.cubeGroup)
    for (const box of props.scene.boxes) {
      handles.cubeGroup.add(
        cubeObject(box, props.scene.tileSize, selectedAnchors.has(boxAnchorKey(box))),
      )
    }
  }, [props.scene.boxes, props.scene.tileSize, props.selectedKeys])

  useEffect(() => {
    const handles = handlesRef.current
    if (!handles) return
    clearGroup(handles.selectionGroup)
    for (const key of props.selectedKeys) {
      handles.selectionGroup.add(
        cellPlate(parseCellKey(key), props.scene.tileSize, 0xffcf5a, 0.24),
      )
    }
  }, [props.scene.tileSize, props.selectedKeys])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const tileSize = propsRef.current.scene.tileSize
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.shadowMap.enabled = true
    renderer.domElement.className = 'editor-canvas'
    renderer.domElement.tabIndex = 0
    mount.appendChild(renderer.domElement)

    const threeScene = new THREE.Scene()
    threeScene.background = new THREE.Color(0x07090d)
    threeScene.fog = new THREE.Fog(0x07090d, tileSize * 18, tileSize * 80)

    const camera = new THREE.PerspectiveCamera(
      60,
      Math.max(1, mount.clientWidth) / Math.max(1, mount.clientHeight),
      1,
      tileSize * 180,
    )
    const narrowViewport = window.innerWidth < 860 || mount.clientWidth < 620
    camera.position.set(
      0,
      tileSize * (narrowViewport ? 10 : 7),
      tileSize * (narrowViewport ? 16 : 12),
    )

    let yaw = 0
    let pitch = -0.48
    const updateCameraRotation = () => {
      camera.rotation.set(pitch, yaw, 0, 'YXZ')
    }
    updateCameraRotation()

    const grid = new THREE.GridHelper(tileSize * 96, 96, 0x22d3ee, 0x1d3440)
    grid.position.y = 0
    threeScene.add(grid)

    const horizon = new THREE.GridHelper(tileSize * 96, 24, 0xfbbf24, 0x22303a)
    horizon.position.y = -0.3
    horizon.position.z = -tileSize * 24
    threeScene.add(horizon)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(tileSize * 96, tileSize * 96),
      new THREE.MeshStandardMaterial({
        color: 0x0a1017,
        roughness: 0.9,
        metalness: 0.1,
        transparent: true,
        opacity: 0.52,
      }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -1.5
    floor.receiveShadow = true
    threeScene.add(floor)

    const originLineX = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-tileSize * 48, 2, 0),
        new THREE.Vector3(tileSize * 48, 2, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.55 }),
    )
    const originLineY = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 2, -tileSize * 48),
        new THREE.Vector3(0, 2, tileSize * 48),
      ]),
      new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.5 }),
    )
    threeScene.add(originLineX, originLineY)

    const cubeGroup = new THREE.Group()
    const selectionGroup = new THREE.Group()
    const draftGroup = new THREE.Group()
    threeScene.add(cubeGroup, selectionGroup, draftGroup)

    const hoverMesh = cellPlate({ x: 0, y: 0 }, tileSize, 0xffffff, 0.16)
    hoverMesh.visible = false
    threeScene.add(hoverMesh)

    const hemisphere = new THREE.HemisphereLight(0xe0f2fe, 0x111827, 1.25)
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.6)
    keyLight.position.set(tileSize * 4, tileSize * 10, tileSize * 5)
    keyLight.castShadow = true
    threeScene.add(hemisphere, keyLight)

    const handles: ViewHandles = {
      renderer,
      camera,
      cubeGroup,
      selectionGroup,
      draftGroup,
      hoverMesh,
    }
    handlesRef.current = handles
    for (const box of propsRef.current.scene.boxes) {
      cubeGroup.add(
        cubeObject(
          box,
          propsRef.current.scene.tileSize,
          propsRef.current.selectedKeys.has(boxAnchorKey(box)),
        ),
      )
    }
    for (const key of propsRef.current.selectedKeys) {
      selectionGroup.add(
        cellPlate(parseCellKey(key), propsRef.current.scene.tileSize, 0xffcf5a, 0.24),
      )
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const groundPoint = new THREE.Vector3()
    const keys = new Set<string>()
    let dragStart: Cell | null = null
    let dragLatest: Cell | null = null
    let dragIntent: 'range' | 'move' | 'paint' | null = null
    let dragAdditiveSelection = false
    let dragPath: Cell[] = []
    let looking = false
    let lastTime = performance.now()

    const cellFromPointer = (event: PointerEvent): Cell | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.ray.intersectPlane(GROUND_PLANE, groundPoint)
      if (!hit) return null
      return {
        x: Math.floor(groundPoint.x / propsRef.current.scene.tileSize),
        y: Math.floor(groundPoint.z / propsRef.current.scene.tileSize),
      }
    }

    const showDraft = (cells: Cell[], color = 0xffffff, opacity = 0.12) => {
      clearGroup(draftGroup)
      const currentTile = propsRef.current.scene.tileSize
      for (const cell of cells) {
        draftGroup.add(cellPlate(cell, currentTile, color, opacity))
      }
    }

    const showMovedSelection = (dx: number, dy: number) => {
      const movedCells = Array.from(propsRef.current.selectedKeys).map((key) => {
        const cell = parseCellKey(key)
        return { x: cell.x + dx, y: cell.y + dy }
      })
      showDraft(movedCells, 0xffcf5a, 0.3)
    }

    const showPaintStroke = () => {
      showDraft(
        brushStrokeCells(dragPath, propsRef.current.brush),
        0x22d3ee,
        0.22,
      )
    }

    const onPointerDown = (event: PointerEvent) => {
      renderer.domElement.setPointerCapture(event.pointerId)
      renderer.domElement.focus({ preventScroll: true })
      if (event.button === 2) {
        const cell = cellFromPointer(event)
        if (cell) {
          propsRef.current.onEraseCells([cell])
        }
        dragStart = null
        dragLatest = null
        dragIntent = null
        dragPath = []
        clearGroup(draftGroup)
        event.preventDefault()
        return
      }

      if (event.button === 1 || event.altKey) {
        looking = true
        event.preventDefault()
        return
      }

      if (event.button !== 0) return
      const cell = cellFromPointer(event)
      if (!cell) return
      dragAdditiveSelection = event.ctrlKey || event.metaKey
      dragStart = cell
      dragLatest = cell
      dragPath = [cell]
      const startsOnSelection = propsRef.current.selectedKeys.has(cellKey(cell))
      if (propsRef.current.mode === 'paint') {
        dragIntent = 'paint'
      } else {
        dragIntent =
          propsRef.current.mode === 'select' && startsOnSelection && !dragAdditiveSelection
            ? 'move'
            : 'range'
      }
      if (dragIntent === 'move') {
        showMovedSelection(0, 0)
      } else if (dragIntent === 'paint') {
        showPaintStroke()
      } else {
        showDraft([cell])
      }
      event.preventDefault()
    }

    const onPointerMove = (event: PointerEvent) => {
      if (looking) {
        yaw -= event.movementX * 0.0024
        pitch = Math.max(-1.35, Math.min(1.1, pitch - event.movementY * 0.0024))
        updateCameraRotation()
        return
      }

      const cell = cellFromPointer(event)
      propsRef.current.onHoverCell(cell)
      hoverMesh.visible = Boolean(cell)
      if (cell) {
        const currentTile = propsRef.current.scene.tileSize
        hoverMesh.position.set(
          (cell.x + 0.5) * currentTile,
          1.4,
          (cell.y + 0.5) * currentTile,
        )
      }

      if (dragStart && cell) {
        if (dragIntent === 'move') {
          dragLatest = cell
          showMovedSelection(cell.x - dragStart.x, cell.y - dragStart.y)
        } else if (dragIntent === 'paint') {
          const latest = dragLatest ?? dragStart
          if (cell.x !== latest.x || cell.y !== latest.y) {
            dragPath.push(...cellsInLine(latest, cell).slice(1))
            dragLatest = cell
          }
          showPaintStroke()
        } else {
          dragLatest = cell
          showDraft(cellsInRect(dragStart, dragLatest))
        }
      }
    }

    const onPointerUp = (event: PointerEvent) => {
      if (looking) {
        looking = false
        return
      }

      if (!dragStart) return
      const end = dragLatest ?? dragStart
      const anchor = { x: event.clientX, y: event.clientY }
      if (dragIntent === 'move') {
        propsRef.current.onMoveSelection(end.x - dragStart.x, end.y - dragStart.y, anchor)
      } else if (dragIntent === 'paint') {
        propsRef.current.onPaintCells(
          brushStrokeCells(dragPath.length > 0 ? dragPath : [dragStart], propsRef.current.brush),
          anchor,
        )
      } else {
        const cells = cellsInRect(dragStart, end)
        const mode = propsRef.current.mode
        if (mode === 'area') {
          propsRef.current.onAreaCells(cells, anchor)
        } else if (mode === 'erase') {
          propsRef.current.onEraseCells(cells)
        } else {
          propsRef.current.onSelectCells(
            cells,
            anchor,
            dragAdditiveSelection || event.ctrlKey || event.metaKey,
          )
        }
      }
      dragStart = null
      dragLatest = null
      dragIntent = null
      dragAdditiveSelection = false
      dragPath = []
      clearGroup(draftGroup)
    }

    const movementKey = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
        return 'space'
      }
      if (event.code.startsWith('Shift') || event.key === 'Shift') {
        return 'shift'
      }
      return event.key.toLowerCase()
    }
    const isTextEditingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      if (target.isContentEditable) return true
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEditingTarget(event.target) || event.ctrlKey || event.metaKey) return
      const key = movementKey(event)
      if (['space', 'shift', 'w', 'a', 's', 'd', 'q', 'e'].includes(key)) {
        event.preventDefault()
      }
      keys.add(key)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      keys.delete(movementKey(event))
    }
    const onContextMenu = (event: MouseEvent) => event.preventDefault()
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      camera.getWorldDirection(FORWARD)
      camera.position.addScaledVector(FORWARD, event.deltaY > 0 ? -tileSize : tileSize)
    }
    const onResize = () => {
      const width = Math.max(1, mount.clientWidth)
      const height = Math.max(1, mount.clientHeight)
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('contextmenu', onContextMenu)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('resize', onResize)

    let frame = 0
    const animate = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000)
      lastTime = now
      const currentTile = propsRef.current.scene.tileSize
      const speed = currentTile * 9
      camera.getWorldDirection(FORWARD)
      FORWARD.y = 0
      FORWARD.normalize()
      RIGHT.crossVectors(FORWARD, camera.up).normalize()

      if (keys.has('w')) camera.position.addScaledVector(FORWARD, speed * dt)
      if (keys.has('s')) camera.position.addScaledVector(FORWARD, -speed * dt)
      if (keys.has('d')) camera.position.addScaledVector(RIGHT, speed * dt)
      if (keys.has('a')) camera.position.addScaledVector(RIGHT, -speed * dt)
      if (keys.has('e') || keys.has('space')) camera.position.y += speed * dt
      if (keys.has('q') || keys.has('shift')) camera.position.y -= speed * dt

      renderer.render(threeScene, camera)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('contextmenu', onContextMenu)
      renderer.domElement.removeEventListener('wheel', onWheel)
      clearGroup(cubeGroup)
      clearGroup(selectionGroup)
      clearGroup(draftGroup)
      disposeObject(hoverMesh)
      renderer.dispose()
      renderer.domElement.remove()
      handlesRef.current = null
    }
  }, [])

  return <div ref={mountRef} className="viewport" />
}
