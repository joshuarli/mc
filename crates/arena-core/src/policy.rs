//! A deterministic, bounded baseline policy over client-observed state.

use crate::geometry::{BlockPosition, Tick};
use crate::observation::{
    AgentObservation, AgentState, EntityId, EquipmentSlot, Knowledge, LootOpportunity,
    VisibleOpponent,
};
use crate::random::DeterministicRandom;

const MAX_HEALTH_HALF_HEARTS: u8 = 40;
const MAX_HUNGER_POINTS: u8 = 20;
const MAX_BORDER_MARGIN_BLOCKS: u32 = 8;
const MAX_FIGHT_RANGE_BLOCKS: u32 = 8;
const MAX_OPPONENT_MEMORY_TICKS: u64 = 100;
const MAX_LOOT_HYSTERESIS_BLOCKS: u64 = 16;
const MAX_SEARCH_RADIUS_BLOCKS: u32 = 16;
const MELEE_REACH_BLOCKS: u32 = 3;
const LOOT_INTERACTION_DISTANCE_BLOCKS: u64 = 3;

/// Parameter schema versions accepted by this policy entry point.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PolicyParameterVersion {
    V1,
}

/// Named validated inputs for the baseline policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PolicyParamValues {
    pub version: PolicyParameterVersion,
    pub eat_at_hunger_or_below: u8,
    pub retreat_at_health_half_hearts_or_below: u8,
    pub border_margin_blocks: u32,
    pub fight_range_blocks: u32,
    pub opponent_memory_ticks: u64,
    pub loot_hysteresis_blocks: u64,
    pub search_radius_blocks: u32,
}

/// Parameters that have passed the policy's bounds checks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PolicyParams(PolicyParamValues);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidPolicyParams {
    HungerThresholdOutOfRange,
    RetreatThresholdOutOfRange,
    BorderMarginOutOfRange,
    FightRangeOutOfRange,
    OpponentMemoryOutOfRange,
    LootHysteresisOutOfRange,
    SearchRadiusOutOfRange,
}

impl PolicyParams {
    pub fn new(values: PolicyParamValues) -> Result<Self, InvalidPolicyParams> {
        if values.eat_at_hunger_or_below == 0
            || values.eat_at_hunger_or_below > MAX_HUNGER_POINTS
        {
            return Err(InvalidPolicyParams::HungerThresholdOutOfRange);
        }
        if values.retreat_at_health_half_hearts_or_below == 0
            || values.retreat_at_health_half_hearts_or_below >= MAX_HEALTH_HALF_HEARTS
        {
            return Err(InvalidPolicyParams::RetreatThresholdOutOfRange);
        }
        if values.border_margin_blocks > MAX_BORDER_MARGIN_BLOCKS {
            return Err(InvalidPolicyParams::BorderMarginOutOfRange);
        }
        if values.fight_range_blocks == 0 || values.fight_range_blocks > MAX_FIGHT_RANGE_BLOCKS {
            return Err(InvalidPolicyParams::FightRangeOutOfRange);
        }
        if values.opponent_memory_ticks == 0
            || values.opponent_memory_ticks > MAX_OPPONENT_MEMORY_TICKS
        {
            return Err(InvalidPolicyParams::OpponentMemoryOutOfRange);
        }
        if values.loot_hysteresis_blocks > MAX_LOOT_HYSTERESIS_BLOCKS {
            return Err(InvalidPolicyParams::LootHysteresisOutOfRange);
        }
        if values.search_radius_blocks == 0
            || values.search_radius_blocks > MAX_SEARCH_RADIUS_BLOCKS
        {
            return Err(InvalidPolicyParams::SearchRadiusOutOfRange);
        }

        Ok(Self(values))
    }

    /// The frozen, small baseline values used until a versioned profile selects
    /// another validated parameter set.
    pub const fn baseline() -> Self {
        Self(PolicyParamValues {
            version: PolicyParameterVersion::V1,
            eat_at_hunger_or_below: 8,
            retreat_at_health_half_hearts_or_below: 8,
            border_margin_blocks: 2,
            fight_range_blocks: 4,
            opponent_memory_ticks: 100,
            loot_hysteresis_blocks: 2,
            search_radius_blocks: 8,
        })
    }

