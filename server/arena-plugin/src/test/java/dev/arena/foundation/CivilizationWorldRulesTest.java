package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

final class CivilizationWorldRulesTest {
    @Test
    void captureZoneIncludesBothResolvedScenarioCorners() {
        ControlProtocol.CaptureZone zone = new ControlProtocol.CaptureZone(
                new ControlProtocol.BlockPosition(92, 65, 92),
                new ControlProtocol.BlockPosition(99, 70, 99), 200, 1);

        assertTrue(CivilizationWorldRules.contains(zone, new MapPlan.Position(92, 65, 92)));
        assertTrue(CivilizationWorldRules.contains(zone, new MapPlan.Position(99, 70, 99)));
        assertFalse(CivilizationWorldRules.contains(zone, new MapPlan.Position(100, 70, 99)));
    }

    @Test
    void blueprintContainsNineFloorPlanksAndSixPillarPlanksAboveTheFloor() {
        List<MapPlan.Position> cells = CivilizationWorldRules.outpostPositions(anchor(38, 65, 92, 0));

        assertEquals(15, cells.size());
        assertEquals(new MapPlan.Position(38, 65, 92), cells.getFirst());
        assertEquals(new MapPlan.Position(40, 65, 94), cells.get(8));
        assertEquals(new MapPlan.Position(38, 66, 92), cells.get(9));
        assertEquals(new MapPlan.Position(38, 68, 92), cells.get(11));
        assertEquals(new MapPlan.Position(40, 66, 94), cells.get(12));
        assertEquals(new MapPlan.Position(40, 68, 94), cells.getLast());
    }

    @Test
    void blueprintIsCompleteOnlyWhenEveryRequiredPositionHasOakPlanks() {
        ControlProtocol.BlueprintAnchor anchor = anchor(38, 65, 92, 0);
        Set<MapPlan.Position> placedPlanks = new HashSet<>(CivilizationWorldRules.outpostPositions(anchor));

        assertTrue(CivilizationWorldRules.hasCompleteOutpost(anchor, placedPlanks::contains));
        placedPlanks.remove(new MapPlan.Position(40, 68, 94));
        assertFalse(CivilizationWorldRules.hasCompleteOutpost(anchor, placedPlanks::contains));
    }

    @Test
    void resolvedCaptureZoneAndFactionOutpostsFitTheSixSeatScenarioMap() {
        ControlProtocol.CivilizationSettings civilization = civilizationSettings(
                new ControlProtocol.BlockPosition(92, 65, 92), new ControlProtocol.BlockPosition(99, 70, 99),
                new ControlProtocol.BlockPosition(38, 65, 92), new ControlProtocol.BlockPosition(151, 65, 92));
        List<MapPlan.SpawnPoint> spawns = List.of(
                spawn(0, 24, 65, 94), spawn(1, 24, 65, 96), spawn(2, 24, 65, 98),
                spawn(3, 167, 65, 94), spawn(4, 167, 65, 96), spawn(5, 167, 65, 98));

        CivilizationWorldRules.validateGeometry(civilization,
                new MapPlan.Dimensions(192, 192, 0, 128), spawns);
    }

    @Test
    void signedScenarioHeightsMustStillFitTheStagedMap() {
        ControlProtocol.CivilizationSettings civilization = civilizationSettings(
                new ControlProtocol.BlockPosition(92, -35, 92), new ControlProtocol.BlockPosition(99, -30, 99),
                new ControlProtocol.BlockPosition(38, -35, 92), new ControlProtocol.BlockPosition(151, -35, 92));
        List<MapPlan.SpawnPoint> spawns = List.of(
                spawn(0, 24, -35, 94), spawn(1, 24, -35, 96), spawn(2, 24, -35, 98),
                spawn(3, 167, -35, 94), spawn(4, 167, -35, 96), spawn(5, 167, -35, 98));
        MapPlan.Dimensions dimensions = new MapPlan.Dimensions(192, 192, -100, 28);

        CivilizationWorldRules.validateGeometry(civilization, dimensions, spawns);

        ControlProtocol.CivilizationSettings outsideMap = civilizationSettings(
                new ControlProtocol.BlockPosition(92, -101, 92), new ControlProtocol.BlockPosition(99, -30, 99),
                new ControlProtocol.BlockPosition(38, -35, 92), new ControlProtocol.BlockPosition(151, -35, 92));
        assertThrows(IllegalArgumentException.class,
                () -> CivilizationWorldRules.validateGeometry(outsideMap, dimensions, spawns));
    }

