//! Stand-in for the `vswhom` crate, swapped in through `[patch.crates-io]`.
//!
//! Tauri's resource step (tauri-winres -> embed-resource) depends on vswhom, whose
//! -sys crate compiles C++ and so needs Visual Studio's cl.exe even though
//! embed-resource only asks it as a last resort: it finds rc.exe through the
//! Windows Kits registry keys first. Reporting "not found" here keeps the build
//! free of a C++ compiler; linking can then use rust-lld (tools/tauri.mjs).

use std::ffi::OsString;
use std::num::NonZeroU8;

#[derive(Debug, Clone, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub struct VsFindResult {
    pub windows_sdk_version: NonZeroU8,

    pub windows_sdk_root: Option<OsString>,
    pub windows_sdk_um_library_path: Option<OsString>,
    pub windows_sdk_ucrt_library_path: Option<OsString>,

    pub vs_exe_path: Option<OsString>,
    pub vs_library_path: Option<OsString>,
}

impl VsFindResult {
    /// Always `None`: callers fall back to their other lookups.
    pub fn search() -> Option<VsFindResult> {
        None
    }
}
