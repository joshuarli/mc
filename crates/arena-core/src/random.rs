//! Pinned deterministic random streams for replayable policy decisions.

use crate::observation::SeatId;

/// Distinct deterministic streams keep policy choices independent from search
/// and world setup draws.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RandomStream {
    Policy { seat: SeatId },
    Search { seat: SeatId },
    Setup,
}

/// SplitMix64 with the reference algorithm and constants fixed by this crate.
/// The state is private so callers cannot accidentally skip or rewind draws.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeterministicRandom {
    state: u64,
}

impl DeterministicRandom {
    pub const fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// Derives a reproducible stream from the run seed and a closed purpose key.
    pub fn for_stream(seed: u64, stream: RandomStream) -> Self {
        let key = match stream {
            RandomStream::Policy { seat } => 0x504f_4c49_4359_0000 ^ u64::from(seat.get()),
            RandomStream::Search { seat } => 0x5345_4152_4348_0000 ^ u64::from(seat.get()),
            RandomStream::Setup => 0x5345_5455_5000_0000,
        };
        Self::new(mix64(seed ^ key))
    }

    /// Returns the next SplitMix64 output. For seed zero the first outputs are
    /// `e220a8397b1dcdaf`, `6e789e6aa1b965f4`, and `06c45d188009454f`.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        mix64(self.state)
    }

    /// Selects one of eight equally sized search directions.
    pub fn next_eight_way(&mut self) -> u8 {
        (self.next_u64() & 7) as u8
    }
}

fn mix64(mut value: u64) -> u64 {
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::{DeterministicRandom, RandomStream};
    use crate::observation::SeatId;

    #[test]
    fn splitmix64_matches_reference_vectors() {
        let mut random = DeterministicRandom::new(0);
        assert_eq!(random.next_u64(), 0xe220_a839_7b1d_cdaf);
        assert_eq!(random.next_u64(), 0x6e78_9e6a_a1b9_65f4);
        assert_eq!(random.next_u64(), 0x06c4_5d18_8009_454f);
        assert_eq!(random.next_u64(), 0xf88b_b8a8_724c_81ec);
    }

    #[test]
    fn stream_keys_are_repeatable_and_separate() {
        let first_seat = SeatId::new(0).unwrap();
        let second_seat = SeatId::new(1).unwrap();
        let first = RandomStream::Search { seat: first_seat };
        let second = RandomStream::Search { seat: second_seat };
        let other_purpose = RandomStream::Policy { seat: first_seat };

        let mut repeated = DeterministicRandom::for_stream(481_516, first);
        let mut same = DeterministicRandom::for_stream(481_516, first);
        let mut different_seat = DeterministicRandom::for_stream(481_516, second);
        let mut different_purpose = DeterministicRandom::for_stream(481_516, other_purpose);

        let expected = repeated.next_u64();
        assert_eq!(same.next_u64(), expected);
        assert_ne!(different_seat.next_u64(), expected);
        assert_ne!(different_purpose.next_u64(), expected);
    }
}
