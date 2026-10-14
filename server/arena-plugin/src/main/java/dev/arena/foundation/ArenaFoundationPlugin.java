package dev.arena.foundation;

import java.io.IOException;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Base64;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.logging.Level;
import io.papermc.paper.event.player.PlayerFailMoveEvent;
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
import org.bukkit.entity.Projectile;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Item;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerAnimationEvent;
import org.bukkit.event.player.PlayerAnimationType;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerItemConsumeEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerSwapHandItemsEvent;
import org.bukkit.event.world.WorldLoadEvent;
import org.bukkit.generator.ChunkGenerator;
import org.bukkit.inventory.CraftingInventory;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.util.Vector;
import org.bukkit.plugin.java.JavaPlugin;
import com.destroystokyo.paper.event.server.ServerTickEndEvent;

public final class ArenaFoundationPlugin extends JavaPlugin implements Listener {
    private static final class CommandFailure extends RuntimeException {
        private final ControlProtocol.ErrorCode code;

        CommandFailure(ControlProtocol.ErrorCode code, String message) {
            super(message);
            this.code = code;
        }

        CommandFailure(ControlProtocol.ErrorCode code, String message, Throwable cause) {
            super(message, cause);
            this.code = code;
        }
    }

    private enum StartupMode {
        PLAN,
        TEST_FIXTURE
    }

    enum BlockAction {
        BREAK,
        PLACE
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
    private static final String MOVEMENT_DIAGNOSTICS_PROPERTY = "arena.movement-diagnostics";
    private final Set<UUID> reportedMovement = new HashSet<>();
    private final Set<MapPlan.Position> dirtyOakPlankPositions = new HashSet<>();
    private final Set<MapPlan.Position> placedOakPlankPositions = new HashSet<>();
    private final Map<Integer, UUID> playersBySeat = new HashMap<>();
    private final Map<UUID, Integer> seatsByPlayer = new HashMap<>();
    private FrontierEdits frontierEdits;
    private ControlProtocol.SquadsRules squadRules;
    private final List<MatchController.Elimination> pendingEliminations = new ArrayList<>();
    private final List<MatchController.ResolvedElimination> civilizationCountdownEliminations = new ArrayList<>();
    private final Map<ControlProtocol.FactionId, Boolean> outpostCompletion = new EnumMap<>(ControlProtocol.FactionId.class);
    private StartupMode startupMode;
    private WorldPlan generationPlan;
    private List<MapPlan.SpawnPoint> resolvedSpawns = List.of();
    private List<MapPlan.LootContainer> resolvedLootContainers = List.of();
    private ArenaChunkGenerator chunkGenerator;
    private ControlSession controlSession;
    private String runId;
    private int controlPort;
    private String controlToken;
    private ControlProtocol.PreparePayload preparedMatch;
    private MatchController matchController;
    private CivilizationMatchController civilizationMatchController;
    private CivilizationMaterialCensus.Recorder civilizationMaterialCensus;
    private List<MapPlan.ChunkPosition> civilizationMaterialCensusMapChunks = List.of();
    private List<MapPlan.Position> initialNaturalOakLogPositions = List.of();
    private MovementFailureDiagnostics movementFailureDiagnostics;
    private boolean skipMatchAdvanceThisTick;
    private boolean outcomeEmitted;
    private long lastHeartbeatNanos;
    private boolean generatorRequested;
    private boolean worldInitialized;
    private boolean civilizationEvaluatorEnabled;
    private static final String RESUME_CHECKPOINT_PROPERTY = "arena.resume-checkpoint";
    private CheckpointRecord.Stored loadedCheckpoint;
    private ResumeSession resumeSession;
    private boolean resumeAwaitingStart;
    private int runtimeEpoch;
    private boolean quiesced;
    private ControlProtocol.CheckpointCommand pendingCheckpoint;
    private BigInteger pendingCheckpointSequence;
    private String naturalWorldIdentity;
    private CheckpointExtension checkpointExtension;
    private final List<CheckpointRecord.Elimination> eliminationLog = new ArrayList<>();
    private final DamageAccumulator damageAccumulator = new DamageAccumulator();

