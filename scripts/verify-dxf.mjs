import assert from "node:assert/strict";
import { buildDxfFromSiteContext } from "../server.mjs";

const center = { lat: 37.5, lng: 127.0 };

function point(deltaLng, deltaLat) {
  return [
    Number((center.lng + deltaLng).toFixed(6)),
    Number((center.lat + deltaLat).toFixed(6)),
  ];
}

function closeRing(points) {
  return [...points, points[0]];
}

function makeFeature(geometry, properties = {}) {
  return {
    type: "Feature",
    geometry,
    properties,
  };
}

function parseDxfPairs(text) {
  const values = String(text || "").trim().split(/\r\n/);
  assert.equal(values.length % 2, 0, "DXF should contain code/value pairs.");
  const pairs = [];

  for (let index = 0; index < values.length; index += 2) {
    pairs.push([values[index], values[index + 1]]);
  }

  return pairs;
}

function collectLwPolylineEntities(text) {
  const pairs = parseDxfPairs(text);
  const entities = [];

  for (let index = 0; index < pairs.length; ) {
    const [code, value] = pairs[index];

    if (code === "0" && value === "LWPOLYLINE") {
      const entity = {
        layer: "0",
        closed: false,
        elevation: 0,
        vertexCount: 0,
      };
      index += 1;

      while (index < pairs.length && pairs[index][0] !== "0") {
        const [entityCode, entityValue] = pairs[index];

        if (entityCode === "8") {
          entity.layer = entityValue;
        } else if (entityCode === "70") {
          entity.closed = (Number(entityValue) & 1) === 1;
        } else if (entityCode === "38") {
          entity.elevation = Number(entityValue);
        } else if (entityCode === "10") {
          entity.vertexCount += 1;
        }

        index += 1;
      }

      entities.push(entity);
      continue;
    }

    index += 1;
  }

  return entities;
}

function countByLayer(entities) {
  return entities.reduce((counts, entity) => {
    counts[entity.layer] = (counts[entity.layer] || 0) + 1;
    return counts;
  }, {});
}

const clipBoundary = makeFeature({
  type: "Polygon",
  coordinates: [
    closeRing([
      point(-0.0006, -0.0006),
      point(0.0006, -0.0006),
      point(0.0006, 0.0006),
      point(-0.0006, 0.0006),
    ]),
  ],
});

const parcelBoundary = makeFeature({
  type: "Polygon",
  coordinates: [
    closeRing([
      point(-0.00045, -0.0004),
      point(0.00045, -0.0004),
      point(0.00045, 0.0004),
      point(-0.00045, 0.0004),
    ]),
    closeRing([
      point(-0.00012, -0.0001),
      point(0.00012, -0.0001),
      point(0.00012, 0.0001),
      point(-0.00012, 0.0001),
    ]),
  ],
});

const parcelContext = {
  type: "FeatureCollection",
  features: [
    makeFeature({
      type: "MultiPolygon",
      coordinates: [
        [
          closeRing([
            point(-0.00055, -0.0002),
            point(-0.00035, -0.0002),
            point(-0.00035, 0.0001),
            point(-0.00055, 0.0001),
          ]),
        ],
        [
          closeRing([
            point(0.0002, -0.00032),
            point(0.00048, -0.00032),
            point(0.00048, -0.00005),
            point(0.0002, -0.00005),
          ]),
          closeRing([
            point(0.00029, -0.00024),
            point(0.00039, -0.00024),
            point(0.00039, -0.00013),
            point(0.00029, -0.00013),
          ]),
        ],
      ],
    }),
  ],
};

const contourLines = {
  type: "FeatureCollection",
  features: [
    makeFeature(
      {
        type: "LineString",
        coordinates: [point(-0.0005, 0), point(0.0005, 0)],
      },
      { elevation: 12 }
    ),
  ],
};

const buildings = {
  type: "FeatureCollection",
  features: [
    makeFeature(
      {
        type: "MultiPolygon",
        coordinates: [
          [
            closeRing([
              point(-0.0003, 0.00018),
              point(-0.00018, 0.00018),
              point(-0.00018, 0.00032),
              point(-0.0003, 0.00032),
            ]),
          ],
          [
            closeRing([
              point(0.0001, 0.00016),
              point(0.00032, 0.00016),
              point(0.00032, 0.00034),
              point(0.0001, 0.00034),
            ]),
            closeRing([
              point(0.00017, 0.00022),
              point(0.00025, 0.00022),
              point(0.00025, 0.00028),
              point(0.00017, 0.00028),
            ]),
          ],
        ],
      },
      { isTarget: false }
    ),
    makeFeature(
      {
        type: "Polygon",
        coordinates: [
          closeRing([
            point(-0.00005, 0.00018),
            point(0.00006, 0.00018),
            point(0.00006, 0.00029),
            point(-0.00005, 0.00029),
          ]),
        ],
      },
      { isTarget: true }
    ),
  ],
};

const siteContext = {
  location: center,
  options: {
    includeParcelBoundary: true,
    includeContours: true,
    includeBuildings: true,
    includeRoads: false,
  },
  clipBoundary,
  parcelBoundary,
  parcelContext,
  contourLines,
  buildings,
  roads: {
    type: "FeatureCollection",
    features: [],
  },
};

const dxf = buildDxfFromSiteContext(siteContext);
const entities = collectLwPolylineEntities(dxf);
const layerCounts = countByLayer(entities);

assert.ok(dxf.includes("\r\n"), "DXF should use CRLF line endings.");
assert.ok(
  dxf.includes("2\r\nLTYPE\r\n"),
  "DXF should define a linetype table for CAD compatibility."
);
assert.ok(
  dxf.includes("2\r\n0\r\n70\r\n0\r\n62\r\n7\r\n6\r\nCONTINUOUS\r\n"),
  "DXF should include the default layer 0."
);
assert.ok(
  !dxf.includes("\r\n0\r\nPOLYLINE\r\n"),
  "DXF should avoid legacy POLYLINE entities for the 2D export."
);
assert.ok(
  !dxf.includes("\r\n0\r\nVERTEX\r\n"),
  "DXF should avoid legacy VERTEX records for the 2D export."
);

assert.equal(layerCounts.CLIP_BOUNDARY, 1, "Clip boundary should export one closed loop.");
assert.equal(
  layerCounts.PARCEL_BOUNDARY,
  2,
  "Parcel boundary should preserve the outer ring and the hole."
);
assert.equal(
  layerCounts.PARCEL_CONTEXT,
  3,
  "Parcel context should preserve all rings from multipolygon features."
);
assert.equal(
  layerCounts.BUILDINGS,
  3,
  "Building export should preserve multipolygon rings and holes."
);
assert.equal(
  layerCounts.TARGET_BUILDING,
  1,
  "Target building should export on its dedicated layer."
);
assert.equal(layerCounts.CONTOURS, 1, "Contour lines should export as open polylines.");

const contourEntity = entities.find((entity) => entity.layer === "CONTOURS");
assert.ok(contourEntity, "Contour entity should exist.");
assert.equal(contourEntity.closed, false, "Contour entity should stay open.");
assert.equal(contourEntity.elevation, 12, "Contour elevation should be preserved.");

for (const entity of entities.filter((item) => item.layer !== "CONTOURS")) {
  assert.equal(
    entity.closed,
    true,
    `Layer ${entity.layer} should export as a closed polyline.`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      entityCount: entities.length,
      layerCounts,
      contourElevation: contourEntity.elevation,
    },
    null,
    2
  )
);
