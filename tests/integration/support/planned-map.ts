import type { MapIr, PlannedMapIr } from "@arena/spec";

export function plannedMap(map: MapIr): PlannedMapIr {
  if (map.terrain !== "planned") {
    throw new Error(`integration case requires a planned map, received ${map.terrain} terrain`);
  }
  return map;
}
