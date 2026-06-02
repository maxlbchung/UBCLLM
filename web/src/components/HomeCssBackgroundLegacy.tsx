import type { CSSProperties, RefObject } from 'react'
import type { HomeBackgroundBox, HomeBackgroundScene } from '../lib/homeBackground'

const HALF_CYLINDER_SHELL_MAX_HEIGHT_PX = 248
const HALF_CYLINDER_SHELL_MAX_ARC_ANGLE_DEG = 90

function getPyramidFaceVars(
  widthPx: number,
  depthPx: number,
  heightPx: number,
) {
  const halfWidth = Math.max(1, widthPx / 2)
  const halfDepth = Math.max(1, depthPx / 2)
  const frontSlant = Math.hypot(heightPx, halfDepth)
  const sideSlant = Math.hypot(heightPx, halfWidth)
  const frontAngle = -(Math.atan2(heightPx, halfDepth) * 180) / Math.PI
  const sideAngle = (Math.atan2(heightPx, halfWidth) * 180) / Math.PI

  return {
    '--pyramid-front-angle': `${frontAngle.toFixed(4)}deg`,
    '--pyramid-front-slant': `${frontSlant.toFixed(3)}px`,
    '--pyramid-side-left-angle': `${(-sideAngle).toFixed(4)}deg`,
    '--pyramid-side-right-angle': `${sideAngle.toFixed(4)}deg`,
    '--pyramid-side-slant': `${sideSlant.toFixed(3)}px`,
  } as CSSProperties
}

function getHalfCylinderShellVars(
  baseArcAngleDeg: number,
  heightPx: number,
) {
  const t = Math.max(
    0,
    Math.min(1, heightPx / HALF_CYLINDER_SHELL_MAX_HEIGHT_PX),
  )
  const easedT = t * t * (3 - 2 * t)
  const arcAngleDeg =
    baseArcAngleDeg +
    (HALF_CYLINDER_SHELL_MAX_ARC_ANGLE_DEG - baseArcAngleDeg) * easedT
  const angleRad = (arcAngleDeg * Math.PI) / 180
  const shellWidth = Math.hypot(1 + Math.cos(angleRad), Math.sin(angleRad))
  const shellRotationDeg = 180 - arcAngleDeg / 2
  const shellLineWidthRatio = 1 / Math.max(0.001, Math.cos(angleRad / 2))

  return {
    '--half-cylinder-shell-left-rotation': `${-shellRotationDeg.toFixed(4)}deg`,
    '--half-cylinder-shell-right-rotation': `${shellRotationDeg.toFixed(4)}deg`,
    '--half-cylinder-shell-line-width-ratio':
      shellLineWidthRatio.toFixed(8),
    '--half-cylinder-shell-width-ratio': shellWidth.toFixed(8),
  } as CSSProperties
}

