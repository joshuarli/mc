#[path = "fixtures/policy_observations.rs"]
mod fixtures;

use arena_core::observation::{EquipmentSlot, EquipmentUpgrade};
use arena_core::policy::{
    Goal, Intent, PolicyMemory, PolicyParameterVersion, PolicyParamValues, PolicyParams,
    WaitReason,
};
use arena_core::random::{DeterministicRandom, RandomStream};
use arena_core::{
    decide, AgentObservation, AgentObservationInput, AgentState, BlockPosition, EntityId, Knowledge,
    ObservationError, ObservationField, ObservationSequence, Tick, WorldBorder,
};

fn params() -> PolicyParams {
    PolicyParams::baseline()
}

fn random() -> DeterministicRandom {
    DeterministicRandom::for_stream(
        481_516,
        RandomStream::Search {
            seat: arena_core::observation::SeatId::new(0),
        },
    )
}

fn decide_for(observation: &AgentObservation, memory: &PolicyMemory) -> arena_core::Decision {
    decide(observation, memory, &params(), &mut random())
}

#[test]
fn priority_escapes_border_before_eating() {
    let state = fixtures::agent(BlockPosition::new(99, 64, 0), 40, 2, 2);
    let observation = fixtures::observation(
        10,
        Knowledge::Current(state),
        Knowledge::Current(WorldBorder::new(0, 0, 100).unwrap()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(Vec::new()),
    );

    let decision = decide_for(&observation, &PolicyMemory::new());
    assert_eq!(decision.goal(), Goal::EscapeBorder);
    assert_eq!(decision.intent(), Intent::NavigateTo(BlockPosition::new(0, 64, 0)));
}

#[test]
fn eating_requires_a_current_empty_opponent_set() {
    let state = fixtures::agent(BlockPosition::new(0, 64, 0), 40, 4, 1);
    let current_empty = fixtures::observation(
        10,
        Knowledge::Current(state.clone()),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(Vec::new()),
    );
    let unknown_enemies = fixtures::observation(
        10,
        Knowledge::Current(state),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Unknown,
        Knowledge::Current(Vec::new()),
    );

    assert_eq!(
        decide_for(&current_empty, &PolicyMemory::new()).goal(),
        Goal::RecoverHunger
    );
    assert_eq!(
        decide_for(&unknown_enemies, &PolicyMemory::new()).goal(),
        Goal::Explore
    );
}

#[test]
fn low_health_retreats_from_a_visible_opponent() {
    let observation = fixtures::observation(
        20,
        Knowledge::Current(fixtures::agent(BlockPosition::new(0, 64, 0), 6, 20, 0)),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(vec![fixtures::opponent(7, BlockPosition::new(2, 64, 0))]),
        Knowledge::Current(Vec::new()),
    );

    let decision = decide_for(&observation, &PolicyMemory::new());
    assert_eq!(decision.goal(), Goal::RetreatFromOpponent { target: EntityId::new(7).unwrap() });
    assert_eq!(decision.intent(), Intent::NavigateTo(BlockPosition::new(-4, 64, 0)));
}

#[test]
fn equipment_upgrade_precedes_favorable_combat() {
    let state = AgentState::new(
        BlockPosition::new(0, 64, 0),
        40,
        20,
        0,
        1,
        1,
        vec![EquipmentUpgrade::new(EquipmentSlot::Weapon, 3)],
    )
    .unwrap();
    let observation = fixtures::observation(
        21,
        Knowledge::Current(state),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(vec![fixtures::opponent(9, BlockPosition::new(1, 64, 0))]),
        Knowledge::Current(Vec::new()),
    );

    let decision = decide_for(&observation, &PolicyMemory::new());
    assert_eq!(
        decision.goal(),
        Goal::ImproveEquipment {
            slot: EquipmentSlot::Weapon,
            rating: 3,
        }
    );
    assert_eq!(
        decision.intent(),
        Intent::Equip {
            slot: EquipmentSlot::Weapon,
            rating: 3,
        }
    );
}

#[test]
fn combat_requires_a_current_visible_opponent() {
    let state = fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0);
    let current = fixtures::observation(
        30,
        Knowledge::Current(state.clone()),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(vec![fixtures::opponent(10, BlockPosition::new(1, 64, 0))]),
        Knowledge::Current(Vec::new()),
    );
    let stale = fixtures::observation(
        30,
        Knowledge::Current(state),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Stale {
            value: vec![fixtures::opponent(10, BlockPosition::new(1, 64, 0))],
            observed_at: Tick::new(29),
        },
        Knowledge::Current(Vec::new()),
    );

    assert_eq!(
        decide_for(&current, &PolicyMemory::new()).goal(),
        Goal::EngageVisibleOpponent {
            target: EntityId::new(10).unwrap()
        }
    );
    assert_ne!(
        decide_for(&stale, &PolicyMemory::new()).goal(),
        Goal::EngageVisibleOpponent {
            target: EntityId::new(10).unwrap()
        }
    );
}