    @Test
    void rejectsObjectivesOutsideTheResolvedMapAndBlueprintsOnSpawns() {
        MapPlan.Dimensions dimensions = new MapPlan.Dimensions(192, 192, 0, 128);
        List<MapPlan.SpawnPoint> spawns = List.of(spawn(0, 24, 65, 94));

        assertThrows(IllegalArgumentException.class, () -> CivilizationWorldRules.validateGeometry(
                civilizationSettings(new ControlProtocol.BlockPosition(190, 65, 92),
                        new ControlProtocol.BlockPosition(193, 70, 99),
                        new ControlProtocol.BlockPosition(38, 65, 92),
                        new ControlProtocol.BlockPosition(151, 65, 92)), dimensions, spawns));
        assertThrows(IllegalArgumentException.class, () -> CivilizationWorldRules.validateGeometry(
                civilizationSettings(new ControlProtocol.BlockPosition(92, 65, 92),
                        new ControlProtocol.BlockPosition(99, 70, 99),
                        new ControlProtocol.BlockPosition(24, 65, 94),
                        new ControlProtocol.BlockPosition(151, 65, 92)), dimensions, spawns));
    }

    private static ControlProtocol.BlueprintAnchor anchor(long x, long y, long z, int rotation) {
        return new ControlProtocol.BlueprintAnchor(new ControlProtocol.BlockPosition(x, y, z), rotation);
    }

    private static MapPlan.SpawnPoint spawn(int seat, int x, int y, int z) {
        return new MapPlan.SpawnPoint(seat, new MapPlan.Position(x, y, z));
    }

    private static ControlProtocol.CivilizationSettings civilizationSettings(
            ControlProtocol.BlockPosition minimum,
            ControlProtocol.BlockPosition maximum,
            ControlProtocol.BlockPosition emberAnchor,
            ControlProtocol.BlockPosition tideAnchor) {
        List<ControlProtocol.FactionDefinition> factions = List.of(
                new ControlProtocol.FactionDefinition(ControlProtocol.FactionId.EMBER, List.of(
                        new ControlProtocol.FactionMember(0, ControlProtocol.CivilizationRole.GATHERER_CRAFTER),
                        new ControlProtocol.FactionMember(1, ControlProtocol.CivilizationRole.BUILDER),
                        new ControlProtocol.FactionMember(2, ControlProtocol.CivilizationRole.DEFENDER_SCOUT))),
                new ControlProtocol.FactionDefinition(ControlProtocol.FactionId.TIDE, List.of(
                        new ControlProtocol.FactionMember(3, ControlProtocol.CivilizationRole.GATHERER_CRAFTER),
                        new ControlProtocol.FactionMember(4, ControlProtocol.CivilizationRole.BUILDER),
                        new ControlProtocol.FactionMember(5, ControlProtocol.CivilizationRole.DEFENDER_SCOUT))));
        List<ControlProtocol.StartingItem> startingKit = List.of(
                ControlProtocol.StartingItem.BREAD,
                ControlProtocol.StartingItem.WOODEN_AXE,
                ControlProtocol.StartingItem.WOODEN_PICKAXE,
                ControlProtocol.StartingItem.WOODEN_SWORD);
        return new ControlProtocol.CivilizationSettings(factions, startingKit,
                new ControlProtocol.CaptureZone(minimum, maximum, 200, 1),
                new ControlProtocol.OutpostBlueprint("oak-outpost-v1", Map.of(
                        ControlProtocol.FactionId.EMBER, new ControlProtocol.BlueprintAnchor(emberAnchor, 0),
                        ControlProtocol.FactionId.TIDE, new ControlProtocol.BlueprintAnchor(tideAnchor, 180))));
    }
}
