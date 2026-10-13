package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.google.gson.stream.JsonReader;
import java.io.IOException;
import java.io.StringReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

final class MapPlanReaderTest {
    private static final Path FIXTURE = Path.of("../../tests/fixtures/world-plan/world-plan-v1.json");

    @Test
    void readsTheCrossLanguageWorldPlanFixtureAndChecksItsSemanticId() throws IOException {
        MapPlan plan = MapPlanReader.read(FIXTURE);

        assertEquals("fixture-run", plan.runId());
        assertEquals("94f1cf73fef47c767b574477350ee7ce59f139e4a680464d88f99c1a25b2eedb",
                plan.mapSemanticId());
        assertEquals(10, plan.blocks().size());
        assertEquals(1, plan.spawns().size());
        assertEquals(List.of("minecraft:apple"), plan.lootContainers().getFirst().inventory());
    }

    @Test
    void acceptsTheExactByteLimitAndRejectsOneByteLess() throws IOException {
        long fixtureBytes = Files.size(FIXTURE);

        assertEquals("fixture-run", MapPlanReader.read(FIXTURE, fixtureBytes).runId());

        IOException failure = assertThrows(IOException.class,
                () -> MapPlanReader.read(FIXTURE, fixtureBytes - 1));
        assertEquals("generation plan exceeds the input byte limit", failure.getMessage());
    }

    @Test
    void rejectsDuplicateNamesUnknownFieldsAndTrailingJson() throws IOException {
        String fixture = Files.readString(FIXTURE);

        assertThrows(IOException.class,
                () -> readJson(fixture.replace("\"schema\": 1,", "\"schema\": 1, \"schema\": 1,")));
        assertThrows(IOException.class,
                () -> readJson(fixture.replace("\"schema\": 1,", "\"schema\": 1, \"extra\": true,")));
        assertThrows(IOException.class,
                () -> readJson(fixture.replace("\"width\": 4", "\"width\": 4, \"extra\": 0")));
        assertThrows(IOException.class,
                () -> readJson(fixture.replace("\"x\": 0", "\"x\": 0, \"x\": 0")));
        assertThrows(IOException.class, () -> readJson(fixture + " {}"));
    }

    @Test
    void rejectsUnknownSchemaValuesAndMapIdsThatDoNotMatchContent() throws IOException {
        String fixture = Files.readString(FIXTURE);

        assertThrows(IllegalArgumentException.class,
                () -> readJson(fixture.replace("\"schema\": 1", "\"schema\": 2")));
        assertThrows(IllegalArgumentException.class,
                () -> readJson(fixture.replace("\"width\": 4", "\"width\": 2147483649")));
        assertThrows(IllegalArgumentException.class,
                () -> readJson(fixture.replace("94f1cf73", "00000000")));
    }

    @Test
    void rejectsNonCanonicalBlockAndLootOrderBeforeNormalizingIt() throws IOException {
        String fixture = Files.readString(FIXTURE);
        String firstBlocks = """
                    { "position": { "x": 0, "y": 0, "z": 0 }, "block": "minecraft:stone" },
                    { "position": { "x": 0, "y": 0, "z": 1 }, "block": "minecraft:stone" },
                """;
        String reversedBlocks = """
                    { "position": { "x": 0, "y": 0, "z": 1 }, "block": "minecraft:stone" },
                    { "position": { "x": 0, "y": 0, "z": 0 }, "block": "minecraft:stone" },
                """;

        assertThrows(IOException.class, () -> readJson(fixture.replace(firstBlocks, reversedBlocks)));
        String firstLoot = "{ \"position\": { \"x\": 2, \"y\": 1, \"z\": 2 }, \"inventory\": [\"minecraft:apple\"] }";
        String reversedLoot = firstLoot + ",\n    { \"position\": { \"x\": 1, \"y\": 1, \"z\": 1 }, \"inventory\": [\"minecraft:bread\"] }";

        assertThrows(IOException.class, () -> readJson(fixture.replace(firstLoot, reversedLoot)));
    }

    @Test
    void rejectsFinalPlanSymlinks() throws IOException {
        Path scratchRoot = Path.of("../../.work/tmp").toAbsolutePath().normalize();
        Files.createDirectories(scratchRoot);
        Path scratch = Files.createTempDirectory(scratchRoot, "map-plan-reader-");
        Path plan = scratch.resolve("plan.json");
        Path link = scratch.resolve("plan-link.json");
        try {
            Files.copy(FIXTURE, plan);
            Files.createSymbolicLink(link, plan.getFileName());

            assertThrows(IOException.class, () -> MapPlanReader.read(link));
        } finally {
            Files.deleteIfExists(link);
            Files.deleteIfExists(plan);
            Files.deleteIfExists(scratch);
        }
    }

    private static MapPlan readJson(String contents) throws IOException {
        try (JsonReader json = new JsonReader(new StringReader(contents))) {
            json.setLenient(false);
            return MapPlanReader.readJson(json);
        }
    }
}
