import argparse
import json
import sqlite3
import struct
from datetime import datetime, timezone
from pathlib import Path


MAX_SOURCE_ROWS = 2000
EXPECTED_SRID = 4326


def decode_multiline(blob):
    if not isinstance(blob, bytes) or len(blob) < 57:
        raise ValueError("SXR_UDBX_GEOMETRY_INVALID")
    if blob[0] != 0 or blob[1] != 1:
        raise ValueError("SXR_UDBX_GEOMETRY_HEADER_INVALID")
    if struct.unpack_from("<I", blob, 2)[0] != EXPECTED_SRID or blob[38] != 0x7C:
        raise ValueError("SXR_UDBX_GEOMETRY_CRS_INVALID")
    if struct.unpack_from("<I", blob, 39)[0] != 5:
        raise ValueError("SXR_UDBX_GEOMETRY_TYPE_INVALID")

    part_count = struct.unpack_from("<I", blob, 43)[0]
    if part_count < 1 or part_count > 100:
        raise ValueError("SXR_UDBX_GEOMETRY_PARTS_INVALID")
    offset = 47
    parts = []
    for _ in range(part_count):
        if offset + 9 > len(blob) or blob[offset] != 0x69:
            raise ValueError("SXR_UDBX_GEOMETRY_PART_HEADER_INVALID")
        if struct.unpack_from("<I", blob, offset + 1)[0] != 2:
            raise ValueError("SXR_UDBX_GEOMETRY_PART_TYPE_INVALID")
        point_count = struct.unpack_from("<I", blob, offset + 5)[0]
        offset += 9
        if point_count < 2 or point_count > 100000 or offset + point_count * 16 > len(blob):
            raise ValueError("SXR_UDBX_GEOMETRY_POINTS_INVALID")
        coordinates = []
        for _ in range(point_count):
            lng, lat = struct.unpack_from("<dd", blob, offset)
            offset += 16
            if not (-180 <= lng <= 180 and -90 <= lat <= 90):
                raise ValueError("SXR_UDBX_COORDINATE_INVALID")
            coordinates.append([lng, lat])
        parts.append(coordinates)
    if offset >= len(blob) or blob[offset] != 0xFE or offset + 1 != len(blob):
        raise ValueError("SXR_UDBX_GEOMETRY_TRAILER_INVALID")
    return parts


def text(value, fallback=""):
    result = str(value or "").strip()
    return result or fallback


def optional_number(value):
    if value is None or str(value).strip() == "":
        return None
    return float(value)


def optional_boolean(value):
    raw = text(value).lower()
    if raw in {"true", "1", "yes"}:
        return True
    if raw in {"false", "0", "no"}:
        return False
    return None


def build_snapshot(source_path):
    connection = sqlite3.connect(f"file:{source_path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        registration = connection.execute(
            "SELECT SmTableName, SmObjectCount, SmSRID FROM SmRegister WHERE SmDatasetName = 'WalkEdge'"
        ).fetchone()
        if not registration or registration["SmTableName"] != "WalkEdge_3":
            raise ValueError("SXR_UDBX_DATASET_REGISTRATION_INVALID")
        if registration["SmSRID"] != EXPECTED_SRID:
            raise ValueError("SXR_UDBX_DATASET_CRS_INVALID")
        rows = connection.execute(
            "SELECT SmID, SmGeometry, name, highway, edge_id, from_node, to_node, "
            "length_m, walk_sec, slope_pct, stairs, shade, accessible, status, direction, data_ver "
            "FROM WalkEdge_3 ORDER BY SmID"
        ).fetchall()
    finally:
        connection.close()

    if not rows or len(rows) > MAX_SOURCE_ROWS or len(rows) != registration["SmObjectCount"]:
        raise ValueError("SXR_UDBX_ROW_COUNT_INVALID")
    edges = []
    for row in rows:
        edge_id = text(row["edge_id"])
        if not edge_id:
            raise ValueError("SXR_UDBX_EDGE_ID_MISSING")
        parts = decode_multiline(row["SmGeometry"])
        data_version = text(row["data_ver"], "2026.08.08-p1")
        edges.append({
            "edgeId": edge_id,
            "name": text(row["name"], edge_id),
            "type": text(row["highway"], "walkway"),
            "from": text(row["from_node"]),
            "to": text(row["to_node"]),
            "geometry": {
                "type": "LineString" if len(parts) == 1 else "MultiLineString",
                "coordinates": parts[0] if len(parts) == 1 else parts,
            },
            "distanceM": optional_number(row["length_m"]),
            "walkSec": optional_number(row["walk_sec"]),
            "slope": optional_number(row["slope_pct"]),
            "stairs": optional_boolean(row["stairs"]) is True,
            "shade": optional_number(row["shade"]),
            "accessible": optional_boolean(row["accessible"]),
            "status": "closed" if text(row["status"]).lower() == "closed" else "open",
            "direction": text(row["direction"], "both"),
            "dataVersion": data_version,
            "sourceRef": {
                "datasetName": "WalkEdge@GeoSync",
                "smId": row["SmID"],
                "dataVersion": data_version,
            },
        })
    return {
        "scenicId": "whu_core",
        "dataVersion": "2026.08.08-p1",
        "source": "local-snapshot",
        "readOnly": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceFile": source_path.name,
        "sourceFeatureCount": len(edges),
        "nodes": [],
        "edges": edges,
    }


def main():
    parser = argparse.ArgumentParser(description="Build the SXR road fallback snapshot from a read-only UDBX.")
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    source_path = Path(args.source).resolve()
    output_path = Path(args.output).resolve()
    snapshot = build_snapshot(source_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary_path.replace(output_path)
    print(json.dumps({
        "output": str(output_path),
        "sourceFeatureCount": snapshot["sourceFeatureCount"],
        "dataVersion": snapshot["dataVersion"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
