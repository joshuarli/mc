package dev.arena.foundation;

import java.io.IOException;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.Base64;
import org.bukkit.Bukkit;
import org.bukkit.Difficulty;
import org.bukkit.GameMode;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.WorldBorder;
import org.bukkit.block.Block;
import org.bukkit.block.BlockSupport;
import org.bukkit.block.BlockFace;
import org.bukkit.block.Chest;
import org.bukkit.entity.Player;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerAnimationEvent;
import org.bukkit.event.player.PlayerAnimationType;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.world.WorldLoadEvent;
import org.bukkit.generator.ChunkGenerator;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;
import com.destroystokyo.paper.event.server.ServerTickEndEvent;

public final class ArenaFoundationPlugin extends JavaPlugin implements Listener {
    private static final class CommandFailure extends RuntimeException {
        private final ControlProtocol.ErrorCode code;

        CommandFailure(ControlProtocol.ErrorCode code, String message) {
            super(message);
            this.code = code;
        }
    }

    private enum StartupMode {
        PLAN,
        TEST_FIXTURE
    }

    // Paper 26.1.2's default flat world surface is at Y -60.
    private static final int FLOOR_Y = -60;
    private static final int CHEST_X = 2;
    private static final int CHEST_Z = 0;
    private static final String ARENA_WORLD = "world";
    private static final String PLAN_GENERATOR_ID = "plan";
    private static final String TEST_FIXTURE_PROPERTY = "arena.test-fixture";
    private static final String CONTROL_PORT_PROPERTY = "arena.control-port";
    private static final String RUN_ID_PROPERTY = "arena.run-id";
    private static final String CONTROL_TOKEN_ENV = "ARENA_CONTROL_TOKEN";
    private final Set<UUID> reportedMovement = new HashSet<>();
    private final Map<Integer, UUID> playersBySeat = new HashMap<>();
    private final Map<UUID, Integer> seatsByPlayer = new HashMap<>();
    private final List<MatchController.Elimination> pendingEliminations = new ArrayList<>();
    private StartupMode startupMode;
    private MapPlan generationPlan;
    private ArenaChunkGenerator chunkGenerator;
    private ControlSession controlSession;
    private String runId;
    private int controlPort;
    private String controlToken;
    private ControlProtocol.PreparePayload preparedMatch;
    private MatchController matchController;
    private boolean skipMatchAdvanceThisTick;
    private boolean outcomeEmitted;
    private long lastHeartbeatNanos;
    private boolean generatorRequested;
    private boolean worldInitialized;

    @Override
    public void onLoad() {
        String planPath = System.getProperty(MapPlanReader.GENERATION_PLAN_PROPERTY);
        String fixtureMode = System.getProperty(TEST_FIXTURE_PROPERTY);
        String controlPort = System.getProperty(CONTROL_PORT_PROPERTY);
        String configuredRunId = System.getProperty(RUN_ID_PROPERTY);
        if (planPath != null && fixtureMode != null) {
            throw new IllegalStateException("configure either a staged world plan or test fixture mode, not both");
        }
        if (planPath != null) {
            startupMode = StartupMode.PLAN;
            try {
                generationPlan = MapPlanReader.readConfiguredPlan();
            } catch (IOException invalidPlan) {
                throw new IllegalStateException("could not load the staged world plan", invalidPlan);
            }
            if (controlPort == null || configuredRunId == null) {
                throw new IllegalStateException("runtime mode requires -D" + CONTROL_PORT_PROPERTY
                        + " and -D" + RUN_ID_PROPERTY);
            }
            runId = configuredRunId;
            if (!generationPlan.runId().equals(runId)) {
                throw new IllegalStateException("the configured run id does not match the staged world plan");
            }
            this.controlPort = parseControlPort(controlPort);
            controlToken = requireControlToken(System.getenv(CONTROL_TOKEN_ENV));
            return;
        }
        if ("true".equals(fixtureMode)) {
            if (controlPort != null || configuredRunId != null) {
                throw new IllegalStateException("test fixture mode cannot be combined with runtime control settings");
            }
            startupMode = StartupMode.TEST_FIXTURE;
            return;
        }
        if (fixtureMode != null) {
            throw new IllegalStateException("-D" + TEST_FIXTURE_PROPERTY + " must be exactly 'true'");
        }
        throw new IllegalStateException("configure -D" + MapPlanReader.GENERATION_PLAN_PROPERTY
                + " or the explicit smoke-only -D" + TEST_FIXTURE_PROPERTY + "=true");
    }

