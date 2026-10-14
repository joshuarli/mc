package dev.arena.foundation;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Predicate;

final class CivilizationWorldRules {
    private CivilizationWorldRules() {}

    static boolean contains(ControlProtocol.CaptureZone zone, MapPlan.Position position) {
        Objects.requireNonNull(zone, "capture zone");
        Objects.requireNonNull(position, "player block position");
        return position.x() >= zone.min().x() && position.x() <= zone.max().x()
                && position.y() >= zone.min().y() && position.y() <= zone.max().y()
                && position.z() >= zone.min().z() && position.z() <= zone.max().z();
    }

    static List<MapPlan.Position> outpostPositions(ControlProtocol.BlueprintAnchor anchor) {
        Objects.requireNonNull(anchor, "outpost anchor");
        List<MapPlan.Position> positions = new ArrayList<>(15);
        MapPlan.Position base = asMapPosition(anchor.position());
        for (int x = 0; x < 3; x++) {
            for (int z = 0; z < 3; z++) {
                positions.add(offset(base, x, 0, z));
            }
        }
        for (int[] corner : new int[][] {{0, 0}, {2, 2}}) {
            for (int height = 1; height <= 3; height++) {
                positions.add(offset(base, corner[0], height, corner[1]));
            }
        }
        return List.copyOf(positions);
    }

    static boolean hasCompleteOutpost(
            ControlProtocol.BlueprintAnchor anchor,
            Predicate<MapPlan.Position> isOakPlanks) {
        Objects.requireNonNull(isOakPlanks, "world block check");
        return outpostPositions(anchor).stream().allMatch(isOakPlanks);
    }

    static void validateGeometry(
            ControlProtocol.CivilizationSettings civilization,
            MapPlan.Dimensions dimensions,
            List<MapPlan.SpawnPoint> spawns) {
        Objects.requireNonNull(civilization, "civilization settings");
        Objects.requireNonNull(dimensions, "map dimensions");
        Objects.requireNonNull(spawns, "map spawns");
        if (!dimensions.contains(asMapPosition(civilization.captureZone().min()))
                || !dimensions.contains(asMapPosition(civilization.captureZone().max()))) {
            throw new IllegalArgumentException("civilization capture zone is outside the staged map");
        }
        for (ControlProtocol.FactionId faction : ControlProtocol.FactionId.values()) {
            List<MapPlan.Position> cells = outpostPositions(civilization.blueprint().anchors().get(faction));
            if (cells.stream().anyMatch(position -> !dimensions.contains(position))) {
                throw new IllegalArgumentException("civilization outpost blueprint is outside the staged map");
            }
            for (MapPlan.SpawnPoint spawn : spawns) {
                if (cells.contains(spawn.position())) {
                    throw new IllegalArgumentException("civilization outpost blueprint overlaps a competitor spawn");
                }
            }
        }
    }

    private static MapPlan.Position asMapPosition(ControlProtocol.BlockPosition position) {
        try {
            return new MapPlan.Position(Math.toIntExact(position.x()), Math.toIntExact(position.y()),
                    Math.toIntExact(position.z()));
        } catch (ArithmeticException outsideWorldCoordinates) {
            throw new IllegalArgumentException("civilization world coordinate exceeds the staged map range",
                    outsideWorldCoordinates);
        }
    }

    private static MapPlan.Position offset(MapPlan.Position position, int x, int y, int z) {
        try {
            return new MapPlan.Position(Math.addExact(position.x(), x), Math.addExact(position.y(), y),
                    Math.addExact(position.z(), z));
        } catch (ArithmeticException outsideWorldCoordinates) {
            throw new IllegalArgumentException("civilization outpost blueprint exceeds the staged map range",
                    outsideWorldCoordinates);
        }
    }
}
