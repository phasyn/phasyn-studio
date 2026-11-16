//! Bounded waveform aggregation. The numerical kernel has no browser imports.
//!
//! Input is planar IEEE-754 binary32 PCM: every channel has the same frame count.
//! Output is the maximum absolute sample across all channels in each time bucket.
//! Finite values are preserved, including floating-point PCM peaks above one.

mod peaks;
pub use peaks::{PeakError, aggregate};

#[cfg(target_arch = "wasm32")]
mod bindings {
    use wasm_bindgen::prelude::*;

    /// Aggregate planar PCM into time-ordered peak buckets.
    ///
    /// # Errors
    /// Returns a stable error code for invalid bounds or non-finite samples.
    #[wasm_bindgen]
    pub fn aggregate_peaks(
        samples: &[f32],
        channels: u32,
        buckets: u32,
    ) -> Result<Vec<f32>, JsValue> {
        super::aggregate(samples, channels as usize, buckets as usize)
            .map_err(|error| JsValue::from_str(error.code()))
    }
}
