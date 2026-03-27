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
  const values = String(text || "").trim().split(/\r?\n/);
  assert.equal(values.length % 2, 0, "DXF should contain code/value pairs.");
  const pairs = [];

  for (let index = 0; index < values.length; index += 2) {
    pairs.push([values[index], values[index + 1]]);
  }

  return pairs;
}

function collectSectionNames(text) {
  const pairs = parseDxfPairs(text);
  const sections = [];

  for (let index = 0; index < pairs.length - 1; index += 1) {
    const [code, value] = pairs[index];
    const [nextCode, nextValue] = pairs[index + 1];

    if (code === "0" && value === "SECTION" && nextCode === "2") {
      sections.push(nextValue);
      index += 1;
    }
  }

  return sections;
}

function collectBlockRecordHandles(text) {
  const pairs = parseDxfPairs(text);
  const handles = new Map();
  let inBlockRecordTable = false;

  for (let index = 0; index < pairs.length; ) {
    const [code, value] = pairs[index];
    const [nextCode, nextValue] = pairs[index + 1] || [];

    if (!inBlockRecordTable) {
      if (code === "0" && value === "TABLE" && nextCode === "2" && nextValue === "BLOCK_RECORD") {
        inBlockRecordTable = true;
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (code === "0" && value === "ENDTAB") {
      break;
    }

    if (code === "0" && value === "BLOCK_RECORD") {
      let handle = "";
      let name = "";
      index += 1;

      while (index < pairs.length && pairs[index][0] !== "0") {
        const [recordCode, recordValue] = pairs[index];

        if (recordCode === "5") {
          handle = recordValue;
        } else if (recordCode === "2") {
          name = recordValue;
        }

        index += 1;
      }

      if (name) {
        handles.set(name, handle);
      }

      continue;
    }

    index += 1;
  }

  return handles;
}

function collectLineEntities(text) {
  const pairs = parseDxfPairs(text);
  const entities = [];

  for (let index = 0; index < pairs.length; ) {
    const [code, value] = pairs[index];

    if (code === "0" && value === "LINE") {
      const entity = {
        handle: "",
        owner: "",
        layout: "",
        layer: "0",
        subclasses: [],
        startX: null,
        startY: null,
        startZ: 0,
        endX: null,
        endY: null,
        endZ: 0,
      };
      index += 1;

      while (index < pairs.length && pairs[index][0] !== "0") {
        const [entityCode, entityValue] = pairs[index];

        if (entityCode === "5") {
          entity.handle = entityValue;
        } else if (entityCode === "330") {
          entity.owner = entityValue;
        } else if (entityCode === "410") {
          entity.layout = entityValue;
        } else if (entityCode === "100") {
          entity.subclasses.push(entityValue);
        } else if (entityCode === "8") {
          entity.layer = entityValue;
        } else if (entityCode === "10") {
          entity.startX = Number(entityValue);
        } else if (entityCode === "20") {
          entity.startY = Number(entityValue);
        } else if (entityCode === "30") {
          entity.startZ = Number(entityValue);
        } else if (entityCode === "11") {
          entity.endX = Number(entityValue);
        } else if (entityCode === "21") {
          entity.endY = Number(entityValue);
        } else if (entityCode === "31") {
          entity.endZ = Number(entityValue);
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

function collectHeaderVariables(text) {
  const pairs = parseDxfPairs(text);
  const variables = new Map();
  let inHeader = false;
  let activeVariableName = "";

  for (let index = 0; index < pairs.length; index += 1) {
    const [code, value] = pairs[index];
    const [nextCode, nextValue] = pairs[index + 1] || [];

    if (!inHeader) {
      if (code === "0" && value === "SECTION" && nextCode === "2" && nextValue === "HEADER") {
        inHeader = true;
        index += 1;
      }
      continue;
    }

    if (code === "0" && value === "ENDSEC") {
      break;
    }

    if (code === "9") {
      activeVariableName = value;
      variables.set(activeVariableName, []);
      continue;
    }

    if (activeVariableName) {
      variables.get(activeVariableName)?.push([code, value]);
    }
  }

  return variables;
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
const entities = collectLineEntities(dxf);
const layerCounts = countByLayer(entities);
const headerVariables = collectHeaderVariables(dxf);
const sectionNames = collectSectionNames(dxf);
const blockRecordHandles = collectBlockRecordHandles(dxf);
const modelSpaceHandle = blockRecordHandles.get("*Model_Space");

assert.ok(dxf.includes("\r\n"), "DXF should use CRLF line endings.");
assert.ok(
  sectionNames.includes("HEADER") &&
    sectionNames.includes("TABLES") &&
    sectionNames.includes("BLOCKS") &&
    sectionNames.includes("ENTITIES"),
  "DXF should include HEADER, TABLES, BLOCKS, and ENTITIES sections."
);
assert.ok(
  dxf.includes("2\r\nLTYPE\r\n"),
  "DXF should define a linetype table for CAD compatibility."
);
assert.ok(
  dxf.includes("2\r\nBLOCK_RECORD\r\n"),
  "DXF should define block records for model-space ownership."
);
assert.ok(
  modelSpaceHandle,
  "DXF should define a block-record handle for model space."
);
assert.ok(
  headerVariables.get("$ACADVER")?.some(
    ([code, value]) => code === "1" && value === "AC1015"
  ),
  "DXF should target the AC1015 flavor when emitting block records and entity handles."
);
assert.ok(
  headerVariables.has("$EXTMIN") && headerVariables.has("$EXTMAX"),
  "DXF header should include extents for zoom-to-fit importers."
);
assert.ok(
  dxf.includes("\r\n0\r\nLINE\r\n"),
  "DXF should emit visible line entities."
);
assert.ok(
  dxf.includes("\r\n0\r\nBLOCK\r\n") && dxf.includes("\r\n0\r\nENDBLK\r\n"),
  "DXF should define model/paper-space block sections."
);
assert.ok(
  !dxf.includes("\r\n0\r\nLWPOLYLINE\r\n"),
  "DXF should avoid LWPOLYLINE so CAD importers rely on explicit line entities."
);

assert.equal(layerCounts.CLIP_BOUNDARY, 4, "Clip boundary should export four line segments.");
assert.equal(
  layerCounts.PARCEL_BOUNDARY,
  8,
  "Parcel boundary should preserve the outer ring and the hole as segments."
);
assert.equal(
  layerCounts.PARCEL_CONTEXT,
  12,
  "Parcel context should preserve all rings from multipolygon features."
);
assert.equal(
  layerCounts.BUILDINGS,
  12,
  "Building export should preserve multipolygon rings and holes."
);
assert.equal(
  layerCounts.TARGET_BUILDING,
  4,
  "Target building should export on its dedicated layer."
);
assert.equal(layerCounts.CONTOURS, 1, "Contour lines should export as line segments.");

const contourEntity = entities.find((entity) => entity.layer === "CONTOURS");
assert.ok(contourEntity, "Contour entity should exist.");
assert.equal(contourEntity.startZ, 0, "Contour start elevation should be flattened to z=0.");
assert.equal(contourEntity.endZ, 0, "Contour end elevation should be flattened to z=0.");

for (const entity of entities) {
  assert.ok(entity.handle, `Layer ${entity.layer} should have a DXF handle.`);
  assert.equal(
    entity.owner,
    modelSpaceHandle,
    `Layer ${entity.layer} should belong to the model-space block record.`
  );
  assert.equal(
    entity.layout,
    "Model",
    `Layer ${entity.layer} should target the model layout.`
  );
  assert.ok(
    entity.subclasses.includes("AcDbEntity") &&
      entity.subclasses.includes("AcDbLine"),
    `Layer ${entity.layer} should declare AcDbEntity and AcDbLine subclasses.`
  );
  assert.ok(
    Number.isFinite(entity.startX) &&
      Number.isFinite(entity.startY) &&
      Number.isFinite(entity.endX) &&
      Number.isFinite(entity.endY),
    `Layer ${entity.layer} should export finite line endpoints.`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      entityCount: entities.length,
      sectionNames,
      layerCounts,
      contourElevation: contourEntity.startZ,
    },
    null,
    2
  )
);