#[test]
fn visible_opponents_are_approached_before_melee_reach() {
    let target = EntityId::new(11).unwrap();
    let observation = fixtures::observation(
        31,
        Knowledge::Current(fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0)),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(vec![fixtures::opponent(11, BlockPosition::new(4, 64, 0))]),
        Knowledge::Current(Vec::new()),
    );

    let decision = decide_for(&observation, &PolicyMemory::new());
    assert_eq!(
        decision.goal(),
        Goal::EngageVisibleOpponent { target }
    );
    assert_eq!(decision.intent(), Intent::ApproachOpponent { target });
}

#[test]
fn loot_tie_break_is_stable_and_hysteretic() {
    let state = fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0);
    let first = fixtures::container(14, BlockPosition::new(4, 64, 0));
    let tied = fixtures::container(12, BlockPosition::new(-4, 64, 0));
    let first_order = fixtures::observation(
        40,
        Knowledge::Current(state.clone()),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(vec![first, tied]),
    );
    let reversed_order = fixtures::observation(
        40,
        Knowledge::Current(state.clone()),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(vec![tied, first]),
    );
    let memory = PolicyMemory::new();
    let selected = decide_for(&first_order, &memory);
    assert_eq!(selected.goal(), Goal::Loot { target: EntityId::new(12).unwrap() });
    assert_eq!(
        decide_for(&reversed_order, &memory).goal(),
        selected.goal()
    );

    let prior = fixtures::container(12, BlockPosition::new(5, 64, 0));
    let closer_now = fixtures::container(14, BlockPosition::new(4, 64, 0));
    let near_tie = fixtures::observation(
        41,
        Knowledge::Current(state),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(vec![closer_now, prior]),
    );
    assert_eq!(
        decide_for(&near_tie, selected.memory()).goal(),
        Goal::Loot { target: EntityId::new(12).unwrap() }
    );
}

#[test]
fn useful_visible_food_outranks_an_unopened_container() {
    let observation = fixtures::observation(
        42,
        Knowledge::Current(fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0)),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(vec![
            fixtures::container(30, BlockPosition::new(1, 64, 0)),
            fixtures::food_drop(31, BlockPosition::new(5, 64, 0)),
        ]),
    );

    assert_eq!(
        decide_for(&observation, &PolicyMemory::new()).goal(),
        Goal::Loot {
            target: EntityId::new(31).unwrap()
        }
    );
}

#[test]
fn stale_opponents_are_searched_but_never_attacked() {
    let observation = fixtures::observation(
        50,
        Knowledge::Current(fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0)),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Stale {
            value: vec![fixtures::opponent(15, BlockPosition::new(12, 64, 0))],
            observed_at: Tick::new(49),
        },
        Knowledge::Current(Vec::new()),
    );

    let decision = decide_for(&observation, &PolicyMemory::new());
    assert_eq!(decision.goal(), Goal::SearchLastKnown { target: EntityId::new(15).unwrap() });
    assert_eq!(decision.intent(), Intent::NavigateTo(BlockPosition::new(12, 64, 0)));
}

#[test]
fn future_memory_is_not_treated_as_last_seen_information() {
    let future_observation = fixtures::observation(
        100,
        Knowledge::Current(fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0)),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(vec![fixtures::opponent(16, BlockPosition::new(12, 64, 0))]),
        Knowledge::Current(Vec::new()),
    );
    let future_memory = decide_for(&future_observation, &PolicyMemory::new()).into_memory();
    let earlier_observation = fixtures::observation(
        50,
        Knowledge::Current(fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0)),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(Vec::new()),
    );

    assert_eq!(
        decide_for(&earlier_observation, &future_memory).goal(),
        Goal::Explore
    );
}

#[test]
fn unknown_or_stale_agent_state_holds() {
    let unknown = fixtures::observation(
        60,
        Knowledge::Unknown,
        Knowledge::Unknown,
        Knowledge::Unknown,
        Knowledge::Unknown,
    );
    let stale = fixtures::observation(
        60,
        Knowledge::Stale {
            value: fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0),
            observed_at: Tick::new(59),
        },
        Knowledge::Unknown,
        Knowledge::Unknown,
        Knowledge::Unknown,
    );

    assert_eq!(
        decide_for(&unknown, &PolicyMemory::new()).goal(),
        Goal::Wait(WaitReason::AgentStateUnknown)
    );
    assert_eq!(
        decide_for(&stale, &PolicyMemory::new()).goal(),
        Goal::Wait(WaitReason::AgentStateStale)
    );
}

#[test]
fn unknown_or_stale_border_holds_movement() {
    let state = Knowledge::Current(fixtures::agent(
        BlockPosition::new(0, 64, 0),
        40,
        20,
        0,
    ));
    let unknown = fixtures::observation(
        61,
        state.clone(),
        Knowledge::Unknown,
        Knowledge::Current(Vec::new()),
        Knowledge::Current(Vec::new()),
    );
    let stale = fixtures::observation(
        61,
        state,
        Knowledge::Stale {
            value: fixtures::safe_border(),
            observed_at: Tick::new(60),
        },
        Knowledge::Current(Vec::new()),
        Knowledge::Current(Vec::new()),
    );

    assert_eq!(
        decide_for(&unknown, &PolicyMemory::new()).goal(),
        Goal::Wait(WaitReason::BorderUnknown)
    );
    assert_eq!(
        decide_for(&stale, &PolicyMemory::new()).goal(),
        Goal::Wait(WaitReason::BorderStale)
    );
}

