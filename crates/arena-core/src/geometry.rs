//! Integer geometry shared by deterministic policy and simulation code.

/// An authoritative or client-observed tick count.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Tick(u64);

impl Tick {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

/// A block-aligned world position. Keeping policy geometry integral avoids
/// architecture-sensitive floating-point comparisons and tie breaks.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct BlockPosition {
    x: i32,
    y: i32,
    z: i32,
}

impl BlockPosition {
    pub const fn new(x: i32, y: i32, z: i32) -> Self {
        Self { x, y, z }
    }

    pub const fn x(self) -> i32 {
        self.x
    }

    pub const fn y(self) -> i32 {
        self.y
    }

    pub const fn z(self) -> i32 {
        self.z
    }

    /// Returns Manhattan distance in blocks, suitable for stable local target
    /// ranking and explicit hysteresis bands.
    pub fn manhattan_distance(self, other: Self) -> u64 {
        i64::from(self.x).abs_diff(i64::from(other.x))
            + i64::from(self.y).abs_diff(i64::from(other.y))
            + i64::from(self.z).abs_diff(i64::from(other.z))
    }

    /// Returns exact squared Euclidean distance in blocks without overflow for
    /// every pair of representable positions.
    pub fn squared_distance(self, other: Self) -> u128 {
        let dx = i128::from(self.x) - i128::from(other.x);
        let dy = i128::from(self.y) - i128::from(other.y);
        let dz = i128::from(self.z) - i128::from(other.z);
        (dx * dx + dy * dy + dz * dz) as u128
    }

    /// Returns `None` if adding any block offset leaves the representable world
    /// coordinate range.
    pub const fn checked_offset(self, dx: i32, dy: i32, dz: i32) -> Option<Self> {
        let Some(x) = self.x.checked_add(dx) else {
            return None;
        };
        let Some(y) = self.y.checked_add(dy) else {
            return None;
        };
        let Some(z) = self.z.checked_add(dz) else {
            return None;
        };

        Some(Self { x, y, z })
    }

    /// Returns a block-level point four steps away from `threat`. A coincident
    /// pair uses the caller-provided stable bit so zero distance has a direction.
    /// Returns `None` if the target is outside the representable coordinate range.
    pub fn retreat_target(self, threat: Self, tie_bit: bool) -> Option<Self> {
        let dx = (i64::from(self.x) - i64::from(threat.x)).signum() as i32;
        let dz = (i64::from(self.z) - i64::from(threat.z)).signum() as i32;
        if dx == 0 && dz == 0 {
            return self.checked_offset(if tie_bit { 4 } else { -4 }, 0, 0);
        }

        self.checked_offset(dx * 4, 0, dz * 4)
    }
}

/// A circular horizontal border in block coordinates.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorldBorder {
    center_x: i32,
    center_z: i32,
    radius_blocks: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidWorldBorder;

impl WorldBorder {
    pub fn new(center_x: i32, center_z: i32, radius_blocks: u32) -> Result<Self, InvalidWorldBorder> {
        if radius_blocks == 0 {
            return Err(InvalidWorldBorder);
        }

        Ok(Self {
            center_x,
            center_z,
            radius_blocks,
        })
    }

    pub const fn center(self, y: i32) -> BlockPosition {
        BlockPosition::new(self.center_x, y, self.center_z)
    }

    pub const fn radius_blocks(self) -> u32 {
        self.radius_blocks
    }

    pub fn is_outside(self, position: BlockPosition) -> bool {
        let dx = i128::from(position.x) - i128::from(self.center_x);
        let dz = i128::from(position.z) - i128::from(self.center_z);
        let radius = i128::from(self.radius_blocks);
        dx * dx + dz * dz > radius * radius
    }

    /// Returns whether the agent is outside the playable radius after applying
    /// an inward safety margin. The margin is capped at the border radius.
    pub fn is_near_or_outside(self, position: BlockPosition, margin_blocks: u32) -> bool {
        if self.is_outside(position) {
            return true;
        }

        let safe_radius = self.radius_blocks.saturating_sub(margin_blocks.min(self.radius_blocks));
        let dx = i128::from(position.x) - i128::from(self.center_x);
        let dz = i128::from(position.z) - i128::from(self.center_z);
        let safe_radius = i128::from(safe_radius);
        dx * dx + dz * dz >= safe_radius * safe_radius
    }
}

#[cfg(test)]
mod tests {
    use super::{BlockPosition, WorldBorder};

    #[test]
    fn world_border_uses_horizontal_distance_and_inward_margin() {
        let border = WorldBorder::new(0, 0, 10).unwrap();
        assert!(border.is_near_or_outside(BlockPosition::new(9, 100, 0), 2));
        assert!(!border.is_near_or_outside(BlockPosition::new(7, -100, 0), 2));
        assert!(border.is_outside(BlockPosition::new(11, 0, 0)));
    }

    #[test]
    fn geometry_handles_full_integer_coordinate_range() {
        let low = BlockPosition::new(i32::MIN, i32::MIN, i32::MIN);
        let high = BlockPosition::new(i32::MAX, i32::MAX, i32::MAX);
        assert_eq!(low.squared_distance(high), 55_340_232_195_358_851_075);
        assert_eq!(low.manhattan_distance(high), 12_884_901_885);
    }

    #[test]
    fn checked_offset_rejects_overflow_on_every_axis() {
        let max = BlockPosition::new(i32::MAX, 64, 0);
        let min = BlockPosition::new(i32::MIN, 64, 0);

        assert_eq!(max.checked_offset(1, 0, 0), None);
        assert_eq!(min.checked_offset(-1, 0, 0), None);
        assert_eq!(BlockPosition::new(0, i32::MAX, 0).checked_offset(0, 1, 0), None);
        assert_eq!(BlockPosition::new(0, i32::MIN, 0).checked_offset(0, -1, 0), None);
        assert_eq!(BlockPosition::new(0, 0, i32::MIN).checked_offset(0, 0, -1), None);
        assert_eq!(BlockPosition::new(0, 0, i32::MAX).checked_offset(0, 0, 1), None);
        assert_eq!(
            max.checked_offset(-1, 0, 0),
            Some(BlockPosition::new(i32::MAX - 1, 64, 0))
        );
    }

    #[test]
    fn a_zero_radius_border_is_rejected() {
        assert!(WorldBorder::new(0, 0, 0).is_err());
    }
}
