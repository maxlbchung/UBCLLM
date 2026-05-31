# Home Background Editor

Local-only Three.js level editor for the home-page grid background. It is not
part of the production `web` build.

```bash
npm.cmd install
npm.cmd run dev -- --port 5194
```

Open `http://127.0.0.1:5194/`.

The editor automatically loads `web/public/data/home-background.json` on open.
Use **Open home file** to reload it manually if needed.
Use **Save to repo** to write that same file through the local Vite endpoint.
Use **Save as** if you want a browser file picker / JSON download fallback.

Tool behavior:
- **Area** drags one rectangular cuboid and ignores brush width/depth.
- **Paint** draws a brush-sized line made of individual 1x1 shapes.
- Area and Paint can place cube, pyramid, tent, or semi-cylinder shapes.
- **Select** edits, moves, and deletes existing shapes only.
- Selected cubes can get a pyramid, tent, or semi-cylinder hat with its own
  height. The hat inherits the cube footprint.
- **Cylinder angle** preserves the top-level `halfCylinderShellArcAngleDeg`
  value used by the home page's CSS semi-cylinder shell.

The home page reads `web/public/data/home-background.json` at runtime and falls
back to the default two-lane cube stream if that file is missing or invalid.
