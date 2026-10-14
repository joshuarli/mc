package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.inventory.CraftingInventory;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryView;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.junit.jupiter.api.Test;

final class CivilizationMaterialCensusTest {
    private static final CivilizationMaterialCensus.StackCount OAK_LOG =
            new CivilizationMaterialCensus.StackCount("minecraft:oak_log", 1);
    private static final CivilizationMaterialCensus.StackCount OAK_PLANKS =
            new CivilizationMaterialCensus.StackCount("minecraft:oak_planks", 1);

    @Test
    void checkpointCountsInventoryDropsContainersAndPlacedPlanksInCanonicalOrder() {
        List<CivilizationMaterialCensus.InventorySnapshot> inventories = new ArrayList<>();
        for (int seat = 5; seat >= 0; seat--) {
            List<CivilizationMaterialCensus.StackCount> items = switch (seat) {
                case 0 -> List.of(new CivilizationMaterialCensus.StackCount("minecraft:oak_log", 2),
                        new CivilizationMaterialCensus.StackCount("minecraft:oak_planks", 3));
                case 5 -> List.of(new CivilizationMaterialCensus.StackCount("minecraft:oak_planks", 1));
                default -> List.of();
            };
            inventories.add(new CivilizationMaterialCensus.InventorySnapshot(seat, items));
        }
        CivilizationMaterialCensus.MaterialState state = CivilizationMaterialCensus.MaterialState.sample(
                List.of(position(54, 66, 86), position(54, 65, 86)),
                inventories,
                List.of(
                        new CivilizationMaterialCensus.ItemEntitySnapshot("drop-b", List.of(OAK_PLANKS)),
                        new CivilizationMaterialCensus.ItemEntitySnapshot("bread-drop", List.of(
                                new CivilizationMaterialCensus.StackCount("minecraft:bread", 2))),
                        new CivilizationMaterialCensus.ItemEntitySnapshot("drop-a", List.of(OAK_LOG))),
                List.of(
                        new CivilizationMaterialCensus.ContainerSnapshot(position(161, 65, 94), List.of()),
                        new CivilizationMaterialCensus.ContainerSnapshot(position(30, 65, 94), List.of(
                                new CivilizationMaterialCensus.StackCount("minecraft:oak_log", 2),
                                new CivilizationMaterialCensus.StackCount("minecraft:oak_planks", 4)))),
                List.of(position(40, 65, 94), position(38, 65, 92)));

        List<String> markers = new ArrayList<>();
        CivilizationMaterialCensus.Recorder recorder = new CivilizationMaterialCensus.Recorder("run-1", markers::add);
        recorder.checkpoint(BigInteger.ZERO, state);

        assertEquals(2, state.inventories().getFirst().oakLogs());
        assertEquals(3, state.inventories().getFirst().oakPlanks());
        assertEquals(1, state.inventories().getLast().oakPlanks());
        assertEquals(List.of("drop-a", "drop-b"), state.itemEntities().stream()
                .map(CivilizationMaterialCensus.ItemEntityCount::entityId).toList());
        assertEquals(position(30, 65, 94), state.containers().getFirst().position());
        assertEquals(2, state.containers().getFirst().oakLogs());
        assertEquals(List.of(position(38, 65, 92), position(40, 65, 94)), state.placedOakPlanks());
        assertEquals(1, markers.size());
        assertEquals(CivilizationMaterialCensus.MARKER_PREFIX
                        + "{\"kind\":\"checkpoint\",\"run_id\":\"run-1\",\"sequence\":\"1\","
                        + "\"match_tick\":\"0\",\"natural_log_positions\":[{\"x\":54,\"y\":65,\"z\":86},"
                        + "{\"x\":54,\"y\":66,\"z\":86}],\"inventories\":[{\"seat\":0,\"oak_logs\":2,"
                        + "\"oak_planks\":3},{\"seat\":1,\"oak_logs\":0,\"oak_planks\":0},"
                        + "{\"seat\":2,\"oak_logs\":0,\"oak_planks\":0},{\"seat\":3,\"oak_logs\":0,"
                        + "\"oak_planks\":0},{\"seat\":4,\"oak_logs\":0,\"oak_planks\":0},"
                        + "{\"seat\":5,\"oak_logs\":0,\"oak_planks\":1}],\"item_entities\":["
                        + "{\"entity_id\":\"drop-a\",\"oak_logs\":1,\"oak_planks\":0},"
                        + "{\"entity_id\":\"drop-b\",\"oak_logs\":0,\"oak_planks\":1}],\"containers\":["
                        + "{\"position\":{\"x\":30,\"y\":65,\"z\":94},\"oak_logs\":2,\"oak_planks\":4},"
                        + "{\"position\":{\"x\":161,\"y\":65,\"z\":94},\"oak_logs\":0,\"oak_planks\":0}],"
                        + "\"placed_oak_planks\":[{\"x\":38,\"y\":65,\"z\":92},{\"x\":40,\"y\":65,\"z\":94}]}",
                markers.getFirst());
    }