function LegacyGridBox({
  box,
  halfCylinderShellArcAngleDeg,
  tileSize,
}: {
  box: HomeBackgroundBox
  halfCylinderShellArcAngleDeg: number
  tileSize: number
}) {
  const kind = box.kind === 'box' ? 'cube' : box.kind ?? 'cube'
  const widthTiles = box.widthTiles ?? 1
  const depthTiles = box.depthTiles ?? 1
  const widthPx = widthTiles * tileSize
  const depthPx = depthTiles * tileSize
  const halfCylinderHeightPx = widthPx / 2
  const heightPx =
    kind === 'halfCylinder' ? halfCylinderHeightPx : box.heightPx ?? tileSize
  const hat = kind === 'cube' ? box.hat : undefined
  const hatHeightPx =
    hat?.kind === 'halfCylinder'
      ? halfCylinderHeightPx
      : hat?.heightPx ?? 0
  const opacity = box.opacity ?? 1
  const sideFaceClass =
    box.xTiles <= 0
      ? 'home-grid-box__face--right'
      : 'home-grid-box__face--left'
  const pyramidSide = box.xTiles <= 0 ? 'right' : 'left'
  const halfCylinderSideClass =
    box.xTiles <= 0
      ? 'home-grid-box__half-cylinder--left'
      : 'home-grid-box__half-cylinder--right'
  const renderFaces = (
    renderKind: 'cube' | 'pyramid' | 'tent' | 'halfCylinder' | 'slope',
    includeHalfShell = true,
  ) => {
    if (renderKind === 'pyramid') {
      return (
        <>
          <span className="home-grid-box__pyramid-anchor home-grid-box__pyramid-anchor--front">
            <span className="home-grid-box__pyramid-face home-grid-box__pyramid-face--front" />
          </span>
          <span
            className={`home-grid-box__pyramid-anchor home-grid-box__pyramid-anchor--${pyramidSide}`}
          >
            <span
              className={`home-grid-box__pyramid-face home-grid-box__pyramid-face--${pyramidSide}`}
            />
          </span>
        </>
      )
    }
    if (renderKind === 'tent') {
      return (
        <>
          <span className="home-grid-box__triangle home-grid-box__triangle--front" />
          <span
            className={`home-grid-box__tent-plane-anchor home-grid-box__tent-plane-anchor--${pyramidSide}`}
          >
            <span
              className={`home-grid-box__tent-plane home-grid-box__tent-plane--${pyramidSide}`}
            />
          </span>
        </>
      )
    }
    if (renderKind === 'slope') {
      return (
        <>
          <span className="home-grid-box__triangle home-grid-box__triangle--front" />
          <span
            className={`home-grid-box__tent-plane-anchor home-grid-box__tent-plane-anchor--${pyramidSide}`}
          >
            <span
              className={`home-grid-box__tent-plane home-grid-box__tent-plane--${pyramidSide}`}
            />
          </span>
        </>
      )
    }
    if (renderKind === 'halfCylinder') {
      return (
        <>
          <span
            className={`home-grid-box__half-cap home-grid-box__half-cap--front ${halfCylinderSideClass}`}
          />
          <span
            className={`home-grid-box__half-cap home-grid-box__half-cap--back ${halfCylinderSideClass}`}
          />
          {includeHalfShell && (
            <span
              className={`home-grid-box__half-shell-anchor ${halfCylinderSideClass}`}
            >
              <span
                className={`home-grid-box__half-shell ${halfCylinderSideClass}`}
              />
            </span>
          )}
        </>
      )
    }
    return (
      <>
        <span className="home-grid-box__face home-grid-box__face--top" />
        <span className="home-grid-box__face home-grid-box__face--front" />
        <span className={`home-grid-box__face ${sideFaceClass}`} />
      </>
    )
  }

  return (
    <div
      className={`home-grid-box home-grid-box--${kind}${hat ? ' home-grid-box--with-hat' : ''}`}
      data-ground-fade-y={box.yTiles * tileSize}
      style={
        {
          '--box-x': `${box.xTiles * tileSize}px`,
          '--box-y': `${box.yTiles * tileSize}px`,
          '--box-w': `${widthPx}px`,
          '--box-d': `${depthPx}px`,
          '--box-h': `${heightPx}px`,
          '--base-h': `${heightPx}px`,
          '--hat-h': `${hatHeightPx}px`,
          '--ground-opacity': opacity,
          ...getPyramidFaceVars(widthPx, depthPx, heightPx),
          ...(kind === 'halfCylinder'
            ? getHalfCylinderShellVars(halfCylinderShellArcAngleDeg, 0)
            : {}),
        } as CSSProperties
      }
    >
      {renderFaces(kind)}
      {hat && (
        <div
          className={`home-grid-box__hat home-grid-box__hat--${hat.kind}`}
          style={{
            ...getPyramidFaceVars(widthPx, depthPx, hatHeightPx),
            ...(hat.kind === 'halfCylinder'
              ? getHalfCylinderShellVars(
                  halfCylinderShellArcAngleDeg,
                  heightPx,
                )
              : {}),
          }}
        >
          {renderFaces(hat.kind)}
        </div>
      )}
    </div>
  )
}

export function HomeCssBackgroundLegacy({
  landscapeRef,
  scene,
  streamerRef,
  visibleBoxes,
}: {
  landscapeRef: RefObject<HTMLDivElement | null>
  scene: HomeBackgroundScene
  streamerRef: RefObject<HTMLDivElement | null>
  visibleBoxes: HomeBackgroundBox[]
}) {
  return (
    <div
      ref={landscapeRef}
      aria-hidden
      className="home-landscape pointer-events-none fixed inset-0 overflow-hidden"
      style={
        {
          '--home-tile-size': `${scene.tileSize}px`,
        } as CSSProperties
      }
    >
      <div className="home-landscape-sun home-glow" />
      <div className="home-landscape-horizon" />
      <div className="home-landscape-floor">
        <div className="home-landscape-plane">
          <div ref={streamerRef} className="home-landscape-streamer">
            <div className="home-landscape-grid" />
            <div className="home-grid-box-layer">
              {visibleBoxes.map((box) => (
                <LegacyGridBox
                  key={box.id}
                  box={box}
                  halfCylinderShellArcAngleDeg={
                    scene.halfCylinderShellArcAngleDeg
                  }
                  tileSize={scene.tileSize}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