    @Override
    public ChunkGenerator getDefaultWorldGenerator(String worldName, String id) {
        if (!ARENA_WORLD.equals(worldName)) {
            return null;
        }
        if (startupMode != StartupMode.PLAN) {
            throw new IllegalStateException("the arena world generator requires a staged world plan");
        }
        if (!PLAN_GENERATOR_ID.equals(id)) {
            throw new IllegalArgumentException("the arena world generator id must be 'plan'");
        }
        if (chunkGenerator == null) {
            chunkGenerator = new ArenaChunkGenerator(generationPlan);
        }
        generatorRequested = true;
        return chunkGenerator;
    }

    @Override
    public void onEnable() {
        Bukkit.getPluginManager().registerEvents(this, this);
        if (startupMode == StartupMode.PLAN) {
            controlSession = new ControlSession(runId, controlPort, controlToken);
            controlSession.start();
        }
        World world = Bukkit.getWorld(ARENA_WORLD);
        if (world != null) {
            initializeWorld(world);
        }
    }

    @Override
    public void onDisable() {
        if (controlSession != null) {
            controlSession.close();
        }
    }

    @EventHandler
    public void onWorldLoad(WorldLoadEvent event) {
        if (ARENA_WORLD.equals(event.getWorld().getName())) {
            initializeWorld(event.getWorld());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onServerTickEnd(ServerTickEndEvent event) {
        if (startupMode != StartupMode.PLAN || controlSession == null) {
            return;
        }
        if (!Bukkit.isPrimaryThread()) {
            throw new IllegalStateException("arena control events must be handled on Paper's server thread");
        }
        if (controlSession.failure() != null) {
            getLogger().severe("Arena control lease failed; stopping the Paper server.");
            Bukkit.shutdown();
            return;
        }

        skipMatchAdvanceThisTick = false;
        ControlProtocol.Envelope command;
        while ((command = controlSession.poll()) != null) {
            handleControlCommand(command);
        }
        advanceMatchAtTickEnd();
        if (!outcomeEmitted) {
            long now = System.nanoTime();
            if (controlSession.isReady() && now - lastHeartbeatNanos >= 1_000_000_000L) {
                controlSession.sendEvent(ControlProtocol.Type.HEARTBEAT, new ControlProtocol.EmptyPayload());
                lastHeartbeatNanos = now;
            }
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent event) {
        if (startupMode == StartupMode.PLAN && isArenaWorld(event.getBlock().getWorld())
                && !isMatchRuleEnabled(true)) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockPlace(BlockPlaceEvent event) {
        if (startupMode == StartupMode.PLAN && isArenaWorld(event.getBlock().getWorld())
                && !isMatchRuleEnabled(false)) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGH)
    public void onPlayerDeath(PlayerDeathEvent event) {
        if (startupMode != StartupMode.PLAN || preparedMatch == null || matchController == null
                || preparedMatch.match().respawn() || !isRunningMatch()) {
            return;
        }
        Integer seat = seatsByPlayer.get(event.getEntity().getUniqueId());
        if (seat != null) {
            pendingEliminations.add(new MatchController.Elimination(seat, MatchController.EliminationCause.DEATH));
            event.getEntity().setGameMode(GameMode.SPECTATOR);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPlayerRespawn(PlayerRespawnEvent event) {
        if (startupMode == StartupMode.PLAN && preparedMatch != null && !preparedMatch.match().respawn()
                && seatsByPlayer.containsKey(event.getPlayer().getUniqueId())) {
            event.getPlayer().setGameMode(GameMode.SPECTATOR);
        }
    }

    private void handleControlCommand(ControlProtocol.Envelope command) {
        try {
            if (outcomeEmitted) {
                throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE, "the match control stream is terminal");
            }
            switch (command.type()) {
                case PREPARE -> {
                    prepareMatch((ControlProtocol.PreparePayload) command.payload());
                    controlSession.acknowledge(command.header().sequence());
                    publishClock();
                }
                case START -> {
                    requestMatchStart();
                    controlSession.acknowledge(command.header().sequence());
                    if (matchController.phase() != MatchController.Phase.WAITING) {
                        publishMatchStart();
                    } else {
                        publishClock();
                    }
                }
                case ABORT -> {
                    ControlProtocol.AbortReason reason = ((ControlProtocol.AbortPayload) command.payload()).reason();
                    ensureCanAbort();
                    controlSession.acknowledge(command.header().sequence());
                    abortMatch(reason);
                }
                default -> throw new IllegalStateException("control session delivered a non-command message");
            }
        } catch (CommandFailure invalidCommand) {
            controlSession.reject(command.header().sequence(), invalidCommand.code, invalidCommand.getMessage());
        }
    }

    private void prepareMatch(ControlProtocol.PreparePayload prepare) {
        if (!worldInitialized || startupMode != StartupMode.PLAN || matchController != null) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "prepare requires a ready, unused staged arena world");
        }
        if (!generationPlan.mapSemanticId().equals(prepare.mapSemanticId())) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "prepare does not identify the staged arena map");
        }
        if (prepare.roster().size() > generationPlan.spawns().size()) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "the staged map has no spawn point for every configured seat");
        }

