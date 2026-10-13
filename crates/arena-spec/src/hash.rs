use std::fmt;

use sha2::{Digest, Sha256};

/// A deterministic SHA-256 identity for compiled scenario or map semantics.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SemanticId([u8; 32]);

impl SemanticId {
    pub(crate) fn from_hasher(hasher: Sha256) -> Self {
        Self(hasher.finalize().into())
    }

    /// Returns the 32-byte digest.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Returns the digest as lowercase hexadecimal.
    pub fn to_hex(self) -> String {
        let mut encoded = String::with_capacity(64);
        for byte in self.0 {
            use fmt::Write as _;
            let _ = write!(encoded, "{byte:02x}");
        }
        encoded
    }
}

impl fmt::Display for SemanticId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

pub(crate) struct CanonicalHasher(Sha256);

impl CanonicalHasher {
    pub(crate) fn new(domain: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(domain);
        Self(hasher)
    }

    pub(crate) fn u8(&mut self, value: u8) {
        self.0.update([value]);
    }

    pub(crate) fn u16(&mut self, value: u16) {
        self.0.update(value.to_le_bytes());
    }

    pub(crate) fn u32(&mut self, value: u32) {
        self.0.update(value.to_le_bytes());
    }

    pub(crate) fn u64(&mut self, value: u64) {
        self.0.update(value.to_le_bytes());
    }

    pub(crate) fn i32(&mut self, value: i32) {
        self.0.update(value.to_le_bytes());
    }

    pub(crate) fn f64(&mut self, value: f64) {
        self.0.update(value.to_bits().to_le_bytes());
    }

    pub(crate) fn bytes(&mut self, value: &[u8]) {
        self.u64(value.len() as u64);
        self.0.update(value);
    }

    pub(crate) fn string(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }

    pub(crate) fn finish(self) -> SemanticId {
        SemanticId::from_hasher(self.0)
    }
}