#[test]
fn exploration_uses_the_recorded_random_stream() {
    let observation = fixtures::observation(
        70,
        Knowledge::Current(fixtures::agent(BlockPosition::new(0, 64, 0), 40, 20, 0)),
        Knowledge::Current(fixtures::safe_border()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(Vec::new()),
    );
    let mut first = random();
    let mut replay = random();
    let one = decide(&observation, &PolicyMemory::new(), &params(), &mut first);
    let two = decide(&observation, &PolicyMemory::new(), &params(), &mut replay);

    assert_eq!(one, two);
    assert_eq!(one.goal(), Goal::Explore);
    assert_ne!(one.intent(), Intent::Hold(WaitReason::AgentStateUnknown));
}

#[test]
fn policy_param_draft_has_named_validated_ranges() {
    let mut values = PolicyParams::baseline().values();
    values.fight_range_blocks = 9;
    assert!(PolicyParams::new(values).is_err());

    let values = PolicyParamValues {
        version: PolicyParameterVersion::V1,
        eat_at_hunger_or_below: 8,
        retreat_at_health_half_hearts_or_below: 8,
        border_margin_blocks: 2,
        fight_range_blocks: 4,
        opponent_memory_ticks: 100,
        loot_hysteresis_blocks: 2,
        search_radius_blocks: 8,
    };
    assert_eq!(PolicyParams::new(values).unwrap(), PolicyParams::baseline());
}

#[test]
fn observation_rejects_invalid_stale_ticks_and_duplicate_entities() {
    let invalid_stale = AgentObservation::new(AgentObservationInput {
        tick: Tick::new(1),
        sequence: ObservationSequence::new(1).unwrap(),
        agent: Knowledge::Unknown,
        border: Knowledge::Stale {
            value: fixtures::safe_border(),
            observed_at: Tick::new(1),
        },
        opponents: Knowledge::Unknown,
        loot: Knowledge::Unknown,
    });
    assert!(matches!(
        invalid_stale,
        Err(ObservationError::StaleSampleNotOlder {
            field: ObservationField::Border,
            ..
        })
    ));

    let duplicate = AgentObservation::new(AgentObservationInput {
        tick: Tick::new(2),
        sequence: ObservationSequence::new(2).unwrap(),
        agent: Knowledge::Unknown,
        border: Knowledge::Unknown,
        opponents: Knowledge::Current(vec![
            fixtures::opponent(2, BlockPosition::new(1, 64, 0)),
            fixtures::opponent(2, BlockPosition::new(2, 64, 0)),
        ]),
        loot: Knowledge::Unknown,
    });
    assert!(matches!(
        duplicate,
        Err(ObservationError::DuplicateEntityId {
            field: ObservationField::Opponents,
            id,
        }) if id == EntityId::new(2).unwrap()
    ));
}

#[test]
fn benchmark_seat_ids_accept_slot_255() {
    let highest_slot = arena_core::observation::SeatId::new(u8::MAX);
    assert_eq!(highest_slot.get(), u8::MAX);

    let mut highest_stream = DeterministicRandom::for_stream(
        481_516,
        RandomStream::Search { seat: highest_slot },
    );
    let mut first_stream = random();
    assert_ne!(highest_stream.next_u64(), first_stream.next_u64());
}

#[test]
fn retreat_target_overflow_returns_explicit_wait() {
    let position = BlockPosition::new(i32::MAX, 64, 0);
    let observation = fixtures::observation(
        80,
        Knowledge::Current(fixtures::agent(position, 6, 20, 0)),
        Knowledge::Current(WorldBorder::new(i32::MAX, 0, 100).unwrap()),
        Knowledge::Current(vec![fixtures::opponent(
            9,
            BlockPosition::new(i32::MAX - 2, 64, 0),
        )]),
        Knowledge::Current(Vec::new()),
    );

    let decision = decide_for(&observation, &PolicyMemory::new());
    let reason = WaitReason::UnrepresentableTarget;
    assert_eq!(decision.goal(), Goal::Wait(reason));
    assert_eq!(decision.intent(), Intent::Hold(reason));
}

#[test]
fn exploration_target_overflow_returns_explicit_wait() {
    let observation = fixtures::observation(
        81,
        Knowledge::Current(fixtures::agent(
            BlockPosition::new(i32::MAX, 64, 0),
            40,
            20,
            0,
        )),
        Knowledge::Current(WorldBorder::new(i32::MAX, 0, 100).unwrap()),
        Knowledge::Current(Vec::new()),
        Knowledge::Current(Vec::new()),
    );
    let mut random = DeterministicRandom::new(0);

    let decision = decide(&observation, &PolicyMemory::new(), &params(), &mut random);
    let reason = WaitReason::UnrepresentableTarget;
    assert_eq!(decision.goal(), Goal::Wait(reason));
    assert_eq!(decision.intent(), Intent::Hold(reason));
}