    @Test
    void deathCargoUsesEventInventoryAndDropsThenAllowsInstantPickup() {
        List<String> markers = new ArrayList<>();
        CivilizationMaterialCensus.Recorder recorder = new CivilizationMaterialCensus.Recorder(
                "run-death", markers::add);
        CivilizationMaterialCensus.MaterialState lastCheckpoint = state(List.of(
                new CivilizationMaterialCensus.InventorySnapshot(1, List.of(OAK_LOG)),
                new CivilizationMaterialCensus.InventorySnapshot(2, List.of(OAK_PLANKS))));
        recorder.checkpoint(BigInteger.ZERO, lastCheckpoint);

        List<CivilizationMaterialCensus.StackCount> cargo = List.of(
                new CivilizationMaterialCensus.StackCount("minecraft:oak_log", 2),
                new CivilizationMaterialCensus.StackCount("minecraft:oak_planks", 3));
        CivilizationMaterialCensus.MaterialState atDeath = state(List.of(
                new CivilizationMaterialCensus.InventorySnapshot(1, cargo)));
        recorder.deathCargo(BigInteger.valueOf(7), 1,
                cargo, cargo);
        CivilizationMaterialCensus.MaterialState afterDeath = state(List.of(
                new CivilizationMaterialCensus.InventorySnapshot(1, List.of()),
                new CivilizationMaterialCensus.InventorySnapshot(2, cargo)));
        recorder.checkpoint(BigInteger.valueOf(7), afterDeath);

        assertNotEquals(totalStock(lastCheckpoint), totalStock(atDeath));
        assertEquals(totalStock(atDeath), totalStock(afterDeath));
        assertEquals(3, markers.size());
        assertEquals(CivilizationMaterialCensus.MARKER_PREFIX
                        + "{\"kind\":\"death_cargo\",\"run_id\":\"run-death\",\"sequence\":\"2\","
                        + "\"match_tick\":\"7\",\"seat\":1,\"cause\":\"death\","
                        + "\"before_checkpoint_sequence\":\"1\",\"oak_logs\":2,\"oak_planks\":3,"
                        + "\"dropped_oak_logs\":2,\"dropped_oak_planks\":3}", markers.get(1));
        String deathCheckpoint = markers.getLast();
        assertTrue(deathCheckpoint.contains("{\"seat\":1,\"oak_logs\":0,\"oak_planks\":0}"));
        assertTrue(deathCheckpoint.contains("{\"seat\":2,\"oak_logs\":2,\"oak_planks\":3}"));
        assertTrue(deathCheckpoint.contains("\"item_entities\":[]"));
    }

