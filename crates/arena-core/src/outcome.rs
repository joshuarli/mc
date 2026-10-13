//! Closed skill outcomes used by policy and adapter boundaries.

use std::num::NonZeroU16;

/// A progress value that is strictly between pending and succeeded.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SkillProgress {
    completed_steps: u16,
    total_steps: NonZeroU16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidSkillProgress;

impl SkillProgress {
    pub fn new(completed_steps: u16, total_steps: u16) -> Result<Self, InvalidSkillProgress> {
        let total_steps = NonZeroU16::new(total_steps).ok_or(InvalidSkillProgress)?;
        if completed_steps == 0 || completed_steps >= total_steps.get() {
            return Err(InvalidSkillProgress);
        }

        Ok(Self {
            completed_steps,
            total_steps,
        })
    }

    pub const fn completed_steps(self) -> u16 {
        self.completed_steps
    }

    pub const fn total_steps(self) -> u16 {
        self.total_steps.get()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillFailure {
    PreconditionsNotMet,
    NoProgress,
    ServerRejected,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillCancellation {
    Replaced,
    AgentEliminated,
    Shutdown,
}

/// A skill's observed lifecycle result; progress cannot encode completion.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillOutcome {
    Pending,
    Progress(SkillProgress),
    Succeeded,
    Failed(SkillFailure),
    Cancelled(SkillCancellation),
}

#[cfg(test)]
mod tests {
    use super::SkillProgress;

    #[test]
    fn skill_progress_excludes_pending_and_completed_states() {
        assert!(SkillProgress::new(0, 4).is_err());
        assert!(SkillProgress::new(4, 4).is_err());
        assert!(SkillProgress::new(1, 0).is_err());

        let progress = SkillProgress::new(3, 4).unwrap();
        assert_eq!(progress.completed_steps(), 3);
        assert_eq!(progress.total_steps(), 4);
    }
}
