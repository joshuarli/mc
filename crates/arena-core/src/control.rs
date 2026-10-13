use std::num::NonZeroU64;

/// A per-direction control-stream sequence that cannot represent zero.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Sequence(NonZeroU64);

impl Sequence {
    pub const fn new(value: NonZeroU64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

impl TryFrom<u64> for Sequence {
    type Error = std::num::TryFromIntError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        let nonzero = NonZeroU64::try_from(value)?;
        Ok(Self::new(nonzero))
    }
}

#[cfg(test)]
mod tests {
    use super::Sequence;

    #[test]
    fn sequence_round_trips_nonzero_values() {
        assert_eq!(Sequence::try_from(1).unwrap().get(), 1);
        assert_eq!(Sequence::try_from(u64::MAX).unwrap().get(), u64::MAX);
    }

    #[test]
    fn sequence_rejects_zero() {
        assert!(Sequence::try_from(0).is_err());
    }
}