    @Test
    void successfulDeathsForceOneSameTickCheckpointEvenWhenStateIsUnchanged() {
        List<String> markers = new ArrayList<>();
        CivilizationMaterialCensus.Recorder recorder = new CivilizationMaterialCensus.Recorder(
                "run-zero-cargo", markers::add);
        CivilizationMaterialCensus.MaterialState unchanged = state(List.of());
        recorder.checkpoint(BigInteger.ZERO, unchanged);

        recorder.deathCargo(BigInteger.ONE, 0, List.of(), List.of());
        recorder.deathCargo(BigInteger.ONE, 1, List.of(), List.of());
        recorder.checkpoint(BigInteger.ONE, unchanged);
        recorder.checkpoint(BigInteger.TWO, unchanged);

        assertEquals(4, markers.size());
        assertTrue(markers.get(1).contains("\"sequence\":\"2\""));
        assertTrue(markers.get(2).contains("\"sequence\":\"3\""));
        assertTrue(markers.get(3).contains("\"sequence\":\"4\""));
        assertTrue(markers.get(3).contains("\"match_tick\":\"1\""));
        assertTrue(markers.get(3).contains("\"kind\":\"checkpoint\""));
    }

    @Test
    void deathCheckpointMustMatchThePendingDeathTick() {
        List<String> markers = new ArrayList<>();
        CivilizationMaterialCensus.Recorder recorder = new CivilizationMaterialCensus.Recorder(
                "run-death-tick", markers::add);
        CivilizationMaterialCensus.MaterialState unchanged = state(List.of());
        recorder.checkpoint(BigInteger.ZERO, unchanged);
        recorder.deathCargo(BigInteger.valueOf(4), 0, List.of(), List.of());

        IllegalStateException tickMismatch = assertThrows(IllegalStateException.class,
                () -> recorder.checkpoint(BigInteger.valueOf(5), unchanged));
        assertEquals(2, markers.size());
        assertSame(tickMismatch, assertThrows(IllegalStateException.class,
                () -> recorder.checkpoint(BigInteger.valueOf(4), unchanged)));
    }

    @Test
    void playerSamplerCountsCraftingInputsButNotPreviewOrContainerTop() {
        ItemStack oakLog = new TestItemStack(Material.OAK_LOG, 1);
        ItemStack plankPreview = new TestItemStack(Material.OAK_PLANKS, 4);
        PlayerInventory emptyPlayerInventory = playerInventory(new ItemStack[0]);
        CraftingInventory craftingMatrix = craftingInventory(new ItemStack[] {oakLog, null, null, null},
                plankPreview);
        Player craftingPlayer = player(emptyPlayerInventory, craftingMatrix, null);

        List<CivilizationMaterialCensus.StackCount> staged = ArenaFoundationPlugin.playerMaterialStacks(craftingPlayer);
        assertEquals(1, materialCount(staged, "minecraft:oak_log"));
        assertEquals(0, materialCount(staged, "minecraft:oak_planks"));
        assertEquals(4, woodUnits(staged));

        PlayerInventory craftedPlayerInventory = playerInventory(new ItemStack[] {plankPreview});
        CraftingInventory emptyCraftingMatrix = craftingInventory(new ItemStack[4], null);
        Player craftedPlayer = player(craftedPlayerInventory, emptyCraftingMatrix, null);
        List<CivilizationMaterialCensus.StackCount> collected =
                ArenaFoundationPlugin.playerMaterialStacks(craftedPlayer);
        assertEquals(0, materialCount(collected, "minecraft:oak_log"));
        assertEquals(4, materialCount(collected, "minecraft:oak_planks"));
        assertEquals(4, woodUnits(collected));

        Inventory chestTop = inventory(new ItemStack[] {oakLog});
        Player chestViewer = player(emptyPlayerInventory, chestTop, null);
        assertTrue(ArenaFoundationPlugin.playerMaterialStacks(chestViewer).isEmpty());
    }

