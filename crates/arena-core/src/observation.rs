//! Bounded policy observations. These types contain only inputs a client may
//! have received; evaluator-only world state has no representation here.

use std::num::NonZeroU64;

use crate::geometry::{BlockPosition, Tick, WorldBorder};

/// Stable match seat identity; usernames and runtime entity IDs are not seats.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SeatId(u8);

impl SeatId {
    pub const SEAT_COUNT: u8 = 6;

    pub const fn new(value: u8) -> Option<Self> {
        if value < Self::SEAT_COUNT {
            Some(Self(value))
        } else {
            None
        }
    }

    pub const fn get(self) -> u8 {
        self.0
    }
}

/// A nonzero client-visible runtime entity identifier.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EntityId(NonZeroU64);

impl EntityId {
    pub const fn new(value: u64) -> Option<Self> {
        match NonZeroU64::new(value) {
            Some(value) => Some(Self(value)),
            None => None,
        }
    }

    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

/// A nonzero sequence number in one client's observation stream.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ObservationSequence(NonZeroU64);

impl ObservationSequence {
    pub const fn new(value: u64) -> Option<Self> {
        match NonZeroU64::new(value) {
            Some(value) => Some(Self(value)),
            None => None,
        }
    }

    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

/// Freshness is explicit so callers cannot accidentally treat last-seen data
/// as a current server snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Knowledge<T> {
    Unknown,
    Stale { value: T, observed_at: Tick },
    Current(T),
}

impl<T> Knowledge<T> {
    pub const fn current(&self) -> Option<&T> {
        match self {
            Self::Current(value) => Some(value),
            Self::Unknown | Self::Stale { .. } => None,
        }
    }

    pub const fn stale(&self) -> Option<(&T, Tick)> {
        match self {
            Self::Stale { value, observed_at } => Some((value, *observed_at)),
            Self::Unknown | Self::Current(_) => None,
        }
    }
}

/// Current equipment choices from the agent's own received inventory.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum EquipmentSlot {
    Weapon,
    Armor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EquipmentUpgrade {
    slot: EquipmentSlot,
    rating: u8,
}

impl EquipmentUpgrade {
    pub const fn new(slot: EquipmentSlot, rating: u8) -> Self {
        Self { slot, rating }
    }

    pub const fn slot(self) -> EquipmentSlot {
        self.slot
    }

    pub const fn rating(self) -> u8 {
        self.rating
    }
}

/// The agent's own state, reconstructed from its confirmed client view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentState {
    position: BlockPosition,
    health_half_hearts: u8,
    hunger_points: u8,
    food_count: u16,
    weapon_rating: u8,
    armor_rating: u8,
    upgrades: Vec<EquipmentUpgrade>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidAgentState {
    HealthOutOfRange,
    HungerOutOfRange,
}

impl AgentState {
    pub fn new(
        position: BlockPosition,
        health_half_hearts: u8,
        hunger_points: u8,
        food_count: u16,
        weapon_rating: u8,
        armor_rating: u8,
        upgrades: Vec<EquipmentUpgrade>,
    ) -> Result<Self, InvalidAgentState> {
        if health_half_hearts > 40 {
            return Err(InvalidAgentState::HealthOutOfRange);
        }
        if hunger_points > 20 {
            return Err(InvalidAgentState::HungerOutOfRange);
        }

        Ok(Self {
            position,
            health_half_hearts,
            hunger_points,
            food_count,
            weapon_rating,
            armor_rating,
            upgrades,
        })
    }

    pub const fn position(&self) -> BlockPosition {
        self.position
    }

    pub const fn health_half_hearts(&self) -> u8 {
        self.health_half_hearts
    }

    pub const fn hunger_points(&self) -> u8 {
        self.hunger_points
    }

    pub const fn food_count(&self) -> u16 {
        self.food_count
    }

    pub const fn weapon_rating(&self) -> u8 {
        self.weapon_rating
    }

    pub const fn armor_rating(&self) -> u8 {
        self.armor_rating
    }

    pub fn upgrades(&self) -> &[EquipmentUpgrade] {
        &self.upgrades
    }
}

/// A currently visible, targetable competitor. The adapter omits spectators
/// and other non-combat entities; health and inventory are intentionally absent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VisibleOpponent {
    id: EntityId,
    position: BlockPosition,
    attacking_agent: bool,
}

impl VisibleOpponent {
    pub const fn new(id: EntityId, position: BlockPosition, attacking_agent: bool) -> Self {
        Self {
            id,
            position,
            attacking_agent,
        }
    }

