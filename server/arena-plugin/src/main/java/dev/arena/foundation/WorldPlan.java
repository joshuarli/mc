package dev.arena.foundation;

abstract sealed class WorldPlan permits MapPlan, NaturalMapPlan {
    record Footprint(long width, long depth) {
        Footprint {
            if (width < 1 || width > 2_147_483_648L || depth < 1 || depth > 2_147_483_648L) {
                throw new IllegalArgumentException("map footprint must fit positive signed block coordinates");
            }
        }

        boolean contains(int x, int z) {
            return x >= 0 && x < width && z >= 0 && z < depth;
        }
    }

    abstract String runId();

    abstract String mapSemanticId();

    abstract Footprint footprint();
}