    @Override
    public void onLoad() {
        civilizationEvaluatorEnabled = CivilizationMaterialCensus.enabledFromProperty(
                System.getProperty(CivilizationMaterialCensus.PROPERTY));
        movementFailureDiagnostics = MovementFailureDiagnostics.fromProperty(
                System.getProperty(MOVEMENT_DIAGNOSTICS_PROPERTY));
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
            String resumePath = System.getProperty(RESUME_CHECKPOINT_PROPERTY);
            if (resumePath != null) {
                try {
                    loadedCheckpoint = CheckpointRecord.read(java.nio.file.Path.of(resumePath));
                } catch (IOException incompleteCheckpoint) {
                    throw new IllegalStateException("could not load a complete checkpoint to resume", incompleteCheckpoint);
                }
                runtimeEpoch = loadedCheckpoint.record().epoch() + 1;
            }
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
        if (generationPlan instanceof NaturalMapPlan) {
            return null;
        }
        if (!PLAN_GENERATOR_ID.equals(id)) {
            throw new IllegalArgumentException("the arena world generator id must be 'plan'");
        }
        if (chunkGenerator == null) {
            chunkGenerator = new ArenaChunkGenerator(requirePlannedPlan());
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

        try {
            skipMatchAdvanceThisTick = false;
            ControlProtocol.Envelope command;
            while ((command = controlSession.poll()) != null) {
                handleControlCommand(command);
            }
            advanceMatchAtTickEnd();
            if (pendingCheckpoint != null) {
                completeCheckpoint();
            }
            if (!outcomeEmitted) {
                long now = System.nanoTime();
                if (controlSession.isReady() && now - lastHeartbeatNanos >= 1_000_000_000L) {
                    controlSession.sendEvent(ControlProtocol.Type.HEARTBEAT, new ControlProtocol.EmptyPayload());
                    lastHeartbeatNanos = now;
                }
            }
        } catch (RuntimeException failure) {
            if (civilizationMaterialCensus == null) {
                throw failure;
            }
            failCivilizationEvaluatorRun(failure);
        }
    }

    private boolean frontierEditDenied(Player player, Block block) {
        if (frontierEdits == null) {
            return false;
        }
        Integer seat = seatsByPlayer.get(player.getUniqueId());
        if (seat == null || matchController == null
                || !matchController.aliveSeats().contains(seat)) {
            return true;
        }
        return frontierEdits.tryEdit(seat, new MapPlan.Position(block.getX(), block.getY(), block.getZ()))
                != FrontierEdits.Verdict.ALLOWED;
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent event) {
        if (startupMode == StartupMode.PLAN && isArenaWorld(event.getBlock().getWorld())
                && !isMatchRuleEnabled(BlockAction.BREAK)) {
            event.setCancelled(true);
            return;
        }
        if (startupMode == StartupMode.PLAN && isArenaWorld(event.getBlock().getWorld())
                && frontierEditDenied(event.getPlayer(), event.getBlock())) {
            event.setCancelled(true);
            return;
        }
        if (civilizationMaterialCensus != null && isArenaWorld(event.getBlock().getWorld())
                && event.getBlock().getType() == Material.OAK_PLANKS) {
            dirtyOakPlankPositions.add(materialPosition(event.getBlock().getX(), event.getBlock().getY(),
                    event.getBlock().getZ()));
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockPlace(BlockPlaceEvent event) {
        if (startupMode == StartupMode.PLAN && isArenaWorld(event.getBlock().getWorld())
                && !isMatchRuleEnabled(BlockAction.PLACE)) {
            event.setCancelled(true);
            return;
        }
        if (startupMode == StartupMode.PLAN && isArenaWorld(event.getBlock().getWorld())
                && frontierEditDenied(event.getPlayer(), event.getBlockPlaced())) {
            event.setCancelled(true);
            return;
        }
        if (civilizationMaterialCensus != null && isArenaWorld(event.getBlock().getWorld())
                && event.getBlockPlaced().getType() == Material.OAK_PLANKS) {
            dirtyOakPlankPositions.add(materialPosition(event.getBlockPlaced().getX(), event.getBlockPlaced().getY(),
                    event.getBlockPlaced().getZ()));
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseDamage(EntityDamageEvent event) {
        if (event.getEntity() instanceof Player victim && isPreReleaseCompetitor(victim)) {
            event.setCancelled(true);
            return;
        }
        if (!(event instanceof EntityDamageByEntityEvent byEntity)) {
            return;
        }
        if (isPreReleaseDamageSource(byEntity.getDamager())) {
            event.setCancelled(true);
            return;
        }
        if (event.getEntity() instanceof Player victim
                && matchController != null
                && !matchController.phase().allowsCompetitorPvp()
                && isArenaCompetitor(victim)
                && isArenaCompetitorDamageSource(byEntity.getDamager())) {
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

    @EventHandler(priority = EventPriority.MONITOR)
    public void recordCivilizationDeathCargo(PlayerDeathEvent event) {
        if (civilizationMaterialCensus == null || startupMode != StartupMode.PLAN || preparedMatch == null
                || matchController == null || preparedMatch.match().respawn() || !isRunningMatch()) {
            return;
        }
        Integer seat = seatsByPlayer.get(event.getEntity().getUniqueId());
        if (seat == null) {
            return;
        }
        try {
            BigInteger matchTick = matchController.matchTick().orElseThrow(() ->
                    new IllegalStateException("material census death occurred before match tick zero"));
            civilizationMaterialCensus.deathCargo(matchTick, seat,
                    playerMaterialStacks(event.getEntity()), itemMaterialStacks(event.getDrops()));
        } catch (RuntimeException failure) {
            failCivilizationEvaluatorRun(failure);
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
                case CHECKPOINT -> {
                    ControlProtocol.CheckpointCommand checkpoint =
                            (ControlProtocol.CheckpointCommand) command.payload();
                    requireCheckpointAllowed(checkpoint);
                    controlSession.acknowledge(command.header().sequence());
                    pendingCheckpoint = checkpoint;
                    pendingCheckpointSequence = command.header().sequence();
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

    private void requireResumeMatchesCheckpoint(ControlProtocol.PreparePayload prepare) {
        if (loadedCheckpoint == null) {
            if (prepare.resume().isPresent()) {
                throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                        "resume prepare requires a server started with a checkpoint");
            }
            return;
        }
        CheckpointRecord record = loadedCheckpoint.record();
        ControlProtocol.ResumeReference reference = prepare.resume().orElseThrow(() -> new CommandFailure(
                ControlProtocol.ErrorCode.INVALID_STATE,
                "a server started with a checkpoint accepts only a resume prepare"));
        if (!reference.digest().equals(loadedCheckpoint.digest()) || reference.epoch() != runtimeEpoch) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "resume digest or runtime epoch does not match the loaded checkpoint");
        }
        ControlProtocol.PreparePayload withoutResume = new ControlProtocol.PreparePayload(
                prepare.mapSemanticId(), prepare.scenarioSemanticId(), prepare.seed(), prepare.settings(),
                prepare.rosterVersion(), prepare.rules(), Optional.empty(), prepare.roster());
        if (!ControlProtocol.payloadValue(withoutResume).equals(ControlProtocol.payloadValue(record.prepare()))) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "resume prepare does not match the checkpointed match configuration");
        }
    }

    private void requireRosterMatchesPlan(ControlProtocol.PreparePayload prepare) {
        boolean generalizedPlan = generationPlan instanceof NaturalMapPlan natural
                && natural.schemaVersion() == NaturalMapPlan.SCHEMA_VERSION_GENERALIZED_ROSTER;
        boolean generalizedPrepare = prepare.rosterVersion() == ControlProtocol.RosterVersion.GENERALIZED;
        if (generalizedPlan != generalizedPrepare) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "prepare roster version does not match the staged world-plan schema");
        }
        if (!generalizedPlan) {
            return;
        }
        List<NaturalMapPlan.RosterSeat> planned = ((NaturalMapPlan) generationPlan).roster();
        boolean matches = planned.size() == prepare.roster().size();
        for (int index = 0; matches && index < planned.size(); index++) {
            NaturalMapPlan.RosterSeat seat = planned.get(index);
            ControlProtocol.Competitor competitor = prepare.roster().get(index);
            matches = seat.seat() == competitor.seat() && seat.kind() == competitor.kind()
                    && (seat.kind() == ControllerKind.BOT || seat.username().equals(competitor.username()));
        }
        if (!matches) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "prepare roster does not match the staged world-plan roster");
        }
    }

    private void prepareMatch(ControlProtocol.PreparePayload prepare) {
        if (!worldInitialized || startupMode != StartupMode.PLAN || matchController != null) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "prepare requires a ready, unused staged arena world");
        }
        if (civilizationEvaluatorEnabled
                && !(prepare.settings() instanceof ControlProtocol.CivilizationPrepareSettings)) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "civilization material census requires a civilization match");
        }
        if (prepare.settings() instanceof ControlProtocol.CivilizationPrepareSettings
                && !(generationPlan instanceof MapPlan)) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "civilization matches require a planned-block world plan");
        }
        if (!generationPlan.mapSemanticId().equals(prepare.mapSemanticId())) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "prepare does not identify the staged arena map");
        }
        requireRosterMatchesPlan(prepare);
        if (generationPlan instanceof NaturalMapPlan natural
                && natural.schemaVersion() == NaturalMapPlan.SCHEMA_VERSION_GENERALIZED_ROSTER
                && prepare.settings() instanceof ControlProtocol.HungerGamesPrepareSettings) {
            NaturalMapPlan.BorderCenter center = natural.borderCenter();
            double radius = prepare.initialBorderDiameterBlocks() / 2.0;
            for (MapPlan.SpawnPoint spawn : resolvedSpawns) {
                double dx = spawn.position().x() + 0.5 - center.x();
                double dz = spawn.position().z() + 0.5 - center.z();
                if (dx * dx + dz * dz > radius * radius) {
                    throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                            "searched spawn for seat " + spawn.seat() + " at " + spawn.position()
                                    + " lies outside the initial border");
                }
            }
        }
        if (prepare.roster().size() > resolvedSpawns.size()) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "the staged map has no spawn point for every configured seat");
        }

        ControlProtocol.MatchSettings settings = prepare.match();
        MatchController.BorderPolicy borderPolicy;
        MatchController.OutcomeAuthority outcomeAuthority;
        CivilizationMatchController nextCivilizationController = null;
        List<MapPlan.Position> nextNaturalOakLogPositions = List.of();
        List<MapPlan.ChunkPosition> nextCivilizationMaterialCensusMapChunks = List.of();
        if (prepare.settings() instanceof ControlProtocol.HungerGamesPrepareSettings hungerGames) {
            ControlProtocol.BorderSettings border = hungerGames.border();
            borderPolicy = new MatchController.BorderSchedule(
                    border.initialDiameterBlocks(), border.shrinkStartTick(), border.shrinkEndTick(),
                    border.finalDiameterBlocks());
            outcomeAuthority = MatchController.OutcomeAuthority.LAST_SURVIVOR;
        } else {
            MapPlan plannedPlan = requirePlannedPlan();
            ControlProtocol.CivilizationPrepareSettings civilization =
                    (ControlProtocol.CivilizationPrepareSettings) prepare.settings();
            try {
                CivilizationWorldRules.validateGeometry(civilization.civilization(), plannedPlan.dimensions(),
                        resolvedSpawns);
            } catch (IllegalArgumentException invalidObjectives) {
                throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                        "civilization objectives do not fit the staged map", invalidObjectives);
            }
            if (civilizationEvaluatorEnabled) {
                nextNaturalOakLogPositions = plannedPlan.blocks().stream()
                        .filter(block -> block.material().equals(Material.OAK_LOG.getKey().toString()))
                        .map(MapPlan.BlockPlacement::position)
                        .toList();
                if (nextNaturalOakLogPositions.isEmpty()) {
                    throw new IllegalStateException("civilization material census requires planned natural oak logs");
                }
                nextCivilizationMaterialCensusMapChunks = plannedPlan.chunksWithViewHalo(0);
            }
            borderPolicy = new MatchController.FixedBorder(civilization.border().diameterBlocks());
            outcomeAuthority = MatchController.OutcomeAuthority.EXTERNAL;
            nextCivilizationController = new CivilizationMatchController();
        }
        MatchController.Settings matchSettings = new MatchController.Settings(settings.countdownTicks(),
                settings.graceTicks(), settings.authoritativeMaxTicks(), borderPolicy);
        requireResumeMatchesCheckpoint(prepare);
        MatchController controller = loadedCheckpoint == null
                ? new MatchController(matchSettings, prepare.roster().size(), outcomeAuthority)
                : MatchController.resumed(matchSettings, prepare.roster().size(),
                        loadedCheckpoint.record().matchTick(),
                        loadedCheckpoint.record().seats().stream()
                                .filter(CheckpointRecord.SeatState::alive)
                                .map(CheckpointRecord.SeatState::seat).toList());

        World world = Bukkit.getWorld(ARENA_WORLD);
        if (world == null) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD, "the staged arena world is unavailable");
        }
        try {
            world.setGameRule(GameRule.DO_MOB_SPAWNING, settings.naturalMobs());
            world.setGameRule(GameRule.RANDOM_TICK_SPEED, settings.naturalRandomTicks() ? 3 : 0);
            WorldBorder worldBorder = world.getWorldBorder();
            WorldPlan.Footprint dimensions = generationPlan.footprint();
            if (generationPlan instanceof NaturalMapPlan naturalPlan) {
                NaturalMapPlan.BorderCenter center = naturalPlan.borderCenter();
                worldBorder.setCenter(center.x(), center.z());
            } else {
                worldBorder.setCenter(dimensions.width() / 2.0, dimensions.depth() / 2.0);
            }
            worldBorder.setSize(prepare.initialBorderDiameterBlocks());
        } catch (IllegalArgumentException invalidWorldSetting) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_WORLD,
                    "the staged arena world cannot apply the resolved match settings");
        }

        preparedMatch = prepare;
        matchController = controller;
        eliminationLog.clear();
        resumeSession = null;
        resumeAwaitingStart = false;
        if (loadedCheckpoint != null) {
            resumeSession = new ResumeSession(loadedCheckpoint.record(), runtimeEpoch);
            resumeAwaitingStart = true;
            eliminationLog.addAll(loadedCheckpoint.record().eliminations());
            if (checkpointExtension != null) {
                checkpointExtension.restore(loadedCheckpoint.record().extension());
            }
        }
        civilizationMatchController = nextCivilizationController;
        civilizationMaterialCensus = civilizationEvaluatorEnabled
                ? new CivilizationMaterialCensus.Recorder(runId, marker -> getLogger().info(marker))
                : null;
        civilizationMaterialCensusMapChunks = nextCivilizationMaterialCensusMapChunks;
        initialNaturalOakLogPositions = nextNaturalOakLogPositions;
        dirtyOakPlankPositions.clear();
        placedOakPlankPositions.clear();
        outpostCompletion.clear();
        if (nextCivilizationController != null) {
            outpostCompletion.put(ControlProtocol.FactionId.EMBER, false);
            outpostCompletion.put(ControlProtocol.FactionId.TIDE, false);
        }
        outcomeEmitted = false;
        pendingEliminations.clear();
        civilizationCountdownEliminations.clear();
        playersBySeat.clear();
        seatsByPlayer.clear();
        frontierEdits = null;
        squadRules = null;
        if (preparedMatch.rules().isPresent()) {
            ControlProtocol.PrepareRules rules = preparedMatch.rules().get();
            if (rules instanceof ControlProtocol.FrontierSurvivalRules frontier) {
                NaturalMapPlan natural = (NaturalMapPlan) generationPlan;
                frontierEdits = new FrontierEdits(natural.borderCenter(), frontier,
                        resolvedLootContainers.stream().map(MapPlan.LootContainer::position)
                                .collect(java.util.stream.Collectors.toSet()));
            } else {
                squadRules = (ControlProtocol.SquadsRules) rules;
            }
        }
        for (Player player : new ArrayList<>(Bukkit.getOnlinePlayers())) {
            admitPlanJoin(player);
        }
    }

    private void requestMatchStart() {
        if (resumeAwaitingStart) {
            if (!resumeSession.allLivingSeatsRestored()) {
                throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                        "every living checkpoint seat must rejoin before the resumed match continues");
            }
            resumeAwaitingStart = false;
            for (UUID playerId : seatsByPlayer.keySet()) {
                Player player = Bukkit.getPlayer(playerId);
                if (player != null) {
                    player.setInvulnerable(false);
                }
            }
            skipMatchAdvanceThisTick = true;
            return;
        }
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
        recordInitialCivilizationMaterialCheckpointIfReleased();
        skipMatchAdvanceThisTick = true;
    }

    private void requireCheckpointAllowed(ControlProtocol.CheckpointCommand checkpoint) {
        if (preparedMatch == null || matchController == null
                || preparedMatch.rosterVersion() != ControlProtocol.RosterVersion.GENERALIZED
                || preparedMatch.settings() instanceof ControlProtocol.CivilizationPrepareSettings) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "checkpoint requires a prepared generalized-roster Hunger Games match");
        }
        MatchController.Phase phase = matchController.phase();
        if ((phase != MatchController.Phase.GRACE && phase != MatchController.Phase.ACTIVE)
                || quiesced || resumeAwaitingStart || pendingCheckpoint != null) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "checkpoint is accepted only once, during grace or active play");
        }
        if (checkpoint.epoch() != runtimeEpoch) {
            throw new CommandFailure(ControlProtocol.ErrorCode.INVALID_STATE,
                    "checkpoint command belongs to a different runtime epoch");
        }
    }

    private void completeCheckpoint() {
        ControlProtocol.CheckpointCommand command = pendingCheckpoint;
        BigInteger sequence = pendingCheckpointSequence;
        pendingCheckpoint = null;
        pendingCheckpointSequence = null;
        quiesced = true;
        try {
            if (outcomeEmitted || matchController.outcome().isPresent()) {
                throw new IllegalStateException("the match ended before the checkpoint barrier");
            }
            List<CheckpointRecord.SeatState> seats = new ArrayList<>();
            Set<Integer> alive = new java.util.HashSet<>(matchController.aliveSeats());
            for (ControlProtocol.Competitor competitor : preparedMatch.roster()) {
                int seat = competitor.seat();
                Optional<CheckpointRecord.LivingState> living = Optional.empty();
                if (alive.contains(seat)) {
                    UUID playerId = playersBySeat.get(seat);
                    Player player = playerId == null ? null : Bukkit.getPlayer(playerId);
                    if (player == null || !player.isOnline()) {
                        throw new IllegalStateException("living seat " + seat + " is offline at the checkpoint barrier");
                    }
                    living = Optional.of(captureLivingState(player));
                }
                seats.add(new CheckpointRecord.SeatState(seat, alive.contains(seat), competitor.offlineUuid(),
                        competitor.username(), living));
            }
            ControlProtocol.PreparePayload original = new ControlProtocol.PreparePayload(
                    preparedMatch.mapSemanticId(), preparedMatch.scenarioSemanticId(), preparedMatch.seed(),
                    preparedMatch.settings(), preparedMatch.rosterVersion(), preparedMatch.rules(),
                    Optional.empty(), preparedMatch.roster());
            CheckpointRecord record = new CheckpointRecord(command.checkpointId(), runId, runtimeEpoch,
                    naturalWorldIdentity, original, matchController.matchTick().orElseThrow(),
                    matchController.borderDiameterBlocks(), eliminationLog, seats,
                    checkpointExtension == null ? Optional.empty() : checkpointExtension.capture());
            java.nio.file.Path directory = getDataFolder().toPath().resolve("checkpoints");
            java.nio.file.Files.createDirectories(directory);
            CheckpointRecord.Stored stored = record.write(directory.resolve(command.checkpointId() + ".json"));
            controlSession.sendEvent(ControlProtocol.Type.CHECKPOINT_WRITTEN, new ControlProtocol.CheckpointWritten(
                    command.checkpointId(), runtimeEpoch, record.matchTick(), stored.digest(), stored.byteLength()));
        } catch (IOException | RuntimeException failure) {
            getLogger().severe("ARENA_CHECKPOINT_FAILED|" + failure.getMessage());
            controlSession.reject(sequence, ControlProtocol.ErrorCode.INTERNAL,
                    "checkpoint failed and left no complete record");
        }
    }

    private CheckpointRecord.LivingState captureLivingState(Player player) {
        List<CheckpointRecord.InventoryItem> items = new ArrayList<>();
        ItemStack[] contents = player.getInventory().getContents();
        for (int slot = 0; slot < contents.length; slot++) {
            ItemStack stack = contents[slot];
            if (stack != null && !stack.getType().isAir()) {
                items.add(new CheckpointRecord.InventoryItem(slot,
                        java.util.Base64.getEncoder().encodeToString(stack.serializeAsBytes())));
            }
        }
        Location location = player.getLocation();
        return new CheckpointRecord.LivingState(location.getX(), location.getY(), location.getZ(),
                location.getYaw(), location.getPitch(), player.getHealth(), player.getFoodLevel(),
                player.getSaturation(), player.getInventory().getHeldItemSlot(), items);
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
        admitPlanJoin(player);
    }

    private void admitPlanJoin(Player player) {
        List<ControlProtocol.Competitor> roster = preparedMatch == null ? List.of() : preparedMatch.roster();
        boolean bindingOpen = preparedMatch != null && matchController != null
                && matchController.phase() == MatchController.Phase.WAITING;
        SeatAdmission.Decision decision = resumeSession != null && resumeAwaitingStart
                ? resumeSession.admit(player.getName(), player.getUniqueId())
                : SeatAdmission.admit(roster, bindingOpen, playersBySeat,
                        resumeSession == null ? java.util.Set.of() : resumeSession.deadSeats(),
                        player.getName(), player.getUniqueId());
        switch (decision) {
            case SeatAdmission.Bind bind -> {
                if (resumeSession != null) {
                    bindResumedSeat(player, bind.seat());
                } else {
                    bindSeat(player, bind.seat());
                }
            }
            case SeatAdmission.Spectate spectate -> {
                player.setGameMode(GameMode.SPECTATOR);
                moveSpectatorToSpawnCenter(player);
            }
            case SeatAdmission.Reject reject -> {
                getLogger().info("ARENA_REJECT|" + player.getName() + "|" + reject.reason());
                player.kick(net.kyori.adventure.text.Component.text(reject.reason()));
            }
        }
    }

    private void moveSpectatorToSpawnCenter(Player player) {
        World world = Bukkit.getWorld(ARENA_WORLD);
        if (world == null) {
            throw new IllegalStateException("the staged arena world is unavailable for spectator placement");
        }
        MapPlan.Position center = spawnCenter(spectatorSpawns());
        if (!player.teleport(new Location(world, center.x() + 0.5, center.y(), center.z() + 0.5))) {
            throw new IllegalStateException("could not place a spectator at the arena spawn center");
        }
    }

    static MapPlan.Position spawnCenter(List<MapPlan.SpawnPoint> spawns) {
        if (spawns.isEmpty()) {
            throw new IllegalArgumentException("spectator placement requires at least one configured spawn");
        }
        long x = 0;
        long y = 0;
        long z = 0;
        for (MapPlan.SpawnPoint spawn : spawns) {
            x += spawn.position().x();
            y += spawn.position().y();
            z += spawn.position().z();
        }
        return new MapPlan.Position(
                (int) Math.round((double) x / spawns.size()),
                (int) Math.round((double) y / spawns.size()),
                (int) Math.round((double) z / spawns.size()));
    }

    private List<MapPlan.SpawnPoint> spectatorSpawns() {
        if (preparedMatch == null) {
            return resolvedSpawns;
        }
        return preparedMatch.roster().stream()
                .map(bot -> resolvedSpawns.get(bot.seat()))
                .toList();
    }

    private void bindResumedSeat(Player player, int seat) {
        if (resumeSession.planFor(seat) != ResumeSession.BindingPlan.RESTORE_SAVED_STATE) {
            throw new IllegalStateException("resumed seats restore saved state only");
        }
        CheckpointRecord.LivingState saved = resumeSession.markRestored(seat, player.getUniqueId());
        org.bukkit.inventory.PlayerInventory inventory = player.getInventory();
        inventory.clear();
        for (CheckpointRecord.InventoryItem item : saved.inventory()) {
            inventory.setItem(item.slot(), ItemStack.deserializeBytes(
                    java.util.Base64.getDecoder().decode(item.itemBase64())));
        }
        inventory.setHeldItemSlot(saved.selectedSlot());
        player.setGameMode(GameMode.SURVIVAL);
        player.setHealth(Math.min(saved.health(), player.getMaxHealth()));
        player.setFoodLevel(saved.food());
        player.setSaturation((float) saved.saturation());
        player.setInvulnerable(true);
        if (!player.teleport(new Location(Bukkit.getWorld(ARENA_WORLD), saved.x(), saved.y(), saved.z(),
                (float) saved.yaw(), (float) saved.pitch()))) {
            throw new IllegalStateException("could not restore a competitor to its checkpointed position");
        }
        playersBySeat.put(seat, player.getUniqueId());
        seatsByPlayer.put(player.getUniqueId(), seat);
    }

    private void bindSeat(Player player, int seat) {
        UUID previous = playersBySeat.get(seat);
        if (previous != null && !previous.equals(player.getUniqueId())) {
            throw new IllegalStateException("a competitive seat cannot be reassigned while its owner is online");
        }
        Integer previousSeat = seatsByPlayer.get(player.getUniqueId());
        if (previousSeat != null && previousSeat != seat) {
            throw new IllegalStateException("a player cannot be bound to more than one competitive seat");
        }

        resetInitialSeatState(player);
        MapPlan.Position spawn = resolvedSpawns.get(seat).position();
        if (!player.teleport(new Location(Bukkit.getWorld(ARENA_WORLD), spawn.x() + 0.5, spawn.y(), spawn.z() + 0.5))) {
            throw new IllegalStateException("could not place a competitive bot at its assigned spawn");
        }
        player.setGameMode(GameMode.SURVIVAL);
        applyCompiledStartingKit(player);
        playersBySeat.put(seat, player.getUniqueId());
        seatsByPlayer.put(player.getUniqueId(), seat);
    }

    private void applyCompiledStartingKit(Player player) {
        if (!(preparedMatch.settings() instanceof ControlProtocol.CivilizationPrepareSettings civilization)) {
            return;
        }
        List<ControlProtocol.StartingItem> startingKit = civilization.civilization().startingKit();
        for (int slot = 0; slot < startingKit.size(); slot++) {
            ControlProtocol.StartingItem item = startingKit.get(slot);
            Material material = ArenaChunkGenerator.requireItemMaterial(item.resourceId());
            player.getInventory().setItem(slot, new ItemStack(material, item.count()));
        }
    }

    private static void resetInitialSeatState(Player player) {
        player.setItemOnCursor(new ItemStack(Material.AIR));
        player.closeInventory();
        player.setGameMode(GameMode.SURVIVAL);
        player.getInventory().clear();
        player.getInventory().setArmorContents(null);
        player.getInventory().setItemInOffHand(new ItemStack(Material.AIR));
        player.getEnderChest().clear();
        player.clearActivePotionEffects();
        player.resetMaxHealth();
        player.setHealth(player.getMaxHealth());
        player.setAbsorptionAmount(0.0);
        player.setFoodLevel(20);
        player.setSaturation(5.0f);
        player.setExhaustion(0.0f);
        player.setFireTicks(0);
        player.setVisualFire(false);
        player.setFreezeTicks(0);
        player.setFallDistance(0.0f);
        player.setRemainingAir(player.getMaximumAir());
        player.setNoDamageTicks(0);
        player.setVelocity(new Vector(0, 0, 0));
        player.setTotalExperience(0);
        player.setLevel(0);
        player.setExp(0.0f);
        player.setSprinting(false);
        player.setGliding(false);
        player.setSwimming(false);
        player.setInvulnerable(false);
        player.setCanPickupItems(true);
    }

    private boolean allConfiguredBotsAreOnline() {
        for (ControlProtocol.Competitor bot : preparedMatch.roster()) {
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
        if (matchController == null || outcomeEmitted || skipMatchAdvanceThisTick || !isRunningMatch()
                || quiesced || resumeAwaitingStart) {
            return;
        }
        boolean countdownWasRunning = matchController.phase() == MatchController.Phase.COUNTDOWN;
        BigInteger civilizationTick = countdownWasRunning ? null : matchController.matchTick().orElse(null);
        if (civilizationTick != null && !damageAccumulator.isEmpty()) {
            controlSession.sendEvent(ControlProtocol.Type.DAMAGE, new ControlProtocol.DamagePayload(
                    new ControlProtocol.Tick(ControlProtocol.TickDomain.MATCH, civilizationTick),
                    damageAccumulator.drain()));
        } else {
            damageAccumulator.clear();
        }
        List<MatchController.ResolvedElimination> resolved = matchController.endServerTick(pendingEliminations);
        pendingEliminations.clear();
        for (MatchController.ResolvedElimination item : resolved) {
            eliminationLog.add(new CheckpointRecord.Elimination(item.seat(),
                    ControlProtocol.EliminationCause.valueOf(item.cause().name()),
                    controlTick(item.at()).value()));
        }
        if (countdownWasRunning) {
            recordInitialCivilizationMaterialCheckpointIfReleased();
        }
        if (civilizationMatchController != null && countdownWasRunning) {
            civilizationCountdownEliminations.addAll(resolved);
        }
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

        if (civilizationMatchController != null && civilizationTick != null) {
            MatchController.MatchTick at = new MatchController.MatchTick(civilizationTick);
            List<MatchController.ResolvedElimination> resolvedForCivilization = civilizationEliminationBatch(
                    civilizationCountdownEliminations, resolved);
            civilizationCountdownEliminations.clear();
            List<MatchController.Elimination> civilizationEliminations = civilizationEliminationsSinceLastTick(
                    matchController.aliveSeats(), civilizationMatchController.aliveSeats(), resolvedForCivilization);
            ControlProtocol.CivilizationSettings settings = civilizationSettings();
            World world = Bukkit.getWorld(ARENA_WORLD);
            Optional<CivilizationMatchController.Outcome> civilizationOutcome = civilizationMatchController.endServerTick(
                    at, civilizationZoneOccupants(world, settings.captureZone()), civilizationEliminations);
            updateCivilizationOutposts(world, settings, at);
            recordCivilizationMaterialCheckpoint(world, at.value());
            publishCivilizationState(controlTick(at));
            if (civilizationOutcome.isPresent()) {
                matchController.finishExternally(at);
                applyCurrentBorder();
                publishClock();
                emitCivilizationOutcome(civilizationOutcome.orElseThrow());
                return;
            }
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
            case FINISHED -> matchController.outcome().flatMap(MatchController.Outcome::resolutionTick)
                    .map(ArenaFoundationPlugin::controlTick)
                    .or(() -> matchController.matchTick().map(value ->
                            new ControlProtocol.Tick(ControlProtocol.TickDomain.MATCH, value)));
            case ABORTED -> matchController.outcome().orElseThrow().resolutionTick()
                    .map(ArenaFoundationPlugin::controlTick);
        };
    }

    private double currentBorderDiameter() {
        World world = Bukkit.getWorld(ARENA_WORLD);
        if (matchController != null && matchController.matchTick().isPresent()) {
            return matchController.borderDiameterBlocks();
        }
        if (preparedMatch != null) {
            return preparedMatch.initialBorderDiameterBlocks();
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

    static List<MatchController.ResolvedElimination> civilizationEliminationBatch(
            List<MatchController.ResolvedElimination> countdown,
            List<MatchController.ResolvedElimination> matchTick) {
        List<MatchController.ResolvedElimination> result = new ArrayList<>(countdown);
        result.addAll(matchTick);
        return List.copyOf(result);
    }

    static List<MatchController.Elimination> civilizationEliminationsSinceLastTick(
            List<Integer> matchAliveSeats,
            List<Integer> civilizationAliveSeats,
            List<MatchController.ResolvedElimination> resolved) {
        Set<Integer> alive = new HashSet<>(matchAliveSeats);
        List<MatchController.Elimination> eliminations = new ArrayList<>();
        for (int seat : civilizationAliveSeats) {
            if (alive.contains(seat)) {
                continue;
            }
            MatchController.EliminationCause cause = resolved.stream()
                    .filter(item -> item.seat() == seat)
                    .map(MatchController.ResolvedElimination::cause)
                    .findFirst()
                    .orElse(MatchController.EliminationCause.DISCONNECT);
            eliminations.add(new MatchController.Elimination(seat, cause));
        }
        return List.copyOf(eliminations);
    }

    private ControlProtocol.CivilizationSettings civilizationSettings() {
        if (!(preparedMatch.settings() instanceof ControlProtocol.CivilizationPrepareSettings civilization)) {
            throw new IllegalStateException("civilization controller requires civilization prepare settings");
        }
        return civilization.civilization();
    }

    private Set<Integer> civilizationZoneOccupants(World world, ControlProtocol.CaptureZone zone) {
        Set<Integer> occupants = new java.util.TreeSet<>();
        Set<Integer> alive = new HashSet<>(matchController.aliveSeats());
        for (Map.Entry<Integer, UUID> seatPlayer : playersBySeat.entrySet()) {
            int seat = seatPlayer.getKey();
            if (!alive.contains(seat)) {
                continue;
            }
            Player player = Bukkit.getPlayer(seatPlayer.getValue());
            if (player == null || !player.isOnline() || player.isDead() || player.getGameMode() != GameMode.SURVIVAL
                    || player.getWorld() != world) {
                continue;
            }
            Location location = player.getLocation();
            if (CivilizationWorldRules.contains(zone,
                    new MapPlan.Position(location.getBlockX(), location.getBlockY(), location.getBlockZ()))) {
                occupants.add(seat);
            }
        }
        return Set.copyOf(occupants);
    }

    private void publishCivilizationState(ControlProtocol.Tick at) {
        if (civilizationMatchController == null) {
            return;
        }
        CivilizationMatchController.FactionScores scores = civilizationMatchController.scores();
        ControlProtocol.CivilizationStatePayload state = new ControlProtocol.CivilizationStatePayload(
                at,
                civilizationMatchController.zoneOccupants(),
                civilizationMatchController.ownerFaction().map(faction -> ControlProtocol.FactionId.valueOf(faction.name())),
                civilizationMatchController.challengerFaction()
                        .map(faction -> ControlProtocol.FactionId.valueOf(faction.name())),
                civilizationMatchController.captureProgressTicks(),
                new ControlProtocol.FactionScores(scores.emberPoints(), scores.tidePoints()));
        controlSession.sendEvent(ControlProtocol.Type.CIVILIZATION_STATE, state);
    }

    private void updateCivilizationOutposts(
            World world,
            ControlProtocol.CivilizationSettings settings,
            MatchController.MatchTick at) {
        for (ControlProtocol.FactionId faction : ControlProtocol.FactionId.values()) {
            ControlProtocol.BlueprintAnchor anchor = settings.blueprint().anchors().get(faction);
            boolean complete = CivilizationWorldRules.hasCompleteOutpost(anchor, position ->
                    world.getBlockAt(position.x(), position.y(), position.z()).getType() == Material.OAK_PLANKS);
            boolean previous = outpostCompletion.getOrDefault(faction, false);
            if (complete != previous) {
                outpostCompletion.put(faction, complete);
                getLogger().info("ARENA_CIVILIZATION_OUTPOST|faction=" + faction.wireName()
                        + "|complete=" + complete + "|tick=" + at.value());
            }
        }
    }

    private void recordInitialCivilizationMaterialCheckpointIfReleased() {
        if (civilizationMaterialCensus == null || civilizationMaterialCensus.hasInitialCheckpoint()
                || matchController == null
                || matchController.matchTick().filter(BigInteger.ZERO::equals).isEmpty()) {
            return;
        }
        World world = Bukkit.getWorld(ARENA_WORLD);
        if (world == null) {
            throw new IllegalStateException("material census cannot read the arena world");
        }
        recordCivilizationMaterialCheckpoint(world, BigInteger.ZERO);
    }

    private void recordCivilizationMaterialCheckpoint(World world, BigInteger matchTick) {
        if (civilizationMaterialCensus == null) {
            return;
        }
        CivilizationMaterialCensus.requireLoadedChunks(
                civilizationMaterialCensusMapChunks, world::isChunkLoaded);
        List<CivilizationMaterialCensus.InventorySnapshot> inventories = new ArrayList<>(CivilizationMatchController.SEAT_COUNT);
        for (int seat = 0; seat < CivilizationMatchController.SEAT_COUNT; seat++) {
            UUID playerId = playersBySeat.get(seat);
            Player player = playerId == null ? null : Bukkit.getPlayer(playerId);
            if (player == null || !player.isOnline()) {
                throw new IllegalStateException("material census requires all six bound players to remain online");
            }
            inventories.add(new CivilizationMaterialCensus.InventorySnapshot(
                    seat, playerMaterialStacks(player)));
        }

        List<CivilizationMaterialCensus.ItemEntitySnapshot> itemEntities = new ArrayList<>();
        for (Item item : world.getEntitiesByClass(Item.class)) {
            itemEntities.add(new CivilizationMaterialCensus.ItemEntitySnapshot(
                    item.getUniqueId().toString(), itemMaterialStacks(List.of(item.getItemStack()))));
        }

        List<CivilizationMaterialCensus.ContainerSnapshot> containers = new ArrayList<>();
        for (MapPlan.LootContainer container : resolvedLootContainers) {
            MapPlan.Position position = container.position();
            requireCivilizationMaterialPositionChunkLoaded(world, position);
            Block block = world.getBlockAt(position.x(), position.y(), position.z());
            List<CivilizationMaterialCensus.StackCount> items = block.getState() instanceof Chest chest
                    ? inventoryMaterialStacks(chest.getBlockInventory())
                    : List.of();
            containers.add(new CivilizationMaterialCensus.ContainerSnapshot(
                    censusPosition(position), items));
        }

        List<CivilizationMaterialCensus.Position> remainingNaturalLogs = new ArrayList<>(
                initialNaturalOakLogPositions.size());
        for (MapPlan.Position position : initialNaturalOakLogPositions) {
            requireCivilizationMaterialPositionChunkLoaded(world, position);
            if (world.getBlockAt(position.x(), position.y(), position.z()).getType() == Material.OAK_LOG) {
                remainingNaturalLogs.add(censusPosition(position));
            }
        }
        for (MapPlan.Position position : dirtyOakPlankPositions) {
            requireCivilizationMaterialPositionChunkLoaded(world, position);
            if (world.getBlockAt(position.x(), position.y(), position.z()).getType() == Material.OAK_PLANKS) {
                placedOakPlankPositions.add(position);
            } else {
                placedOakPlankPositions.remove(position);
            }
        }
        dirtyOakPlankPositions.clear();
        List<CivilizationMaterialCensus.Position> placedPlanks = placedOakPlankPositions.stream()
                .map(ArenaFoundationPlugin::censusPosition)
                .toList();
        CivilizationMaterialCensus.MaterialState state = CivilizationMaterialCensus.MaterialState.sample(
                remainingNaturalLogs,
                inventories,
                itemEntities,
                containers,
                placedPlanks);
        civilizationMaterialCensus.checkpoint(matchTick, state);
    }

    private static void requireCivilizationMaterialPositionChunkLoaded(World world, MapPlan.Position position) {
        CivilizationMaterialCensus.requirePositionChunkLoaded(position.x(), position.z(), world::isChunkLoaded);
    }

    static List<CivilizationMaterialCensus.StackCount> playerMaterialStacks(Player player) {
        List<CivilizationMaterialCensus.StackCount> items = new ArrayList<>(
                inventoryMaterialStacks(player.getInventory()));
        appendMaterialStack(items, player.getItemOnCursor());
        if (player.getOpenInventory().getTopInventory() instanceof CraftingInventory craftingInventory) {
            for (ItemStack item : craftingInventory.getMatrix()) {
                appendMaterialStack(items, item);
            }
        }
        return List.copyOf(items);
    }

    private static List<CivilizationMaterialCensus.StackCount> inventoryMaterialStacks(Inventory inventory) {
        List<CivilizationMaterialCensus.StackCount> items = new ArrayList<>();
        for (ItemStack item : inventory.getContents()) {
            appendMaterialStack(items, item);
        }
        return List.copyOf(items);
    }

    private static List<CivilizationMaterialCensus.StackCount> itemMaterialStacks(Iterable<ItemStack> contents) {
        List<CivilizationMaterialCensus.StackCount> items = new ArrayList<>();
        for (ItemStack item : contents) {
            appendMaterialStack(items, item);
        }
        return List.copyOf(items);
    }

    private static void appendMaterialStack(List<CivilizationMaterialCensus.StackCount> items, ItemStack item) {
        if (item == null || (item.getType() != Material.OAK_LOG && item.getType() != Material.OAK_PLANKS)) {
            return;
        }
        items.add(new CivilizationMaterialCensus.StackCount(item.getType().getKey().toString(), item.getAmount()));
    }

    private static MapPlan.Position materialPosition(int x, int y, int z) {
        return new MapPlan.Position(x, y, z);
    }

    private static CivilizationMaterialCensus.Position censusPosition(MapPlan.Position position) {
        return new CivilizationMaterialCensus.Position(position.x(), position.y(), position.z());
    }

    private void emitCivilizationOutcome(CivilizationMatchController.Outcome outcome) {
        requireInitialCivilizationMaterialCheckpoint();
        ControlProtocol.Outcome controlOutcome;
        if (outcome instanceof CivilizationMatchController.FactionWinner winner) {
            CivilizationMatchController.FactionScores scores = winner.scores();
            controlOutcome = new ControlProtocol.FactionWinnerOutcome(
                    ControlProtocol.FactionId.valueOf(winner.winner().name()),
                    ControlProtocol.FactionWinnerReason.valueOf(winner.reason().name()),
                    new ControlProtocol.FactionScores(scores.emberPoints(), scores.tidePoints()),
                    winner.survivors(), new ControlProtocol.Tick(ControlProtocol.TickDomain.MATCH, winner.at().value()));
        } else if (outcome instanceof CivilizationMatchController.Draw draw) {
            CivilizationMatchController.FactionScores scores = draw.scores();
            controlOutcome = new ControlProtocol.CivilizationDrawOutcome(
                    ControlProtocol.DrawReason.valueOf(draw.reason().name()),
                    new ControlProtocol.FactionScores(scores.emberPoints(), scores.tidePoints()),
                    draw.survivors(), new ControlProtocol.Tick(ControlProtocol.TickDomain.MATCH, draw.at().value()));
        } else {
            throw new IllegalStateException("civilization controller returned an unknown outcome");
        }
        controlSession.sendEvent(ControlProtocol.Type.OUTCOME, controlOutcome);
        outcomeEmitted = true;
    }

    private void requireInitialCivilizationMaterialCheckpoint() {
        if (civilizationMaterialCensus != null && !civilizationMaterialCensus.hasInitialCheckpoint()) {
            throw new IllegalStateException("civilization material census has no match tick zero checkpoint");
        }
    }

    private void failCivilizationEvaluatorRun(RuntimeException failure) {
        if (civilizationMaterialCensus != null) {
            civilizationMaterialCensus.poison(failure);
        }
        getLogger().log(Level.SEVERE, "Civilization evaluator evidence failed; stopping the Paper server.", failure);
        Bukkit.shutdown();
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

    private boolean isMatchRuleEnabled(BlockAction action) {
        if (startupMode != StartupMode.PLAN || preparedMatch == null || matchController == null
                || !matchController.phase().allowsCompetitiveActions()) {
            return false;
        }
        return matchRulesAllowBlockEdit(preparedMatch.match(), matchController.phase(), action);
    }

    static boolean matchRulesAllowBlockEdit(
            ControlProtocol.MatchSettings settings,
            MatchController.Phase phase,
            BlockAction action) {
        Objects.requireNonNull(settings, "match settings");
        Objects.requireNonNull(phase, "match phase");
        Objects.requireNonNull(action, "block action");
        return phase.allowsCompetitiveActions()
                && (action == BlockAction.BREAK ? settings.blockBreaking() : settings.blockPlacing());
    }

    private boolean isPreReleaseCompetitor(Player player) {
        return matchController != null
                && matchController.phase().isPreRelease()
                && isArenaCompetitor(player);
    }

    private boolean isArenaCompetitor(Player player) {
        return startupMode == StartupMode.PLAN && seatsByPlayer.containsKey(player.getUniqueId());
    }

    private boolean isPreReleaseDamageSource(Entity entity) {
        return matchController != null
                && matchController.phase().isPreRelease()
                && isArenaCompetitorDamageSource(entity);
    }

    private boolean isArenaCompetitorDamageSource(Entity entity) {
        return startupMode == StartupMode.PLAN
                && isDamageFromCompetitor(entity, seatsByPlayer.keySet());
    }

    // Paper reports projectiles as the damager, so resolve their player shooter before checking the roster.
    static boolean isDamageFromCompetitor(Entity source, Set<UUID> competitorIds) {
        if (source instanceof Player player) {
            return competitorIds.contains(player.getUniqueId());
        }
        if (source instanceof Projectile projectile && projectile.getShooter() instanceof Player player) {
            return competitorIds.contains(player.getUniqueId());
        }
        return false;
    }

    static void capturePlayerFailMove(
            PlayerFailMoveEvent event,
            Map<UUID, Integer> seatsByPlayer,
            MatchController.Phase phase,
            Optional<BigInteger> tick,
            MovementFailureDiagnostics diagnostics,
            Consumer<String> log) {
        if (!diagnostics.isEnabled()) {
            return;
        }
        Integer seat = seatsByPlayer.get(event.getPlayer().getUniqueId());
        diagnostics.capture(event, seat, phase, tick, log);
    }

    private static boolean isArenaWorld(World world) {
        return ARENA_WORLD.equals(world.getName());
    }

    private static boolean samePosition(Location first, Location second) {
        return first.getWorld() == second.getWorld()
                && Double.compare(first.getX(), second.getX()) == 0
                && Double.compare(first.getY(), second.getY()) == 0
                && Double.compare(first.getZ(), second.getZ()) == 0;
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
            createStackSmokeFixture(world);
        } else {
            if (generationPlan instanceof MapPlan plannedPlan) {
                if (!generatorRequested) {
                    throw new IllegalStateException(
                            "the planned world plan is loaded, but Paper did not request the arena generator; "
                                    + "configure world as ArenaFoundation:plan");
                }
                preparedChunks = prepareMapWorld(world, plannedPlan);
            } else if (generationPlan instanceof NaturalMapPlan naturalPlan) {
                if (world.getSeed() != naturalPlan.worldSeed().longValue()) {
                    throw new IllegalStateException("loaded vanilla world seed does not match the staged world plan");
                }
                NaturalWorldSetup.PreparedWorld naturalWorld = NaturalWorldSetup.prepare(
                        naturalPlan, new PaperNaturalWorldAccess(world), world.getViewDistance(),
                        ArenaChunkGenerator.paperMaterialCatalog(), loadedCheckpoint == null);
                naturalWorldIdentity = loadedCheckpoint == null
                        ? naturalWorld.worldIdentity()
                        : loadedCheckpoint.record().worldIdentity();
                resolvedSpawns = naturalWorld.spawns();
                resolvedLootContainers = naturalWorld.lootContainers();
                preparedChunks = naturalWorld.preparedChunkCount();
                getLogger().info("ARENA_NATURAL_WORLD|recipe=" + naturalWorld.spawnRecipe()
                        + "|world_identity=" + naturalWorld.worldIdentity()
                        + "|spawns=" + naturalWorld.spawns().stream()
                                .map(spawn -> spawn.seat() + ":" + spawn.position().x() + "," + spawn.position().z())
                                .collect(java.util.stream.Collectors.joining(";")));
            } else {
                throw new IllegalStateException("staged world plan variant is unsupported");
            }
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

    private int prepareMapWorld(World world, MapPlan plan) {
        MapPlan.Dimensions dimensions = plan.dimensions();
        if (dimensions.minY() < world.getMinHeight() || dimensions.maxY() >= world.getMaxHeight()) {
            throw new IllegalStateException("world-plan vertical bounds do not fit the arena world's build height");
        }

        List<MapPlan.ChunkPosition> chunks = plan.chunksWithViewHalo(world.getViewDistance());
        for (MapPlan.ChunkPosition chunk : chunks) {
            world.getChunkAt(chunk.x(), chunk.z());
        }

        validateGeneratedMap(world, plan);

        for (MapPlan.LootContainer container : plan.lootContainers()) {
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

        MapPlan.Position firstSpawn = plan.spawns().getFirst().position();
        validateRuntimeSpawns(world, plan.spawns());
        world.setSpawnLocation(firstSpawn.x(), firstSpawn.y(), firstSpawn.z());
        resolvedSpawns = plan.spawns();
        resolvedLootContainers = plan.lootContainers();
        return chunks.size();
    }

    private MapPlan requirePlannedPlan() {
        if (generationPlan instanceof MapPlan plannedPlan) {
            return plannedPlan;
        }
        throw new IllegalStateException("the staged world plan does not contain resolved blocks");
    }

    private void validateGeneratedMap(World world, MapPlan plan) {
        for (MapPlan.BlockPlacement placement : plan.blocks()) {
            MapPlan.Position position = placement.position();
            Block block = world.getBlockAt(position.x(), position.y(), position.z());
            if (!placement.material().equals(block.getType().getKey().toString())) {
                throw new IllegalStateException("generated world block does not match the staged map plan at "
                        + position.x() + "," + position.y() + "," + position.z());
            }
        }
    }

    private void validateRuntimeSpawns(World world, List<MapPlan.SpawnPoint> spawns) {
        for (MapPlan.SpawnPoint spawn : spawns) {
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

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onSquadChat(io.papermc.paper.event.player.AsyncChatEvent event) {
        ControlProtocol.SquadsRules rules = squadRules;
        if (rules == null) {
            return;
        }
        Integer senderSeat = seatsByPlayer.get(event.getPlayer().getUniqueId());
        if (senderSeat == null) {
            return;
        }
        Optional<String> squad = rules.squadOf(senderSeat);
        event.viewers().removeIf(viewer -> {
            if (!(viewer instanceof Player player)) {
                return false;
            }
            Integer seat = seatsByPlayer.get(player.getUniqueId());
            return seat != null && !squad.equals(rules.squadOf(seat));
        });
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onGameModeChange(org.bukkit.event.player.PlayerGameModeChangeEvent event) {
        if (startupMode != StartupMode.PLAN || matchController == null || !isRunningMatch()
                || event.getNewGameMode() == GameMode.SURVIVAL) {
            return;
        }
        Integer seat = seatsByPlayer.get(event.getPlayer().getUniqueId());
        if (seat == null || !matchController.aliveSeats().contains(seat)) {
            return;
        }
        boolean eliminationPending = pendingEliminations.stream()
                .anyMatch(elimination -> elimination.seat() == seat);
        if (!eliminationPending) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onAsyncPreLogin(org.bukkit.event.player.AsyncPlayerPreLoginEvent event) {
        if (startupMode != StartupMode.PLAN) {
            return;
        }
        List<LoginGuard.OnlineIdentity> online = new ArrayList<>();
        for (Player player : Bukkit.getOnlinePlayers()) {
            online.add(new LoginGuard.OnlineIdentity(player.getName(), player.getUniqueId()));
        }
        Optional<String> denial = LoginGuard.denial(online, event.getName(), event.getUniqueId());
        if (denial.isPresent()) {
            getLogger().info("ARENA_REJECT|" + event.getName() + "|" + denial.get());
            event.disallow(org.bukkit.event.player.AsyncPlayerPreLoginEvent.Result.KICK_OTHER,
                    net.kyori.adventure.text.Component.text(denial.get()));
        }
    }

    @EventHandler(priority = EventPriority.HIGH)
    public void onJoin(PlayerJoinEvent event) {
        getLogger().info("ARENA_JOIN|" + event.getPlayer().getName());
        if (startupMode == StartupMode.PLAN) {
            handlePlanJoin(event.getPlayer());
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onMove(PlayerMoveEvent event) {
        Location destination = event.getTo();
        if (destination == null) {
            return;
        }
        Location source = event.getFrom();
        Player player = event.getPlayer();
        if (isPreReleaseCompetitor(player) && !samePosition(source, destination)) {
            event.setTo(new Location(source.getWorld(), source.getX(), source.getY(), source.getZ(),
                    destination.getYaw(), destination.getPitch()));
            destination = event.getTo();
        }
        if (samePosition(source, destination)) {
            return;
        }
        if (reportedMovement.add(player.getUniqueId())) {
            getLogger().info("ARENA_MOVE|" + player.getName());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerFailMove(PlayerFailMoveEvent event) {
        if (startupMode != StartupMode.PLAN
                || movementFailureDiagnostics == null
                || !movementFailureDiagnostics.isEnabled()
                || matchController == null) {
            return;
        }
        capturePlayerFailMove(event, seatsByPlayer, matchController.phase(), matchController.matchTick(),
                movementFailureDiagnostics, getLogger()::info);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseInventoryOpen(InventoryOpenEvent event) {
        if (event.getPlayer() instanceof Player player && isPreReleaseCompetitor(player)) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onInventoryOpen(InventoryOpenEvent event) {
        if (event.getPlayer() instanceof Player player && isArenaChest(event.getInventory())) {
            getLogger().info("ARENA_CHEST_OPEN|" + player.getName());
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseInventoryClick(InventoryClickEvent event) {
        if (event.getWhoClicked() instanceof Player player && isPreReleaseCompetitor(player)) {
            event.setCancelled(true);
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

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseInventoryDrag(InventoryDragEvent event) {
        if (event.getWhoClicked() instanceof Player player && isPreReleaseCompetitor(player)) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseItemDrop(PlayerDropItemEvent event) {
        if (isPreReleaseCompetitor(event.getPlayer())) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseItemPickup(EntityPickupItemEvent event) {
        if (event.getEntity() instanceof Player player && isPreReleaseCompetitor(player)) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseItemConsume(PlayerItemConsumeEvent event) {
        if (isPreReleaseCompetitor(event.getPlayer())) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseHandSwap(PlayerSwapHandItemsEvent event) {
        if (isPreReleaseCompetitor(event.getPlayer())) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseInteract(PlayerInteractEvent event) {
        if (isPreReleaseCompetitor(event.getPlayer())) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPreReleaseEntityInteract(PlayerInteractEntityEvent event) {
        if (isPreReleaseCompetitor(event.getPlayer())) {
            event.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void recordCompetitorDamage(org.bukkit.event.entity.EntityDamageEvent event) {
        if (startupMode != StartupMode.PLAN || preparedMatch == null || !preparedMatch.damageEvents()
                || matchController == null || quiesced || resumeAwaitingStart
                || (matchController.phase() != MatchController.Phase.GRACE
                        && matchController.phase() != MatchController.Phase.ACTIVE)
                || !(event.getEntity() instanceof Player victim)) {
            return;
        }
        Integer victimSeat = seatsByPlayer.get(victim.getUniqueId());
        double amount = event.getFinalDamage();
        if (victimSeat == null || !matchController.aliveSeats().contains(victimSeat) || !(amount > 0.0)) {
            return;
        }
        Optional<Integer> attacker = Optional.empty();
        ControlProtocol.DamageCause cause = switch (event.getCause().name()) {
            case "FALL" -> ControlProtocol.DamageCause.FALL;
            case "FIRE", "FIRE_TICK", "LAVA", "HOT_FLOOR", "CAMPFIRE" -> ControlProtocol.DamageCause.FIRE;
            case "STARVATION" -> ControlProtocol.DamageCause.STARVATION;
            case "WORLD_BORDER" -> ControlProtocol.DamageCause.BORDER;
            case "ENTITY_ATTACK", "ENTITY_SWEEP_ATTACK" -> ControlProtocol.DamageCause.MELEE;
            case "PROJECTILE" -> ControlProtocol.DamageCause.PROJECTILE;
            default -> ControlProtocol.DamageCause.OTHER;
        };
        if (event instanceof EntityDamageByEntityEvent byEntity) {
            Player source = null;
            if (byEntity.getDamager() instanceof Player player) {
                source = player;
            } else if (byEntity.getDamager() instanceof Projectile projectile
                    && projectile.getShooter() instanceof Player shooter) {
                source = shooter;
                cause = ControlProtocol.DamageCause.PROJECTILE;
            }
            if (source != null) {
                Integer attackerSeat = seatsByPlayer.get(source.getUniqueId());
                if (attackerSeat != null) {
                    attacker = Optional.of(attackerSeat);
                    if (cause != ControlProtocol.DamageCause.PROJECTILE) {
                        cause = ControlProtocol.DamageCause.MELEE;
                    }
                }
            }
        }
        if (attacker.isPresent() && cause != ControlProtocol.DamageCause.MELEE
                && cause != ControlProtocol.DamageCause.PROJECTILE) {
            cause = ControlProtocol.DamageCause.OTHER;
        }
        damageAccumulator.add(victimSeat, attacker, cause, amount);
    }

    @EventHandler(priority = EventPriority.MONITOR)
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
        if (resumeAwaitingStart) {
            resumeSession.markDisconnected(seat);
            seatsByPlayer.remove(playerId);
            playersBySeat.remove(seat);
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
        for (MapPlan.LootContainer container : resolvedLootContainers) {
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
