package dev.arena.foundation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
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
    private static final Path NATURAL_FIXTURE = Path.of("../../tests/fixtures/world-plan/world-plan-v2.json");
    private static final Path ROSTER_FIXTURE = Path.of("../../tests/fixtures/world-plan/world-plan-v3.json");
    private static final Path ROSTER_256_FIXTURE = Path.of("../../tests/fixtures/world-plan/world-plan-v3-256.json");
    private static final List<String> INVALID_ROSTER_FIXTURES = List.of(
            "world-plan-v2-invalid-roster-field.json",
            "world-plan-v3-invalid-257-seats.json",
            "world-plan-v3-invalid-bot-username.json",
            "world-plan-v3-invalid-missing-roster.json",
            "world-plan-v3-invalid-reserved-username.json",
            "world-plan-v3-invalid-roster-count.json",
            "world-plan-v3-invalid-roster-gap.json",
            "world-plan-v3-invalid-unknown-kind.json");

    @Test
    void readsTheCrossLanguageWorldPlanFixtureAndChecksItsSemanticId() throws IOException {
        MapPlan plan = assertInstanceOf(MapPlan.class, MapPlanReader.read(FIXTURE));

        assertEquals("fixture-run", plan.runId());
        assertEquals("94f1cf73fef47c767b574477350ee7ce59f139e4a680464d88f99c1a25b2eedb",
                plan.mapSemanticId());
        assertEquals(10, plan.blocks().size());
        assertEquals(1, plan.spawns().size());
        assertEquals(List.of("minecraft:apple"), plan.lootContainers().getFirst().inventory());
    }

    @Test
    void readsTheNaturalCrossLanguageFixtureAndChecksItsSemanticIdAndSeed() throws IOException {
        NaturalMapPlan plan = assertInstanceOf(NaturalMapPlan.class, MapPlanReader.read(NATURAL_FIXTURE));

        assertEquals("fixture-run", plan.runId());
        assertEquals(java.math.BigInteger.ONE.shiftLeft(64).subtract(java.math.BigInteger.ONE), plan.worldSeed());
        assertEquals("873116af0230b7c6f7ba3eeb1a999ebc3952d15ab771a77f5da12959ed8d126b",
                plan.mapSemanticId());
        assertEquals(1024, plan.footprint().width());
        assertEquals(new NaturalMapPlan.SurfaceColumn(0, 0), plan.spawns().getFirst().column());
        assertEquals(List.of("minecraft:apple"), plan.lootContainers().getFirst().inventory());
    }

    @Test
    void readsTheGeneralizedRosterFixtureAndKeepsExternalUsernames() throws IOException {
        NaturalMapPlan plan = assertInstanceOf(NaturalMapPlan.class, MapPlanReader.read(ROSTER_FIXTURE));

        assertEquals(NaturalMapPlan.SCHEMA_VERSION_GENERALIZED_ROSTER, plan.schemaVersion());
        assertEquals("9a2cc5434a477dffdcb672f54e9744e0349e3440a6f84ea18b4487ec3e07e656", plan.mapSemanticId());
        assertEquals(List.of(
                NaturalMapPlan.RosterSeat.bot(0),
                NaturalMapPlan.RosterSeat.external(1, "Alex_Fixture"),
                NaturalMapPlan.RosterSeat.bot(2)), plan.roster());
    }

    @Test
    void readsTheFullCompetitorLimitWithTheTypeScriptSemanticId() throws IOException {
        NaturalMapPlan plan = assertInstanceOf(NaturalMapPlan.class, MapPlanReader.read(ROSTER_256_FIXTURE));

        assertEquals(MatchController.MAX_COMPETITORS, plan.spawns().size());
        assertEquals(MatchController.MAX_COMPETITORS, plan.roster().size());
        assertEquals("c219e478cd6f44d35c76c6b036c1e001ad06354a88d1f72c6bf6f4fc9a2ffd72", plan.mapSemanticId());
        assertEquals(NaturalMapPlan.RosterSeat.external(255, "Last_Seat"), plan.roster().getLast());
    }

    @Test
    void rejectsEveryInvalidRosterWorldPlanFixture() {
        for (String name : INVALID_ROSTER_FIXTURES) {
            Path fixture = Path.of("../../tests/fixtures/world-plan").resolve(name);
            assertThrows(IOException.class, () -> MapPlanReader.read(fixture), name);
        }
    }

    @Test
    void legacyNaturalPlansStayBoundedAtSixSeats() {
        List<NaturalMapPlan.SurfaceSpawnPoint> spawns = java.util.stream.IntStream.range(0, 7)
                .mapToObj(seat -> new NaturalMapPlan.SurfaceSpawnPoint(seat,
                        new NaturalMapPlan.SurfaceColumn(seat * 4, 0)))
                .toList();
        List<NaturalMapPlan.SurfaceLootContainer> loot = List.of(new NaturalMapPlan.SurfaceLootContainer(
                new NaturalMapPlan.SurfaceColumn(2, 2), List.of("minecraft:apple")));
        WorldPlan.Footprint footprint = new WorldPlan.Footprint(1024, 1024);
        String id = NaturalMapPlan.computeSemanticId(footprint, spawns, loot);

        assertThrows(IllegalArgumentException.class, () -> new NaturalMapPlan(
                "fixture-run", java.math.BigInteger.ONE, id, footprint, spawns, loot));
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

        assertThrows(IOException.class,
                () -> readJson(fixture.replace("\"schema\": 1", "\"schema\": 2")));
        assertThrows(IllegalArgumentException.class,
                () -> readJson(fixture.replace("\"width\": 4", "\"width\": 2147483649")));
        assertThrows(IllegalArgumentException.class,
                () -> readJson(fixture.replace("94f1cf73", "00000000")));
    }

    @Test
    void rejectsNaturalPlansWithWrongFieldsSeedDimensionsOrBlockContent() throws IOException {
        String fixture = Files.readString(NATURAL_FIXTURE);

        assertThrows(IOException.class, () -> readJson(fixture.replace("\"schema\":2,", "\"schema\":2,\"extra\":true,")));
        assertThrows(IOException.class, () -> readJson(fixture.replace("\"world_seed\":\"18446744073709551615\",", "")));
        assertThrows(IllegalArgumentException.class, () -> readJson(fixture.replace("\"depth\":1024", "\"depth\":1024,\"min_y\":-64")));
        assertThrows(IOException.class, () -> readJson(fixture.replace("\"world_seed\":\"18446744073709551615\"", "\"world_seed\":\"018446744073709551615\"")));
        assertThrows(IOException.class, () -> readJson(fixture.replace("\"world_seed\":\"18446744073709551615\"", "\"world_seed\":\"18446744073709551616\"")));
        assertThrows(IOException.class, () -> readJson(fixture.replace("\"blocks\":[]", "\"blocks\":[{\"position\":{\"x\":0,\"y\":1,\"z\":0},\"block\":\"minecraft:stone\"}]")));
        assertThrows(IOException.class, () -> readJson(fixture.replace("\"terrain\":\"vanilla\"", "\"terrain\":\"flat\"")));
        assertThrows(IllegalArgumentException.class, () -> readJson(fixture.replace("\"width\":1024", "\"width\":64")));
        assertThrows(IOException.class, () -> readJson(fixture.replace("\"column\":{\"x\":0,\"z\":0}", "\"column\":{\"x\":0,\"y\":1,\"z\":0}")));
        assertThrows(IllegalArgumentException.class,
                () -> readJson(fixture.replace("873116af", "00000000")));
    }

    @Test
    void rejectsNaturalPlansWithNonCanonicalSpawnAndLootOrder() throws IOException {
        String fixture = Files.readString(NATURAL_FIXTURE);
        String reversedSpawns = fixture.replace(
                "\"spawns\":[{\"seat\":0,\"column\":{\"x\":0,\"z\":0}}]",
                "\"spawns\":[{\"seat\":1,\"column\":{\"x\":3,\"z\":0}},{\"seat\":0,\"column\":{\"x\":0,\"z\":0}}]");
        String reversedLoot = fixture.replace(
                "\"loot_containers\":[{\"column\":{\"x\":2,\"z\":2},\"inventory\":[\"minecraft:apple\"]}]",
                "\"loot_containers\":[{\"column\":{\"x\":2,\"z\":2},\"inventory\":[\"minecraft:apple\"]},"
                        + "{\"column\":{\"x\":1,\"z\":2},\"inventory\":[\"minecraft:bread\"]}]");

        assertThrows(IOException.class, () -> readJson(reversedSpawns));
        assertThrows(IOException.class, () -> readJson(reversedLoot));
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

    private static WorldPlan readJson(String contents) throws IOException {
        try (JsonReader json = new JsonReader(new StringReader(contents))) {
            json.setLenient(false);
            return MapPlanReader.readJson(json);
        }
    }
}
