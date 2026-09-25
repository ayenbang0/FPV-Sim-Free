/**
 * maps/registry.js
 * ---------------------------------------------------------------------------
 * Every flyable map, in menu order. main.js registers these with MapManager;
 * the tests import the same list so a map cannot ship without being built
 * headlessly at least once.
 */

import { ArenaMap, ARENA_META } from './ArenaMap.js';
import { HouseMap, HOUSE_META } from './HouseMap.js';
import { WarehouseMap, WAREHOUSE_META } from './WarehouseMap.js';
import { FactoryMap, FACTORY_META } from './FactoryMap.js';
import { FieldMap, FIELD_META } from './FieldMap.js';
import { AlpineMap, ALPINE_META } from './AlpineMap.js';
import { StadiumMap, STADIUM_META } from './StadiumMap.js';
import { BandoMap, BANDO_META } from './BandoMap.js';
import { NightFactoryMap, NIGHT_FACTORY_META } from './NightFactoryMap.js';
import { CoastalMap, COASTAL_META } from './CoastalMap.js';
import { CanvasMap, CanvasNightMap, CANVAS_META, CANVAS_NIGHT_META } from './CanvasMap.js';

export const MAP_REGISTRY = [
  [ARENA_META, ArenaMap],
  [WAREHOUSE_META, WarehouseMap],
  [FACTORY_META, FactoryMap],
  [HOUSE_META, HouseMap],
  [FIELD_META, FieldMap],
  [ALPINE_META, AlpineMap],
  [COASTAL_META, CoastalMap],
  [STADIUM_META, StadiumMap],
  [BANDO_META, BandoMap],
  [NIGHT_FACTORY_META, NightFactoryMap],
  [CANVAS_META, CanvasMap],
  [CANVAS_NIGHT_META, CanvasNightMap],
];
