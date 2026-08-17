"""Build the Campus Map tool's static data from Reodite/ubc-unified-data.

The map tool (web/src/components/map/) is a client-side port of the Reogent
campus map: extruded building footprints, Dijkstra walking routes over the
pedestrian path network, building search with acronym aliases, POI pins, and
per-building room / study-room / service listings. Reogent serves all of that
from a backend (Meilisearch + filesystem data store); this app is a static
site, so this script derives the same artifacts ahead of time and ships them
as JSON under ``web/public/data/map/``.

Source of truth: https://github.com/Reodite/ubc-unified-data (the ``data/``
tree). By default the needed files are downloaded from raw.githubusercontent
and cached on disk (``pipeline/.map_cache/``); pass ``--source PATH`` to read
from a local checkout instead, or ``--refresh`` to redownload.

Stdlib-only (no extra pipeline dependencies needed).

Outputs (web/public/data/map/):
    buildings.geojson       footprints, properties trimmed to what the map uses
    walking-routes.geojson  pedestrian-accessible route lines, properties stripped
    building-entrances.json BLDG_CODE -> [[lon, lat], ...] (current entrances)
    buildings-index.json    [{code, name, aliases, lat, lon}] for building search
    pois.json               points of interest (cafes, libraries, banks, ...)
    study-spaces.json       classrooms + informal study spaces (Find a Space)
    lib-rooms.json          bookable library rooms (LibCal catalog)
    room-availability.json  free/booked intervals snapshot for those rooms

Usage:
    uv run build_map_data.py
    uv run build_map_data.py --source /path/to/ubc-unified-data
    uv run build_map_data.py --refresh
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "web" / "public" / "data" / "map"
CACHE_DIR = Path(__file__).resolve().parent / ".map_cache"

RAW_BASE = "https://raw.githubusercontent.com/Reodite/ubc-unified-data/main/data/"

# Repo-relative paths under data/ that we consume. The entrances filename typo
# ("entraces") is the dataset's own.
SOURCES = {
    "buildings": "geospatial/ubcv/locations/geojson/ubcv_buildings.geojson",
    "routes": "geospatial/ubcv/transportation/geojson/ubcv_routes.geojson",
    "entrances": "geospatial/ubcv/locations/geojson/ubcv_building_entraces.geojson",
    "poi": "geospatial/ubcv/locations/geojson/ubcv_poi.geojson",
    "study_rooms": "learning-spaces/rooms.json",
    "lib_rooms": "room-bookings/rooms.json",
    "availability": "room-bookings/availability.json",
}

# Building properties the map actually reads (extrusion height, labels,
# popup header, entrance join). Everything else is dropped to keep the
# shipped GeoJSON lean.
BUILDING_PROPS = (
    "BLDG_UID",
    "BLDG_CODE",
    "NAME",
    "SHORTNAME",
    "BLDG_USAGE",
    "MAX_FLOORS",
    "BLDG_HEIGHT",
    "PRIMARY_ADDRESS",
)


def load_source(name: str, source_dir: Path | None, refresh: bool) -> object:
    rel = SOURCES[name]
    if source_dir is not None:
        path = source_dir / "data" / rel
        if not path.exists():
            sys.exit(f"error: {path} not found in --source checkout")
        return json.loads(path.read_text(encoding="utf-8"))
    cached = CACHE_DIR / rel
    if refresh or not cached.exists():
        url = RAW_BASE + rel
        print(f"  downloading {url}")
        cached.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as resp:
            cached.write_bytes(resp.read())
    return json.loads(cached.read_text(encoding="utf-8"))


# ---- geometry helpers (mirror web/src/lib/map/geo.ts) ----

def exterior_ring(geometry: dict) -> list:
    """Largest exterior ring of a Polygon / MultiPolygon."""
    coords = geometry.get("coordinates") or []
    if geometry.get("type") == "Polygon":
        return coords[0] if coords else []
    best: list = []
    for polygon in coords:
        ring = polygon[0] if polygon else []
        if len(ring) > len(best):
            best = ring
    return best


def feature_centroid(feature: dict) -> tuple[float, float] | None:
    """Area-weighted centroid of the exterior ring (shoelace, local coords)."""
    geometry = feature.get("geometry") or {}
    if geometry.get("type") not in ("Polygon", "MultiPolygon"):
        return None
    ring = exterior_ring(geometry)
    if len(ring) < 3:
        return None
    ox, oy = ring[0][0], ring[0][1]
    area = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i][0] - ox, ring[i][1] - oy
        x1, y1 = ring[i + 1][0] - ox, ring[i + 1][1] - oy
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(area) < 1e-18:
        sx = sum(p[0] for p in ring) / len(ring)
        sy = sum(p[1] for p in ring) / len(ring)
        return (sx, sy)
    return (ox + cx / (3 * area), oy + cy / (3 * area))


def acronym_aliases(*names: str | None) -> list[str]:
    """Initial-letter prefixes (length >= 2) of each name — how people
    abbreviate buildings colloquially: "Irving K. Barber Learning Centre"
    -> IK, IKB, IKBL, IKBLC. Mirrors Reogent's alias generation."""
    out: set[str] = set()
    for name in names:
        if not name:
            continue
        words = [w for w in re.split(r"[^A-Za-z]+", name) if w]
        initials = "".join(w[0] for w in words).upper()
        for n in range(2, len(initials) + 1):
            out.add(initials[:n])
    return sorted(out)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    print(f"  wrote {path.relative_to(ROOT)} ({len(text) / 1024:.0f} KB)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=None,
        help="local ubc-unified-data checkout to read instead of downloading",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="redownload sources even if cached",
    )
    args = parser.parse_args()

    print("Loading sources…")
    buildings = load_source("buildings", args.source, args.refresh)
    routes = load_source("routes", args.source, args.refresh)
    entrances = load_source("entrances", args.source, args.refresh)
    poi = load_source("poi", args.source, args.refresh)
    study_rooms = load_source("study_rooms", args.source, args.refresh)
    lib_rooms = load_source("lib_rooms", args.source, args.refresh)
    availability = load_source("availability", args.source, args.refresh)

    print("Deriving map artifacts…")

    # -- buildings.geojson: trim properties --------------------------------
    trimmed_features = []
    uid_to_code: dict[str, str] = {}
    index_docs = []
    for f in buildings["features"]:
        props = f.get("properties") or {}
        code = props.get("BLDG_CODE")
        trimmed_features.append(
            {
                "type": "Feature",
                "properties": {k: props.get(k) for k in BUILDING_PROPS},
                "geometry": f.get("geometry"),
            }
        )
        if props.get("BLDG_UID") and code:
            uid_to_code[str(props["BLDG_UID"])] = str(code)
        # -- buildings-index.json: search docs (code, name, aliases, centroid)
        if code:
            centroid = feature_centroid(f)
            if centroid:
                name = props.get("NAME") or code
                index_docs.append(
                    {
                        "code": code,
                        "name": name,
                        "aliases": acronym_aliases(name, props.get("SHORTNAME")),
                        "lat": centroid[1],
                        "lon": centroid[0],
                    }
                )
    write_json(
        OUT_DIR / "buildings.geojson",
        {"type": "FeatureCollection", "features": trimmed_features},
    )
    write_json(OUT_DIR / "buildings-index.json", index_docs)

    # -- walking-routes.geojson: pedestrian lines, properties stripped -----
    walking = [
        {"type": "Feature", "properties": {}, "geometry": f.get("geometry")}
        for f in routes["features"]
        if (f.get("properties") or {}).get("PEDESTRIAN_ACCESS") == "Y"
    ]
    write_json(
        OUT_DIR / "walking-routes.geojson",
        {"type": "FeatureCollection", "features": walking},
    )

    # -- building-entrances.json: BLDG_CODE -> entrance coords -------------
    by_code: dict[str, list] = {}
    for f in entrances["features"]:
        props = f.get("properties") or {}
        geometry = f.get("geometry") or {}
        if props.get("STATUS") != "Current" or geometry.get("type") != "Point":
            continue
        code = uid_to_code.get(str(props.get("BLDG_UID") or ""))
        if not code:
            continue
        by_code.setdefault(code, []).append(geometry.get("coordinates"))
    write_json(OUT_DIR / "building-entrances.json", by_code)

    # -- pois.json: transformed POI docs (mirror Reogent's transformPoi) ---
    poi_docs = []
    for f in poi["features"]:
        props = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates")
        if not props.get("PLACENAME") or not isinstance(coords, list):
            continue
        if props.get("STATUS") and props["STATUS"] != "Current":
            continue
        poi_docs.append(
            {
                "id": str(props.get("POI_ID") or props.get("OBJECTID")),
                "name": str(props["PLACENAME"]),
                "abbreviation": props.get("ABBREVIATEDPLACENAME"),
                "service_type": props.get("SERVICE_TYPE"),
                "url": props.get("URL"),
                "contact": props.get("CONTACT"),
                "hours": props.get("HOURS"),
                "photo": props.get("PHOTOURL"),
                "lon": coords[0],
                "lat": coords[1],
            }
        )
    write_json(OUT_DIR / "pois.json", poi_docs)

    # -- study-spaces.json: Find a Space rooms (mirror transformStudySpace) -
    def as_number(value: object) -> float | None:
        try:
            n = float(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
        return n if n == n else None  # NaN guard

    def as_int(value: object) -> int | None:
        n = as_number(value)
        return int(n) if n is not None and float(n).is_integer() else n

    space_docs = []
    for row in study_rooms:
        if row.get("id") is None or not row.get("Title"):
            continue
        space_docs.append(
            {
                "id": str(row["id"]),
                "title": str(row["Title"]),
                "name": str(row["Name"]) if row.get("Name") is not None else None,
                "building_code": row.get("Building Code"),
                "building_name": row.get("Buildings - Building Name (override)")
                or row.get("Buildings - Building Name"),
                "room_number": str(row["Room Number"])
                if row.get("Room Number") is not None
                else None,
                "capacity": as_int(row.get("Capacity")),
                "space_type": row.get("space_type"),
                "furniture": row.get("Formatted_Furniture"),
                "layout": row.get("Formatted_Room_Layout_Type"),
                "floor": as_int(row.get("floor")),
                "photo": row.get("cover_photo_thumbnail_url"),
                "link": row.get("Room Link"),
            }
        )
    write_json(OUT_DIR / "study-spaces.json", space_docs)

    # -- lib-rooms.json: bookable LibCal rooms (mirror transformLibRoom) ---
    lib_docs = []
    for row in lib_rooms:
        if row.get("eid") is None or not row.get("title"):
            continue
        lib_docs.append(
            {
                "eid": row["eid"],
                "building_code": row.get("building_code"),
                "location": row.get("location"),
                "title": str(row["title"]),
                "capacity": row["capacity"]
                if isinstance(row.get("capacity"), (int, float))
                else None,
                "url": row.get("url"),
                "thumbnail": row.get("thumbnail"),
            }
        )
    write_json(OUT_DIR / "lib-rooms.json", lib_docs)

    # -- room-availability.json (mirror transformAvailability) -------------
    avail_docs = []
    for row in availability:
        if (
            row.get("eid") is None
            or not row.get("room")
            or not row.get("start")
            or not row.get("state")
        ):
            continue
        avail_docs.append(
            {
                "eid": row["eid"],
                "location": row.get("location"),
                "building_code": row.get("building_code"),
                "room": str(row["room"]),
                "capacity": row["capacity"]
                if isinstance(row.get("capacity"), (int, float))
                else None,
                "state": row["state"],
                "date": row.get("date"),
                "start": str(row["start"]),
                "end": str(row["end"]) if row.get("end") is not None else None,
                "minutes": row["minutes"]
                if isinstance(row.get("minutes"), (int, float))
                else None,
                "collected_at": row.get("collected_at"),
            }
        )
    write_json(OUT_DIR / "room-availability.json", avail_docs)

    print(
        f"Done: {len(index_docs)} buildings, {len(walking)} walking segments, "
        f"{sum(len(v) for v in by_code.values())} entrances, {len(poi_docs)} POIs, "
        f"{len(space_docs)} study spaces, {len(lib_docs)} library rooms, "
        f"{len(avail_docs)} availability intervals."
    )


if __name__ == "__main__":
    main()