        ControlProtocol.MatchSettings settings = prepare.match();
        ControlProtocol.BorderSettings border = prepare.border();
        MatchController.BorderSchedule schedule = new MatchController.BorderSchedule(
                border.initialDiameterBlocks(), border.shrinkStartTick(), border.shrinkEndTick(),
                border.finalDiameterBlocks());
        MatchController.Settings matchSettings = new MatchController.Settings(settings.countdownTicks(),
                settings.graceTicks(), settings.authoritativeMaxTicks(), schedule);
        MatchController controller = new MatchController(matchSettings, prepare.roster().size());

        World world = Bukkit.getWorld(ARENA_WORLD);
        if (world == null) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD, "the staged arena world is unavailable");
        }
        try {
            world.setGameRule(GameRule.DO_MOB_SPAWNING, settings.naturalMobs());
            world.setGameRule(GameRule.RANDOM_TICK_SPEED, settings.naturalRandomTicks() ? 3 : 0);
            WorldBorder worldBorder = world.getWorldBorder();
            MapPlan.Dimensions dimensions = generationPlan.dimensions();
            worldBorder.setCenter(dimensions.width() / 2.0, dimensions.depth() / 2.0);
            worldBorder.setSize(border.initialDiameterBlocks());
        } catch (IllegalArgumentException invalidWorldSetting) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "the staged arena world cannot apply the resolved match settings");
        }

        preparedMatch = prepare;
        matchController = controller;
        outcomeEmitted = false;
        pendingEliminations.clear();
        playersBySeat.clear();
        seatsByPlayer.clear();
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (!bindBotIfExpected(player)) {
                player.setGameMode(GameMode.SPECTATOR);
            }
        }
    }

    private void requestMatchStart() {
        if (matchController == null || preparedMatch == null
                || matchController.phase() != MatchController.Phase.WAITING) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "start requires one prepared match that has not started");
        }
        if (!allConfiguredBotsAreOnline()) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "every configured bot must join before start");
        }
        matchController.startCountdown();
        skipMatchAdvanceThisTick = true;
    }

    private void ensureCanAbort() {
        if (outcomeEmitted) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE, "the match is already terminal");
        }
    }

    private void handlePlanJoin(Player player) {
        if (!worldInitialized) {
            player.setGameMode(GameMode.SPECTATOR);
            return;
        }
        if (preparedMatch != null && matchController.phase() == MatchController.Phase.WAITING
                && bindBotIfExpected(player)) {
            return;
        }
        player.setGameMode(GameMode.SPECTATOR);
    }

    private boolean bindBotIfExpected(Player player) {
        if (preparedMatch == null || isRunningMatch()) {
            return false;
        }
        for (ControlProtocol.BotCompetitor bot : preparedMatch.roster()) {
            if (bot.offlineUuid().equals(player.getUniqueId()) && bot.username().equals(player.getName())) {
                UUID previous = playersBySeat.get(bot.seat());
                if (previous != null && !previous.equals(player.getUniqueId())) {
                    return false;
                }
                bindSeat(player, bot.seat());
                return true;
            }
        }
        return false;
    }

    private void bindSeat(Player player, int seat) {
        UUID previous = playersBySeat.putIfAbsent(seat, player.getUniqueId());
        if (previous != null && !previous.equals(player.getUniqueId())) {
            throw new IllegalStateException("a competitive seat cannot be reassigned while its owner is online");
        }
        Integer previousSeat = seatsByPlayer.putIfAbsent(player.getUniqueId(), seat);
        if (previousSeat != null && previousSeat != seat) {
            throw new IllegalStateException("a player cannot be bound to more than one competitive seat");
        }
        MapPlan.Position spawn = generationPlan.spawns().get(seat).position();
        player.setGameMode(GameMode.SURVIVAL);
        player.teleport(new Location(Bukkit.getWorld(ARENA_WORLD), spawn.x() + 0.5, spawn.y(), spawn.z() + 0.5));
    }

    private boolean allConfiguredBotsAreOnline() {
        for (ControlProtocol.BotCompetitor bot : preparedMatch.roster()) {
            if (!bot.offlineUuid().equals(playersBySeat.get(bot.seat()))
                    || Bukkit.getPlayer(bot.offlineUuid()) == null) {
                return false;
            }
        }
        return true;
    }

    private void publishMatchStart() {
        publishClock();
        if (matchController.matchTick().isPresent()) {
            publishPublicState(new ControlProtocol.Tick(ControlProtocol.TickDomain.MATCH,
                    matchController.matchTick().orElseThrow()));
        } else if (matchController.phase() == MatchController.Phase.COUNTDOWN) {
            publishPublicState(currentTick().orElseThrow());
        }
        if (matchController.outcome().isPresent()) {
            emitTerminalOutcome();
        }
    }

    private void advanceMatchAtTickEnd() {
        if (matchController == null || outcomeEmitted || skipMatchAdvanceThisTick || !isRunningMatch()) {
            return;
        }
        boolean countdownWasRunning = matchController.phase() == MatchController.Phase.COUNTDOWN;
        List<MatchController.ResolvedElimination> resolved = matchController.endServerTick(pendingEliminations);
        pendingEliminations.clear();
        if (!resolved.isEmpty()) {
            ControlProtocol.Tick at = controlTick(resolved.getFirst().at());
            List<ControlProtocol.Elimination> eliminations = resolved.stream()
                    .map(item -> new ControlProtocol.Elimination(item.seat(),
                            ControlProtocol.EliminationCause.valueOf(item.cause().name())))
                    .toList();
            controlSession.sendEvent(ControlProtocol.Type.ELIMINATION,
                    new ControlProtocol.EliminationPayload(at, eliminations));
            publishPublicState(at);
        }

        if (matchController.outcome().isPresent()) {
            applyCurrentBorder();
            publishClock();
            emitTerminalOutcome();
            return;
        }
        if (countdownWasRunning && matchController.matchTick().isPresent()) {
            publishPublicState(new ControlProtocol.Tick(ControlProtocol.TickDomain.MATCH,
                    matchController.matchTick().orElseThrow()));
        }
        applyCurrentBorder();
        publishClock();
    }

    private void publishClock() {
        if (matchController == null || preparedMatch == null || outcomeEmitted) {
            return;
        }
        ControlProtocol.Phase phase = ControlProtocol.Phase.valueOf(matchController.phase().name());
        controlSession.sendEvent(ControlProtocol.Type.PUBLIC_CLOCK,
                new ControlProtocol.ClockPayload(phase, currentTick(), currentBorderDiameter()));
    }

    private Optional<ControlProtocol.Tick> currentTick() {
        if (matchController == null) {
            return Optional.empty();
        }
        return switch (matchController.phase()) {
            case WAITING -> Optional.empty();
            case COUNTDOWN -> Optional.of(new ControlProtocol.Tick(ControlProtocol.TickDomain.COUNTDOWN,
                    preparedMatch.match().countdownTicks().subtract(matchController.countdownRemaining())));
            case GRACE, ACTIVE -> matchController.matchTick().map(value ->
                    new ControlProtocol.Tick(ControlProtocol.TickDomain.MATCH, value));
            case FINISHED, ABORTED -> matchController.outcome().orElseThrow().resolutionTick()
                    .map(ArenaFoundationPlugin::controlTick);
        };
    }

    private double currentBorderDiameter() {
        World world = Bukkit.getWorld(ARENA_WORLD);
        if (matchController != null && matchController.matchTick().isPresent()) {
            return matchController.borderDiameterBlocks();
        }
        if (preparedMatch != null) {
            return preparedMatch.border().initialDiameterBlocks();
        }
        return world.getWorldBorder().getSize();
    }

    private void applyCurrentBorder() {
        World world = Bukkit.getWorld(ARENA_WORLD);
        double diameter = matchController.borderDiameterBlocks();
        if (Double.compare(world.getWorldBorder().getSize(), diameter) != 0) {
            world.getWorldBorder().setSize(diameter);
        }
    }

    private void publishPublicState(ControlProtocol.Tick at) {
        controlSession.sendEvent(ControlProtocol.Type.PUBLIC_STATE,
                new ControlProtocol.PublicStatePayload(at, matchController.aliveSeats()));
    }

    private void emitTerminalOutcome() {
        if (outcomeEmitted || matchController == null) {
            return;
        }
        MatchController.Outcome outcome = matchController.outcome().orElseThrow();
        ControlProtocol.Outcome controlOutcome;
        if (outcome instanceof MatchController.Winner winner) {
            controlOutcome = new ControlProtocol.WinnerOutcome(winner.seat(), winner.survivors(), controlTick(winner.at()));
        } else if (outcome instanceof MatchController.Draw draw) {
            controlOutcome = new ControlProtocol.DrawOutcome(ControlProtocol.DrawReason.valueOf(draw.reason().name()),
                    draw.survivors(), controlTick(draw.at()));
        } else if (outcome instanceof MatchController.Aborted aborted) {
            controlOutcome = new ControlProtocol.AbortOutcome(
                    ControlProtocol.AbortReason.valueOf(aborted.reason().name()), aborted.survivors(),
                    aborted.at().map(ArenaFoundationPlugin::controlTick));
        } else {
            throw new IllegalStateException("match controller returned an unknown outcome");
        }
        controlSession.sendEvent(ControlProtocol.Type.OUTCOME, controlOutcome);
        outcomeEmitted = true;
    }

    private static ControlProtocol.Tick controlTick(MatchController.ResolutionTick tick) {
        if (tick instanceof MatchController.CountdownTick countdown) {
            return new ControlProtocol.Tick(ControlProtocol.TickDomain.COUNTDOWN, countdown.value());
        }
        MatchController.MatchTick match = (MatchController.MatchTick) tick;
        return new ControlProtocol.Tick(ControlProtocol.TickDomain.MATCH, match.value());
    }

    private void abortMatch(ControlProtocol.AbortReason reason) {
        if (matchController == null) {
            controlSession.sendEvent(ControlProtocol.Type.OUTCOME,
                    new ControlProtocol.AbortOutcome(reason, List.of(), Optional.empty()));
            outcomeEmitted = true;
            return;
        }
        matchController.abort(MatchController.AbortReason.valueOf(reason.name()));
        applyCurrentBorder();
        publishClock();
        emitTerminalOutcome();
    }

    private boolean isRunningMatch() {
        if (matchController == null) {
            return false;
        }
        return matchController.phase() == MatchController.Phase.COUNTDOWN
                || matchController.phase() == MatchController.Phase.GRACE
                || matchController.phase() == MatchController.Phase.ACTIVE;
    }

    private boolean isMatchRuleEnabled(boolean breaking) {
        if (startupMode != StartupMode.PLAN || preparedMatch == null || !isRunningMatch()) {
            return false;
        }
        return breaking ? preparedMatch.match().blockBreaking() : preparedMatch.match().blockPlacing();
    }

    private static boolean isArenaWorld(World world) {
        return ARENA_WORLD.equals(world.getName());
    }

    private static int parseControlPort(String portValue) {
        try {
            int port = Integer.parseInt(portValue);
            if (port < 1 || port > 65_535) {
                throw new NumberFormatException("out of range");
            }
            return port;
        } catch (NumberFormatException invalidPort) {
            throw new IllegalStateException("-D" + CONTROL_PORT_PROPERTY + " must be between 1 and 65535");
        }
    }

    private static String requireControlToken(String token) {
        if (token == null || token.length() > 256) {
            throw new IllegalStateException(CONTROL_TOKEN_ENV + " must contain at least 32 random bytes in base64url");
        }
        try {
            byte[] decoded = Base64.getUrlDecoder().decode(token);
            if (decoded.length < 32 || !Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(token)) {
                throw new IllegalStateException(CONTROL_TOKEN_ENV + " must contain at least 32 random bytes in base64url");
            }
        } catch (IllegalArgumentException invalidToken) {
            throw new IllegalStateException(CONTROL_TOKEN_ENV + " must contain at least 32 random bytes in base64url");
        }
        return token;
    }

    private void initializeWorld(World world) {
        if (worldInitialized) {
            return;
        }
        if (!Bukkit.isPrimaryThread()) {
            throw new IllegalStateException("arena world setup must run on Paper's server thread");
        }

        int preparedChunks = 0;
        if (startupMode == StartupMode.TEST_FIXTURE) {
            // The fixture is available only when the runner explicitly selects smoke-test mode.
            createStackSmokeFixture(world);
        } else {
            if (!generatorRequested) {
                throw new IllegalStateException(
                        "the staged world plan is loaded, but Paper did not request the arena generator; "
                                + "configure world as ArenaFoundation:plan");
            }
            preparedChunks = prepareMapWorld(world);
        }

        worldInitialized = true;
        if (startupMode == StartupMode.PLAN) {
            getLogger().info("ARENA_MAP_READY|run_id=" + generationPlan.runId()
                    + "|map_semantic_id=" + generationPlan.mapSemanticId()
                    + "|prepared_chunks=" + preparedChunks);
            controlSession.publishReady(new ControlProtocol.ReadyPayload(
                    new ControlProtocol.ServerIdentity(Bukkit.getName(), Bukkit.getVersion(),
                            Bukkit.getMinecraftVersion(), Bukkit.getUnsafe().getProtocolVersion()),
                    new ControlProtocol.PluginIdentity(getPluginMeta().getName(), getPluginMeta().getVersion()),
                    ControlProtocol.Capability.SUPPORTED));
        }
        getLogger().info("ARENA_READY|protocol=775|port=" + Bukkit.getServer().getPort());
    }

    private int prepareMapWorld(World world) {
        MapPlan.Dimensions dimensions = generationPlan.dimensions();
        if (dimensions.minY() < world.getMinHeight() || dimensions.maxY() >= world.getMaxHeight()) {
            throw new IllegalStateException("world-plan vertical bounds do not fit the arena world's build height");
        }

        List<MapPlan.ChunkPosition> chunks = generationPlan.chunksWithViewHalo(world.getViewDistance());
        for (MapPlan.ChunkPosition chunk : chunks) {
            world.getChunkAt(chunk.x(), chunk.z());
        }

        validateGeneratedMap(world);

        for (MapPlan.LootContainer container : generationPlan.lootContainers()) {
            MapPlan.Position position = container.position();
            Block block = world.getBlockAt(position.x(), position.y(), position.z());
            if (!(block.getState() instanceof Chest chest)) {
                throw new IllegalStateException("world-plan loot position did not generate a chest");
            }
            Inventory inventory = chest.getBlockInventory();
            inventory.clear();
            for (int slot = 0; slot < container.inventory().size(); slot++) {
                Material item = ArenaChunkGenerator.requireItemMaterial(container.inventory().get(slot));
                inventory.setItem(slot, new ItemStack(item));
            }
        }

        MapPlan.Position firstSpawn = generationPlan.spawns().getFirst().position();
        validateRuntimeSpawns(world);
        world.setSpawnLocation(firstSpawn.x(), firstSpawn.y(), firstSpawn.z());
        return chunks.size();
    }

    private void validateGeneratedMap(World world) {
        for (MapPlan.BlockPlacement placement : generationPlan.blocks()) {
            MapPlan.Position position = placement.position();
            Block block = world.getBlockAt(position.x(), position.y(), position.z());
            if (!placement.material().equals(block.getType().getKey().toString())) {
                throw new IllegalStateException("generated world block does not match the staged map plan at "
                        + position.x() + "," + position.y() + "," + position.z());
            }
        }
    }

    private void validateRuntimeSpawns(World world) {
        for (MapPlan.SpawnPoint spawn : generationPlan.spawns()) {
            MapPlan.Position position = spawn.position();
            Block support = world.getBlockAt(position.x(), position.y() - 1, position.z());
            Block feet = world.getBlockAt(position.x(), position.y(), position.z());
            Block head = world.getBlockAt(position.x(), position.y() + 1, position.z());
            if (!ArenaChunkGenerator.isSafeSpawnSupport(support.getType()) || support.isLiquid()
                    || !support.getBlockData().isFaceSturdy(BlockFace.UP, BlockSupport.CENTER)
                    || !feet.isPassable() || feet.isLiquid() || !head.isPassable() || head.isLiquid()) {
                throw new IllegalStateException("generated world has an unsafe spawn position for seat " + spawn.seat());
            }
        }
    }

    private void createStackSmokeFixture(World world) {
        world.setDifficulty(Difficulty.EASY);
        world.setTime(1000);
        world.setStorm(false);
        world.setThundering(false);
        // Keep fixture clients at the declared spawn; server.properties does not control this world rule.
        world.setGameRule(GameRule.SPAWN_RADIUS, 0);
        world.setSpawnLocation(0, FLOOR_Y + 1, 0);

        for (int x = -4; x <= 4; x++) {
            for (int z = -4; z <= 4; z++) {
                Block floor = world.getBlockAt(x, FLOOR_Y, z);
                floor.setType(Material.STONE, false);
                world.getBlockAt(x, FLOOR_Y + 1, z).setType(Material.AIR, false);
                world.getBlockAt(x, FLOOR_Y + 2, z).setType(Material.AIR, false);
            }
        }

        Block chestBlock = world.getBlockAt(CHEST_X, FLOOR_Y + 1, CHEST_Z);
        chestBlock.setType(Material.CHEST, false);
        if (!(chestBlock.getState() instanceof Chest chest)) {
            throw new IllegalStateException("fixture chest did not create a chest state");
        }
        chest.getBlockInventory().clear();
        chest.getBlockInventory().setItem(0, new ItemStack(Material.DIAMOND, 2));
    }

    @EventHandler(priority = EventPriority.HIGH)
    public void onJoin(PlayerJoinEvent event) {
        getLogger().info("ARENA_JOIN|" + event.getPlayer().getName());
        if (startupMode == StartupMode.PLAN) {
            handlePlanJoin(event.getPlayer());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onMove(PlayerMoveEvent event) {
        if (event.getTo() == null || event.getFrom().distanceSquared(event.getTo()) < 0.01) {
            return;
        }
        if (reportedMovement.add(event.getPlayer().getUniqueId())) {
            getLogger().info("ARENA_MOVE|" + event.getPlayer().getName());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onInventoryOpen(InventoryOpenEvent event) {
        if (event.getPlayer() instanceof Player player && isArenaChest(event.getInventory())) {
            getLogger().info("ARENA_CHEST_OPEN|" + player.getName());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onInventoryClick(InventoryClickEvent event) {
        Inventory top = event.getView().getTopInventory();
        if (!(event.getWhoClicked() instanceof Player player)
                || !isArenaChest(top)
                || event.getClickedInventory() != top) {
            return;
        }

        getLogger().info("ARENA_CHEST_CLICK|" + player.getName() + "|" + event.getRawSlot());
        Bukkit.getScheduler().runTaskLater(this, () -> {
            int diamonds = count(player.getInventory(), Material.DIAMOND);
            if (diamonds > 0) {
                getLogger().info("ARENA_TRANSFER|" + player.getName() + "|diamonds=" + diamonds);
            }
        }, 2L);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlayerDamage(EntityDamageByEntityEvent event) {
        if (event.getDamager() instanceof Player attacker
                && event.getEntity() instanceof Player victim) {
            getLogger().info("ARENA_DAMAGE_ATTEMPT|" + attacker.getName() + "|" + victim.getName()
                    + "|cancelled=" + event.isCancelled() + "|amount=" + event.getFinalDamage());
            if (!event.isCancelled() && event.getFinalDamage() > 0.0) {
                getLogger().info("ARENA_DAMAGE|" + attacker.getName() + "|" + victim.getName()
                        + "|amount=" + event.getFinalDamage());
            }
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onAnimation(PlayerAnimationEvent event) {
        if (event.getAnimationType() == PlayerAnimationType.ARM_SWING) {
            getLogger().info("ARENA_SWING|" + event.getPlayer().getName());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        getLogger().info("ARENA_QUIT|" + event.getPlayer().getName());
        if (startupMode != StartupMode.PLAN) {
            return;
        }
        UUID playerId = event.getPlayer().getUniqueId();
        Integer seat = seatsByPlayer.get(playerId);
        if (seat == null) {
            return;
        }
        if (matchController != null && isRunningMatch()) {
            pendingEliminations.add(new MatchController.Elimination(
                    seat, MatchController.EliminationCause.DISCONNECT));
            return;
        }
        seatsByPlayer.remove(playerId);
        playersBySeat.remove(seat);
    }

    private boolean isArenaChest(Inventory inventory) {
        Location location = inventory.getLocation();
        if (location == null || location.getWorld() == null
                || !ARENA_WORLD.equals(location.getWorld().getName())
                || location.getBlock().getType() != Material.CHEST) {
            return false;
        }
        if (startupMode == StartupMode.TEST_FIXTURE) {
            return location.getBlockX() == CHEST_X
                    && location.getBlockY() == FLOOR_Y + 1
                    && location.getBlockZ() == CHEST_Z;
        }
        for (MapPlan.LootContainer container : generationPlan.lootContainers()) {
            MapPlan.Position position = container.position();
            if (position.x() == location.getBlockX()
                    && position.y() == location.getBlockY()
                    && position.z() == location.getBlockZ()) {
                return true;
            }
        }
        return false;
    }

    private static int count(Inventory inventory, Material material) {
        int total = 0;
        for (ItemStack item : inventory.getStorageContents()) {
            if (item != null && item.getType() == material) {
                total += item.getAmount();
            }
        }
        return total;
    }
}