    @Test
    void rejectsDuplicateSeatsEntitiesContainerPositionsAndBlockPositions() {
        List<CivilizationMaterialCensus.InventorySnapshot> duplicateSeats = List.of(
                new CivilizationMaterialCensus.InventorySnapshot(0, List.of()),
                new CivilizationMaterialCensus.InventorySnapshot(0, List.of()));
        assertThrows(IllegalArgumentException.class, () -> CivilizationMaterialCensus.MaterialState.sample(
                List.of(position(1, 1, 1)), duplicateSeats, List.of(), List.of(), List.of()));

        assertThrows(IllegalArgumentException.class, () -> CivilizationMaterialCensus.MaterialState.sample(
                List.of(position(1, 1, 1)), inventories(),
                List.of(new CivilizationMaterialCensus.ItemEntitySnapshot("same", List.of()),
                        new CivilizationMaterialCensus.ItemEntitySnapshot("same", List.of())),
                List.of(), List.of()));
        assertThrows(IllegalArgumentException.class, () -> CivilizationMaterialCensus.MaterialState.sample(
                List.of(position(1, 1, 1)), inventories(), List.of(),
                List.of(new CivilizationMaterialCensus.ContainerSnapshot(position(4, 2, 3), List.of()),
                        new CivilizationMaterialCensus.ContainerSnapshot(position(4, 2, 3), List.of())), List.of()));
        assertThrows(IllegalArgumentException.class, () -> CivilizationMaterialCensus.MaterialState.sample(
                List.of(position(1, 1, 1), position(1, 1, 1)), inventories(), List.of(), List.of(), List.of()));
        assertThrows(IllegalArgumentException.class, () -> CivilizationMaterialCensus.MaterialState.sample(
                List.of(position(1, 1, 1)), inventories(), List.of(), List.of(),
                List.of(position(4, 2, 3), position(4, 2, 3))));
    }

    @Test
    void evaluatorPropertyIsExplicitAndRejectsUnknownValues() {
        assertFalse(CivilizationMaterialCensus.enabledFromProperty(null));
        assertFalse(CivilizationMaterialCensus.enabledFromProperty("false"));
        assertTrue(CivilizationMaterialCensus.enabledFromProperty("true"));
        assertThrows(IllegalArgumentException.class,
                () -> CivilizationMaterialCensus.enabledFromProperty("yes"));
    }

    @Test
    void requiresAllMapChunksAndEverySampledPositionChunkToBeLoaded() {
        List<MapPlan.ChunkPosition> mapChunks = List.of(
                new MapPlan.ChunkPosition(0, 0),
                new MapPlan.ChunkPosition(0, 1),
                new MapPlan.ChunkPosition(1, 0));
        List<MapPlan.ChunkPosition> checkedChunks = new ArrayList<>();
        CivilizationMaterialCensus.requireLoadedChunks(mapChunks, (x, z) -> {
            checkedChunks.add(new MapPlan.ChunkPosition(x, z));
            return true;
        });
        assertEquals(mapChunks, checkedChunks);

        assertThrows(IllegalStateException.class, () -> CivilizationMaterialCensus.requireLoadedChunks(
                mapChunks, (x, z) -> x != 1 || z != 0));

        List<MapPlan.ChunkPosition> sampledChunks = new ArrayList<>();
        CivilizationMaterialCensus.requirePositionChunkLoaded(-1, 16, (x, z) -> {
            sampledChunks.add(new MapPlan.ChunkPosition(x, z));
            return true;
        });
        assertEquals(List.of(new MapPlan.ChunkPosition(-1, 1)), sampledChunks);
        assertThrows(IllegalStateException.class,
                () -> CivilizationMaterialCensus.requirePositionChunkLoaded(31, 47, (x, z) -> false));
    }

    @Test
    void requiresTickZeroInitialAndEmitsOnlyChangedMaterialStates() {
        List<String> markers = new ArrayList<>();
        CivilizationMaterialCensus.Recorder invalidRecorder = new CivilizationMaterialCensus.Recorder(
                "run-changes", markers::add);
        CivilizationMaterialCensus.MaterialState initial = state(List.of());

        IllegalStateException invalidInitialTick = assertThrows(IllegalStateException.class,
                () -> invalidRecorder.checkpoint(BigInteger.ONE, initial));
        assertTrue(markers.isEmpty());
        assertSame(invalidInitialTick, assertThrows(IllegalStateException.class,
                () -> invalidRecorder.checkpoint(BigInteger.ZERO, initial)));

        CivilizationMaterialCensus.Recorder recorder = new CivilizationMaterialCensus.Recorder(
                "run-changes", markers::add);

        recorder.checkpoint(BigInteger.ZERO, initial);
        recorder.checkpoint(BigInteger.ONE, initial);
        assertEquals(1, markers.size());

        recorder.checkpoint(BigInteger.TWO, state(List.of(
                new CivilizationMaterialCensus.InventorySnapshot(0, List.of(OAK_PLANKS)))));
        assertEquals(2, markers.size());
        assertTrue(markers.getLast().contains("\"match_tick\":\"2\""));
    }