    pub const fn values(self) -> PolicyParamValues {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WaitReason {
    AgentStateUnknown,
    AgentStateStale,
    AgentEliminated,
    BorderUnknown,
    BorderStale,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Goal {
    EscapeBorder,
    RecoverHunger,
    ImproveEquipment { slot: EquipmentSlot, rating: u8 },
    EngageVisibleOpponent { target: EntityId },
    RetreatFromOpponent { target: EntityId },
    Loot { target: EntityId },
    SearchLastKnown { target: EntityId },
    Explore,
    Wait(WaitReason),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Intent {
    NavigateTo(BlockPosition),
    Eat,
    Equip { slot: EquipmentSlot, rating: u8 },
    ApproachOpponent { target: EntityId },
    Attack { target: EntityId },
    CollectDrop { target: EntityId },
    OpenContainer { target: EntityId },
    Hold(WaitReason),
}

/// The previous selection and last client-observed opponent used for bounded
/// search and target hysteresis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyMemory {
    last_goal: Option<Goal>,
    last_opponent: Option<RememberedOpponent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RememberedOpponent {
    id: EntityId,
    position: BlockPosition,
    observed_at: Tick,
}

impl PolicyMemory {
    pub const fn new() -> Self {
        Self {
            last_goal: None,
            last_opponent: None,
        }
    }
}

impl Default for PolicyMemory {
    fn default() -> Self {
        Self::new()
    }
}

/// A selected goal and adapter-facing intent, plus the next replayable memory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Decision {
    goal: Goal,
    intent: Intent,
    memory: PolicyMemory,
}

impl Decision {
    pub const fn goal(&self) -> Goal {
        self.goal
    }

    pub const fn intent(&self) -> Intent {
        self.intent
    }

    pub const fn memory(&self) -> &PolicyMemory {
        &self.memory
    }

    pub fn into_memory(self) -> PolicyMemory {
        self.memory
    }
}

/// Chooses one baseline action using only the supplied client observation.
/// The caller owns receipt filtering, skill execution, and live-world access.
pub fn decide(
    observation: &AgentObservation,
    memory: &PolicyMemory,
    params: &PolicyParams,
    random: &mut DeterministicRandom,
) -> Decision {
    let mut next_memory = memory.clone();
    let agent = match observation.agent() {
        Knowledge::Current(agent) => agent,
        Knowledge::Unknown => {
            return decision(
                Goal::Wait(WaitReason::AgentStateUnknown),
                Intent::Hold(WaitReason::AgentStateUnknown),
                next_memory,
            );
        }
        Knowledge::Stale { .. } => {
            return decision(
                Goal::Wait(WaitReason::AgentStateStale),
                Intent::Hold(WaitReason::AgentStateStale),
                next_memory,
            );
        }
    };

    if agent.health_half_hearts() == 0 {
        return decision(
            Goal::Wait(WaitReason::AgentEliminated),
            Intent::Hold(WaitReason::AgentEliminated),
            next_memory,
        );
    }

    let border = match observation.border() {
        Knowledge::Current(border) => border,
        Knowledge::Unknown => {
            return decision(
                Goal::Wait(WaitReason::BorderUnknown),
                Intent::Hold(WaitReason::BorderUnknown),
                next_memory,
            );
        }
        Knowledge::Stale { .. } => {
            return decision(
                Goal::Wait(WaitReason::BorderStale),
                Intent::Hold(WaitReason::BorderStale),
                next_memory,
            );
        }
    };

    let tick = observation.tick();
    let current_opponents = observation.opponents().current();
    if let Some(opponents) = current_opponents.filter(|opponents| !opponents.is_empty()) {
        if let Some(opponent) = nearest_opponent(agent.position(), opponents) {
            next_memory.last_opponent = Some(RememberedOpponent {
                id: opponent.id(),
                position: opponent.position(),
                observed_at: tick,
            });
        }
    }

    if border.is_near_or_outside(agent.position(), params.values().border_margin_blocks) {
        next_memory.last_goal = Some(Goal::EscapeBorder);
        return decision(
            Goal::EscapeBorder,
            Intent::NavigateTo(border.center(agent.position().y())),
            next_memory,
        );
    }

    let values = params.values();
    let nearest_known_threat = nearest_known_threat(observation, &next_memory, values, agent);
    let low_health = agent.health_half_hearts() <= values.retreat_at_health_half_hearts_or_below;
    if low_health {
        if let Some(threat) = nearest_known_threat {
            let tie_bit = threat.id().get() & 1 == 1;
            let retreat_target = agent.position().retreat_target(threat.position(), tie_bit);
            let goal = Goal::RetreatFromOpponent {
                target: threat.id(),
            };
            next_memory.last_goal = Some(goal);
            return decision(goal, Intent::NavigateTo(retreat_target), next_memory);
        }
    }

    let safe_to_eat = is_safe_to_eat(observation, &next_memory, values, agent);
    if safe_to_eat
        && agent.hunger_points() <= values.eat_at_hunger_or_below
        && agent.food_count() > 0
    {
        next_memory.last_goal = Some(Goal::RecoverHunger);
        return decision(Goal::RecoverHunger, Intent::Eat, next_memory);
    }

    if let Some(upgrade) = best_upgrade(agent) {
        let goal = Goal::ImproveEquipment {
            slot: upgrade.slot(),
            rating: upgrade.rating(),
        };
        next_memory.last_goal = Some(goal);
        return decision(
            goal,
            Intent::Equip {
                slot: upgrade.slot(),
                rating: upgrade.rating(),
            },
            next_memory,
        );
    }

    if let Some(opponent) = current_opponents
        .and_then(|opponents| nearest_opponent(agent.position(), opponents))
        .filter(|opponent| {
            agent.health_half_hearts() > values.retreat_at_health_half_hearts_or_below
                && agent
                    .position()
                    .squared_distance(opponent.position())
                    <= u128::from(values.fight_range_blocks).pow(2)
        })
    {
        let goal = Goal::EngageVisibleOpponent {
            target: opponent.id(),
        };
        next_memory.last_goal = Some(goal);
        let intent = if agent
            .position()
            .squared_distance(opponent.position())
            <= u128::from(MELEE_REACH_BLOCKS).pow(2)
        {
            Intent::Attack {
                target: opponent.id(),
            }
        } else {
            Intent::ApproachOpponent {
                target: opponent.id(),
            }
        };
        return decision(goal, intent, next_memory);
    }

    if let Some(target) = select_loot(observation, memory, agent, values) {
        let goal = Goal::Loot { target: target.id() };
        next_memory.last_goal = Some(goal);
        let intent = if agent.position().manhattan_distance(target.position())
            > LOOT_INTERACTION_DISTANCE_BLOCKS
        {
            Intent::NavigateTo(target.position())
        } else {
            match target {
                LootOpportunity::VisibleDrop { id, .. } => Intent::CollectDrop { target: id },
                LootOpportunity::UnopenedContainer { id, .. } => {
                    Intent::OpenContainer { target: id }
                }
            }
        };
        return decision(goal, intent, next_memory);
    }

    if let Some(remembered) = remembered_opponent(observation, &next_memory, values.opponent_memory_ticks)
    {
        let goal = Goal::SearchLastKnown {
            target: remembered.id,
        };
        next_memory.last_goal = Some(goal);
        return decision(goal, Intent::NavigateTo(remembered.position), next_memory);
    }

    let target = exploration_target(agent.position(), values.search_radius_blocks, random);
    next_memory.last_goal = Some(Goal::Explore);
    decision(Goal::Explore, Intent::NavigateTo(target), next_memory)
}

fn decision(goal: Goal, intent: Intent, memory: PolicyMemory) -> Decision {
    Decision {
        goal,
        intent,
        memory,
    }
}

fn nearest_opponent(
    position: BlockPosition,
    opponents: &[VisibleOpponent],
) -> Option<VisibleOpponent> {
    opponents.iter().copied().min_by_key(|opponent| {
        (
            position.squared_distance(opponent.position()),
            opponent.id(),
        )
    })
}

fn nearest_known_threat(
    observation: &AgentObservation,
    memory: &PolicyMemory,
    params: PolicyParamValues,
    agent: &AgentState,
) -> Option<VisibleOpponent> {
    let current = observation.opponents().current().and_then(|opponents| {
        nearest_opponent(agent.position(), opponents)
    });
    let remembered = remembered_opponent(observation, memory, params.opponent_memory_ticks).map(
        |opponent| VisibleOpponent::new(opponent.id, opponent.position, false),
    );
    [current, remembered]
        .into_iter()
        .flatten()
        .filter(|opponent| {
            agent.position().manhattan_distance(opponent.position())
                <= u64::from(params.fight_range_blocks) * 2
        })
        .min_by_key(|opponent| {
            (
                std::cmp::Reverse(opponent.is_attacking_agent()),
                agent.position().squared_distance(opponent.position()),
                opponent.id(),
            )
        })
}

fn is_safe_to_eat(
    observation: &AgentObservation,
    memory: &PolicyMemory,
    params: PolicyParamValues,
    agent: &AgentState,
) -> bool {
    let Some(opponents) = observation.opponents().current() else {
        return false;
    };

    opponents.is_empty() && nearest_known_threat(observation, memory, params, agent).is_none()
}

fn best_upgrade(agent: &AgentState) -> Option<crate::observation::EquipmentUpgrade> {
    agent
        .upgrades()
        .iter()
        .copied()
        .filter(|upgrade| match upgrade.slot() {
            EquipmentSlot::Weapon => upgrade.rating() > agent.weapon_rating(),
            EquipmentSlot::Armor => upgrade.rating() > agent.armor_rating(),
        })
        .min_by_key(|upgrade| (std::cmp::Reverse(upgrade.rating()), upgrade.slot()))
}

#[derive(Clone, Copy)]
struct LootChoice {
    opportunity: LootOpportunity,
    utility: u8,
    distance: u64,
}

fn select_loot(
    observation: &AgentObservation,
    memory: &PolicyMemory,
    agent: &AgentState,
    params: PolicyParamValues,
) -> Option<LootOpportunity> {
    let opportunities = observation.loot().current()?;
    let mut candidates: Vec<LootChoice> = opportunities
        .iter()
        .copied()
        .filter_map(|opportunity| {
            let utility = loot_utility(opportunity, agent);
            (utility > 0).then_some(LootChoice {
                opportunity,
                utility,
                distance: agent.position().manhattan_distance(opportunity.position()),
            })
        })
        .collect();
    candidates.sort_by_key(|candidate| {
        (
            std::cmp::Reverse(candidate.utility),
            candidate.distance,
            candidate.opportunity.id(),
        )
    });
    let best = *candidates.first()?;

    if let Some(Goal::Loot { target }) = memory.last_goal {
        if let Some(previous) = candidates
            .iter()
            .copied()
            .find(|candidate| candidate.opportunity.id() == target)
        {
            if previous.utility == best.utility
                && previous.distance
                    <= best
                        .distance
                        .saturating_add(params.loot_hysteresis_blocks)
            {
                return Some(previous.opportunity);
            }
        }
    }

    Some(best.opportunity)
}

fn loot_utility(opportunity: LootOpportunity, agent: &AgentState) -> u8 {
    match opportunity {
        LootOpportunity::VisibleDrop { item, .. } => match item {
            crate::observation::KnownItem::Food if agent.food_count() == 0 => 2,
            crate::observation::KnownItem::Weapon { rating }
                if rating > agent.weapon_rating() =>
            {
                3
            }
            crate::observation::KnownItem::Armor { rating } if rating > agent.armor_rating() => 3,
            crate::observation::KnownItem::Food
            | crate::observation::KnownItem::Weapon { .. }
            | crate::observation::KnownItem::Armor { .. } => 0,
        },
        LootOpportunity::UnopenedContainer { .. } => 1,
    }
}

fn remembered_opponent(
    observation: &AgentObservation,
    memory: &PolicyMemory,
    max_age_ticks: u64,
) -> Option<RememberedOpponent> {
    let from_memory = memory.last_opponent.filter(|opponent| {
        observation
            .tick()
            .get()
            .checked_sub(opponent.observed_at.get())
            .is_some_and(|age| age <= max_age_ticks)
    });
    let from_stale_observation = match observation.opponents().stale() {
        Some((opponents, observed_at))
            if observation.tick().get().saturating_sub(observed_at.get()) <= max_age_ticks =>
        {
            opponents
                .iter()
                .copied()
                .min_by_key(|opponent| {
                    (
                        observation.agent().current().map_or(
                            u128::MAX,
                            |agent| agent.position().squared_distance(opponent.position()),
                        ),
                        opponent.id(),
                    )
                })
                .map(|opponent| RememberedOpponent {
                    id: opponent.id(),
                    position: opponent.position(),
                    observed_at,
                })
        }
        _ => None,
    };

    match (from_memory, from_stale_observation) {
        (Some(memory), Some(stale)) if stale.observed_at > memory.observed_at => Some(stale),
        (Some(memory), _) => Some(memory),
        (None, stale) => stale,
    }
}

fn exploration_target(
    position: BlockPosition,
    radius: u32,
    random: &mut DeterministicRandom,
) -> BlockPosition {
    let radius = radius.min(i32::MAX as u32) as i32;
    let half = (radius / 2).max(1);
    match random.next_eight_way() {
        0 => position.offset(radius, 0, 0),
        1 => position.offset(radius, 0, half),
        2 => position.offset(0, 0, radius),
        3 => position.offset(-half, 0, radius),
        4 => position.offset(-radius, 0, 0),
        5 => position.offset(-radius, 0, -half),
        6 => position.offset(0, 0, -radius),
        _ => position.offset(half, 0, -radius),
    }
}

#[cfg(test)]
mod tests {
    use super::PolicyParams;

    #[test]
    fn baseline_parameters_are_inside_the_validation_bounds() {
        let values = PolicyParams::baseline().values();
        assert_eq!(values.eat_at_hunger_or_below, 8);
        assert_eq!(
            PolicyParams::new(values).unwrap(),
            PolicyParams::baseline()
        );
    }

    #[test]
    fn policy_parameters_reject_out_of_range_values() {
        let mut values = PolicyParams::baseline().values();
        values.opponent_memory_ticks = 101;
        assert!(matches!(
            PolicyParams::new(values),
            Err(super::InvalidPolicyParams::OpponentMemoryOutOfRange)
        ));

        let mut values = PolicyParams::baseline().values();
        values.eat_at_hunger_or_below = 0;
        assert!(matches!(
            PolicyParams::new(values),
            Err(super::InvalidPolicyParams::HungerThresholdOutOfRange)
        ));
    }
}
