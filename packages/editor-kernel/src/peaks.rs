//! Pure peak aggregation shared by native static checks and the Wasm binding.

const MAX_SAMPLES: usize = 16_777_216;
const MAX_CHANNELS: usize = 8;
const MAX_BUCKETS: usize = 4096;

/// Rejected kernel input; no partial result is returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeakError {
    /// Input dimensions exceed the bounded planar PCM contract.
    InputBounds,
    /// A sample is NaN or infinite.
    NonFinite,
}

impl PeakError {
    /// Stable code transported across the Worker boundary.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::InputBounds => "INPUT_BOUNDS",
            Self::NonFinite => "NON_FINITE",
        }
    }
}

/// Visit every sample exactly once, including each bucket's remainder and the tail.
///
/// Empty buckets contain zero when there are fewer frames than buckets. Non-empty
/// buckets partition [0, frames) at floor(bucket * frames / buckets). The expanded
/// quotient/remainder calculation stays below 2^25 on a 32-bit Wasm target.
///
/// # Errors
/// Returns [`PeakError::InputBounds`] for invalid dimensions and
/// [`PeakError::NonFinite`] for NaN or infinite PCM. No sample is silently skipped.
pub fn aggregate(samples: &[f32], channels: usize, buckets: usize) -> Result<Vec<f32>, PeakError> {
    if channels == 0
        || channels > MAX_CHANNELS
        || buckets == 0
        || buckets > MAX_BUCKETS
        || samples.is_empty()
        || samples.len() > MAX_SAMPLES
        || !samples.len().is_multiple_of(channels)
    {
        return Err(PeakError::InputBounds);
    }
    let frames = samples.len() / channels;
    let quotient = frames / buckets;
    let remainder = frames % buckets;
    let mut peaks = vec![0.0_f32; buckets];
    for channel in samples.chunks_exact(frames) {
        for (bucket, peak) in peaks.iter_mut().enumerate() {
            let start = bucket * quotient + bucket * remainder / buckets;
            let next = bucket + 1;
            let end = next * quotient + next * remainder / buckets;
            let values = channel.get(start..end).ok_or(PeakError::InputBounds)?;
            for &sample in values {
                if !sample.is_finite() {
                    return Err(PeakError::NonFinite);
                }
                *peak = peak.max(sample.abs());
            }
        }
    }
    Ok(peaks)
}