    @Test
    void recorderEnforcesMarkerCountAndByteCapsWithoutTruncation() {
        List<String> markers = new ArrayList<>();
        CivilizationMaterialCensus.Recorder recorder = new CivilizationMaterialCensus.Recorder(
                "run-capped", markers::add);
        CivilizationMaterialCensus.MaterialState initial = state(List.of());
        recorder.checkpoint(BigInteger.ZERO, initial);
        for (int marker = 1; marker < CivilizationMaterialCensus.MAX_MARKERS; marker++) {
            recorder.deathCargo(BigInteger.ZERO, 0, List.of(), List.of());
        }
        assertEquals(CivilizationMaterialCensus.MAX_MARKERS, markers.size());
        IllegalStateException firstFailure = assertThrows(IllegalStateException.class,
                () -> recorder.deathCargo(BigInteger.ZERO, 0, List.of(), List.of()));
        assertEquals(CivilizationMaterialCensus.MAX_MARKERS, markers.size());
        recorder.poison(new IllegalStateException("later evaluator failure"));
        assertSame(firstFailure,
                assertThrows(IllegalStateException.class, () -> recorder.checkpoint(BigInteger.ONE, initial)));
        assertSame(firstFailure, assertThrows(IllegalStateException.class, () -> {
            recorder.hasInitialCheckpoint();
        }));

        List<CivilizationMaterialCensus.Position> manyLogs = new ArrayList<>();
        for (int x = 0; x < 2_000; x++) {
            manyLogs.add(position(x, 64, 0));
        }
        CivilizationMaterialCensus.MaterialState oversized = CivilizationMaterialCensus.MaterialState.sample(
                manyLogs, inventories(), List.of(), List.of(), List.of());
        List<String> oversizedMarkers = new ArrayList<>();
        CivilizationMaterialCensus.Recorder sizeLimited =
                new CivilizationMaterialCensus.Recorder("run-capped", oversizedMarkers::add);
        IllegalStateException sizeFailure = assertThrows(
                IllegalStateException.class, () -> sizeLimited.checkpoint(BigInteger.ZERO, oversized));
        assertTrue(oversizedMarkers.isEmpty());
        assertSame(sizeFailure, assertThrows(IllegalStateException.class,
                () -> sizeLimited.checkpoint(BigInteger.ZERO, state(List.of()))));
    }

    private static CivilizationMaterialCensus.MaterialState state(
            List<CivilizationMaterialCensus.InventorySnapshot> materialInventories) {
        List<CivilizationMaterialCensus.InventorySnapshot> inventories = new ArrayList<>();
        for (int seat = 0; seat < 6; seat++) {
            int currentSeat = seat;
            inventories.add(materialInventories.stream()
                    .filter(inventory -> inventory.seat() == currentSeat)
                    .findFirst()
                    .orElseGet(() -> new CivilizationMaterialCensus.InventorySnapshot(currentSeat, List.of())));
        }
        return CivilizationMaterialCensus.MaterialState.sample(
                List.of(position(54, 65, 86)), inventories, List.of(), List.of(), List.of());
    }

    private static List<CivilizationMaterialCensus.InventorySnapshot> inventories() {
        List<CivilizationMaterialCensus.InventorySnapshot> inventories = new ArrayList<>();
        for (int seat = 0; seat < 6; seat++) {
            inventories.add(new CivilizationMaterialCensus.InventorySnapshot(seat, List.of()));
        }
        return inventories;
    }

