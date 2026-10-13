use arena_core::{
    AgentObservation, AgentObservationInput, AgentState, BlockPosition, EntityId, Knowledge,
    ObservationSequence, Tick, WorldBorder,
};
use arena_core::observation::{
    EquipmentUpgrade, KnownItem, LootOpportunity, VisibleOpponent,
};

pub fn agent(
    position: BlockPosition,
    health_half_hearts: u8,
    hunger_points: u8,
    food_count: u16,
) -> AgentState {
    AgentState::new(
        position,
        health_half_hearts,
        hunger_points,
        food_count,
        1,
        1,
        Vec::<EquipmentUpgrade>::new(),
    )
    .unwrap()
}

pub fn opponent(id: u64, position: BlockPosition) -> VisibleOpponent {
    VisibleOpponent::new(EntityId::new(id).unwrap(), position, false)
}

pub fn container(id: u64, position: BlockPosition) -> LootOpportunity {
    LootOpportunity::UnopenedContainer {
        id: EntityId::new(id).unwrap(),
        position,
    }
}

pub fn food_drop(id: u64, position: BlockPosition) -> LootOpportunity {
    LootOpportunity::VisibleDrop {
        id: EntityId::new(id).unwrap(),
        position,
        item: KnownItem::Food,
    }
}

pub fn observation(
    tick: u64,
    agent: Knowledge<AgentState>,
    border: Knowledge<WorldBorder>,
    opponents: Knowledge<Vec<VisibleOpponent>>,
    loot: Knowledge<Vec<LootOpportunity>>,
) -> AgentObservation {
    AgentObservation::new(AgentObservationInput {
        tick: Tick::new(tick),
        sequence: ObservationSequence::new(tick.max(1)).unwrap(),
        agent,
        border,
        opponents,
        loot,
    })
    .unwrap()
}

pub fn safe_border() -> WorldBorder {
    WorldBorder::new(0, 0, 100).unwrap()
}