    pub const fn id(self) -> EntityId {
        self.id
    }

    pub const fn position(self) -> BlockPosition {
        self.position
    }

    pub const fn is_attacking_agent(self) -> bool {
        self.attacking_agent
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KnownItem {
    Food,
    Weapon { rating: u8 },
    Armor { rating: u8 },
}

/// An observed drop exposes its item type. An unopened container exposes only
/// that a container exists; its contents remain unknown.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LootOpportunity {
    VisibleDrop {
        id: EntityId,
        position: BlockPosition,
        item: KnownItem,
    },
    UnopenedContainer {
        id: EntityId,
        position: BlockPosition,
    },
}

impl LootOpportunity {
    pub const fn id(self) -> EntityId {
        match self {
            Self::VisibleDrop { id, .. } | Self::UnopenedContainer { id, .. } => id,
        }
    }

    pub const fn position(self) -> BlockPosition {
        match self {
            Self::VisibleDrop { position, .. } | Self::UnopenedContainer { position, .. } => {
                position
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationField {
    Agent,
    Border,
    Opponents,
    Loot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationError {
    StaleSampleNotOlder {
        field: ObservationField,
        current_tick: Tick,
        observed_at: Tick,
    },
    DuplicateEntityId {
        field: ObservationField,
        id: EntityId,
    },
}

pub struct AgentObservationInput {
    pub tick: Tick,
    pub sequence: ObservationSequence,
    pub agent: Knowledge<AgentState>,
    pub border: Knowledge<WorldBorder>,
    pub opponents: Knowledge<Vec<VisibleOpponent>>,
    pub loot: Knowledge<Vec<LootOpportunity>>,
}

/// A complete policy input at one observation sequence and tick.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentObservation {
    tick: Tick,
    sequence: ObservationSequence,
    agent: Knowledge<AgentState>,
    border: Knowledge<WorldBorder>,
    opponents: Knowledge<Vec<VisibleOpponent>>,
    loot: Knowledge<Vec<LootOpportunity>>,
}

impl AgentObservation {
    pub fn new(input: AgentObservationInput) -> Result<Self, ObservationError> {
        validate_freshness(ObservationField::Agent, input.tick, &input.agent)?;
        validate_freshness(ObservationField::Border, input.tick, &input.border)?;
        validate_freshness(ObservationField::Opponents, input.tick, &input.opponents)?;
        validate_freshness(ObservationField::Loot, input.tick, &input.loot)?;
        validate_unique_ids(ObservationField::Opponents, &input.opponents, |opponent| {
            opponent.id()
        })?;
        validate_unique_ids(ObservationField::Loot, &input.loot, |opportunity| {
            opportunity.id()
        })?;

        Ok(Self {
            tick: input.tick,
            sequence: input.sequence,
            agent: input.agent,
            border: input.border,
            opponents: input.opponents,
            loot: input.loot,
        })
    }

    pub const fn tick(&self) -> Tick {
        self.tick
    }

    pub const fn sequence(&self) -> ObservationSequence {
        self.sequence
    }

    pub const fn agent(&self) -> &Knowledge<AgentState> {
        &self.agent
    }

    pub const fn border(&self) -> &Knowledge<WorldBorder> {
        &self.border
    }

    pub const fn opponents(&self) -> &Knowledge<Vec<VisibleOpponent>> {
        &self.opponents
    }

    pub const fn loot(&self) -> &Knowledge<Vec<LootOpportunity>> {
        &self.loot
    }
}

fn validate_freshness<T>(
    field: ObservationField,
    current_tick: Tick,
    knowledge: &Knowledge<T>,
) -> Result<(), ObservationError> {
    if let Knowledge::Stale { observed_at, .. } = knowledge {
        if *observed_at >= current_tick {
            return Err(ObservationError::StaleSampleNotOlder {
                field,
                current_tick,
                observed_at: *observed_at,
            });
        }
    }

    Ok(())
}

fn validate_unique_ids<T>(
    field: ObservationField,
    knowledge: &Knowledge<Vec<T>>,
    id_of: impl Fn(&T) -> EntityId,
) -> Result<(), ObservationError> {
    let values = match knowledge {
        Knowledge::Unknown => return Ok(()),
        Knowledge::Current(values) | Knowledge::Stale { value: values, .. } => values,
    };

    for (index, value) in values.iter().enumerate() {
        let id = id_of(value);
        if values[..index].iter().any(|prior| id_of(prior) == id) {
            return Err(ObservationError::DuplicateEntityId { field, id });
        }
    }

    Ok(())
}