    private static CivilizationMaterialCensus.MaterialCounts totalStock(
            CivilizationMaterialCensus.MaterialState state) {
        CivilizationMaterialCensus.MaterialCounts total = new CivilizationMaterialCensus.MaterialCounts(
                state.naturalLogPositions().size(), state.placedOakPlanks().size());
        for (CivilizationMaterialCensus.InventoryCount inventory : state.inventories()) {
            total = total.plus(new CivilizationMaterialCensus.MaterialCounts(
                    inventory.oakLogs(), inventory.oakPlanks()));
        }
        for (CivilizationMaterialCensus.ItemEntityCount entity : state.itemEntities()) {
            total = total.plus(new CivilizationMaterialCensus.MaterialCounts(entity.oakLogs(), entity.oakPlanks()));
        }
        for (CivilizationMaterialCensus.ContainerCount container : state.containers()) {
            total = total.plus(new CivilizationMaterialCensus.MaterialCounts(
                    container.oakLogs(), container.oakPlanks()));
        }
        return total;
    }

    private static CivilizationMaterialCensus.Position position(int x, int y, int z) {
        return new CivilizationMaterialCensus.Position(x, y, z);
    }

    private static long materialCount(List<CivilizationMaterialCensus.StackCount> items, String material) {
        return items.stream()
                .filter(item -> item.material().equals(material))
                .mapToLong(CivilizationMaterialCensus.StackCount::count)
                .sum();
    }

    private static long woodUnits(List<CivilizationMaterialCensus.StackCount> items) {
        return 4 * materialCount(items, "minecraft:oak_log")
                + materialCount(items, "minecraft:oak_planks");
    }

    private static Player player(PlayerInventory inventory, Inventory topInventory, ItemStack cursor) {
        InventoryView view = bukkitProxy(InventoryView.class, proxyResults("getTopInventory", topInventory));
        return bukkitProxy(Player.class, proxyResults(
                "getInventory", inventory,
                "getOpenInventory", view,
                "getItemOnCursor", cursor));
    }

    private static PlayerInventory playerInventory(ItemStack[] contents) {
        return bukkitProxy(PlayerInventory.class, Map.of("getContents", contents));
    }

    private static CraftingInventory craftingInventory(ItemStack[] matrix, ItemStack result) {
        ItemStack[] contents = new ItemStack[matrix.length + 1];
        System.arraycopy(matrix, 0, contents, 0, matrix.length);
        contents[matrix.length] = result;
        return bukkitProxy(CraftingInventory.class, proxyResults(
                "getContents", contents,
                "getMatrix", matrix,
                "getResult", result));
    }

    private static Inventory inventory(ItemStack[] contents) {
        return bukkitProxy(Inventory.class, Map.of("getContents", contents));
    }

    private static <T> T bukkitProxy(Class<T> api, Map<String, Object> results) {
        InvocationHandler handler = (proxy, method, arguments) -> proxyResult(proxy, method, arguments, results);
        return api.cast(Proxy.newProxyInstance(api.getClassLoader(), new Class<?>[] {api}, handler));
    }

    private static Map<String, Object> proxyResults(Object... entries) {
        Map<String, Object> results = new HashMap<>();
        for (int index = 0; index < entries.length; index += 2) {
            results.put((String) entries[index], entries[index + 1]);
        }
        return results;
    }

    private static Object proxyResult(Object proxy, Method method, Object[] arguments, Map<String, Object> results) {
        if (method.getDeclaringClass() == Object.class) {
            return switch (method.getName()) {
                case "equals" -> proxy == arguments[0];
                case "hashCode" -> System.identityHashCode(proxy);
                case "toString" -> "Bukkit API proxy";
                default -> throw new AssertionError("unexpected Object method: " + method);
            };
        }
        if (results.containsKey(method.getName())) {
            return results.get(method.getName());
        }
        throw new AssertionError("unexpected Bukkit API call: " + method);
    }

    private static final class TestItemStack extends ItemStack {
        private final Material material;
        private final int amount;

        TestItemStack(Material material, int amount) {
            super();
            this.material = material;
            this.amount = amount;
        }

        @Override
        public Material getType() {
            return material;
        }

        @Override
        public int getAmount() {
            return amount;
        }
    }
}
