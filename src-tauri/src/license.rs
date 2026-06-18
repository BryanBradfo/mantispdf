//! Stage-3 licensing (ADR 03): Lemon Squeezy License API, validated and
//! enforced in the backend. Only the license key is sent to Lemon Squeezy
//! (never document content). The License API needs no secret key — we embed
//! only public product identifiers to scope licenses to this product.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const ACTIVATE_URL: &str = "https://api.lemonsqueezy.com/v1/licenses/activate";
const VALIDATE_URL: &str = "https://api.lemonsqueezy.com/v1/licenses/validate";
const DEACTIVATE_URL: &str = "https://api.lemonsqueezy.com/v1/licenses/deactivate";

/// Human-readable label sent as the activation `instance_name`.
const INSTANCE_NAME: &str = "MantisPDF Desktop";

// Product scope. Set at build time (`LS_VARIANT_ID` / `LS_STORE_ID`) so a
// license from another Lemon Squeezy store/product can't unlock this app. Empty
// placeholder → the meta check is skipped (DEV ONLY; ship with these set).
const EXPECTED_VARIANT_ID: &str = match option_env!("LS_VARIANT_ID") {
    Some(v) => v,
    None => "",
};
const EXPECTED_STORE_ID: &str = match option_env!("LS_STORE_ID") {
    Some(v) => v,
    None => "",
};

const RECHECK_AFTER_SECS: u64 = 3 * 24 * 60 * 60; // re-validate online every 3 days
const OFFLINE_GRACE_SECS: u64 = 14 * 24 * 60 * 60; // allow offline up to 14 days

/// Persisted license state (`app_config_dir()/license.json`).
#[derive(Serialize, Deserialize, Clone, Default)]
struct LicenseState {
    key: String,
    instance_id: String,
    status: String, // Lemon Squeezy license_key.status (active/expired/disabled/…)
    variant_id: String,
    last_checked: u64, // unix seconds of the last successful online check
}

/// Status surfaced to the frontend (and used by the backend gate).
#[derive(Serialize, Clone)]
pub struct LicenseStatus {
    /// "pro" or "free" — the single bit the gate depends on.
    pub tier: String,
    /// Detail for the UI: active / expired / disabled / unlicensed / grace / invalid.
    pub status: String,
    /// Masked key for display when licensed (e.g. "····-····-AB12").
    pub key_masked: Option<String>,
}

impl LicenseStatus {
    pub fn is_pro(&self) -> bool {
        self.tier == "pro"
    }
    fn free(status: &str) -> Self {
        Self {
            tier: "free".into(),
            status: status.into(),
            key_masked: None,
        }
    }
    fn pro(status: &str, key: &str) -> Self {
        Self {
            tier: "pro".into(),
            status: status.into(),
            key_masked: Some(mask_key(key)),
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mask_key(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("····-····-{tail}")
}

fn state_path(config_dir: &Path) -> PathBuf {
    config_dir.join("license.json")
}

fn load_state(config_dir: &Path) -> Option<LicenseState> {
    let raw = std::fs::read_to_string(state_path(config_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_state(config_dir: &Path, state: &LicenseState) -> Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(state)?;
    std::fs::write(state_path(config_dir), json).context("write license.json")?;
    Ok(())
}

/// POST a form to the License API. Lemon Squeezy returns a JSON body on both
/// success and 4xx (e.g. invalid key → 400 with `{ "valid": false, "error": … }`),
/// so we parse the body for Status errors and only fail on transport errors.
fn post_form(url: &str, params: &[(&str, &str)]) -> Result<serde_json::Value> {
    let body = match ureq::post(url).set("Accept", "application/json").send_form(params) {
        Ok(resp) => resp.into_string()?,
        Err(ureq::Error::Status(_code, resp)) => resp.into_string()?,
        Err(e) => return Err(anyhow!("network error contacting license server: {e}")),
    };
    serde_json::from_str(&body).context("parse license API response")
}

fn str_field(v: &serde_json::Value, path: &[&str]) -> String {
    let mut cur = v;
    for p in path {
        cur = &cur[p];
    }
    // Accept string or number (Lemon Squeezy ids can be numbers).
    if let Some(s) = cur.as_str() {
        s.to_string()
    } else if cur.is_number() {
        cur.to_string()
    } else {
        String::new()
    }
}

/// Verify the license belongs to THIS product. Skipped (with a warning) when the
/// expected ids are unset — dev only.
fn product_matches(meta: &serde_json::Value) -> bool {
    if EXPECTED_VARIANT_ID.is_empty() {
        log::warn!("LS_VARIANT_ID unset — skipping product-scope check (dev build)");
        return true;
    }
    let variant = str_field(meta, &["variant_id"]);
    if variant != EXPECTED_VARIANT_ID {
        return false;
    }
    if !EXPECTED_STORE_ID.is_empty() && str_field(meta, &["store_id"]) != EXPECTED_STORE_ID {
        return false;
    }
    true
}

/// Activate a key on this machine: POST activate, verify it succeeded and is for
/// our product, persist the instance, and return the resulting status.
pub fn activate(key: &str, config_dir: &Path) -> Result<LicenseStatus> {
    let key = key.trim();
    if key.is_empty() {
        bail_invalid()?;
    }
    let v = post_form(ACTIVATE_URL, &[("license_key", key), ("instance_name", INSTANCE_NAME)])?;

    if !v["activated"].as_bool().unwrap_or(false) {
        let err = v["error"].as_str().unwrap_or("license key could not be activated");
        return Err(anyhow!("{err}"));
    }
    if !product_matches(&v["meta"]) {
        return Err(anyhow!("this license key is not valid for MantisPDF Pro"));
    }

    let status = str_field(&v, &["license_key", "status"]);
    let state = LicenseState {
        key: key.to_string(),
        instance_id: str_field(&v, &["instance", "id"]),
        status: status.clone(),
        variant_id: str_field(&v["meta"], &["variant_id"]),
        last_checked: now_secs(),
    };
    save_state(config_dir, &state)?;
    Ok(if status == "active" {
        LicenseStatus::pro(&status, key)
    } else {
        LicenseStatus::free(&status)
    })
}

fn bail_invalid() -> Result<()> {
    Err(anyhow!("please enter a license key"))
}

/// Current entitlement: trust a recently-validated cache, else re-validate
/// online, else fall back to the offline grace window.
pub fn current_status(config_dir: &Path) -> LicenseStatus {
    let Some(mut state) = load_state(config_dir) else {
        return LicenseStatus::free("unlicensed");
    };
    let age = now_secs().saturating_sub(state.last_checked);

    // Fresh and active → trust the cache, no network.
    if state.status == "active" && age < RECHECK_AFTER_SECS {
        return LicenseStatus::pro("active", &state.key);
    }

    // Re-validate online.
    match post_form(
        VALIDATE_URL,
        &[("license_key", &state.key), ("instance_id", &state.instance_id)],
    ) {
        Ok(v) => {
            let valid = v["valid"].as_bool().unwrap_or(false);
            let status = str_field(&v, &["license_key", "status"]);
            state.status = status.clone();
            state.last_checked = now_secs();
            let _ = save_state(config_dir, &state);
            if valid && status == "active" {
                LicenseStatus::pro("active", &state.key)
            } else {
                LicenseStatus::free(if status.is_empty() { "invalid" } else { &status })
            }
        }
        // Offline: keep working within the grace window if it was active before.
        Err(_) => {
            if state.status == "active" && age < OFFLINE_GRACE_SECS {
                LicenseStatus::pro("grace", &state.key)
            } else {
                LicenseStatus::free("grace-expired")
            }
        }
    }
}

/// Deactivate this instance with Lemon Squeezy (best-effort) and clear local state.
pub fn deactivate(config_dir: &Path) -> Result<()> {
    if let Some(state) = load_state(config_dir) {
        let _ = post_form(
            DEACTIVATE_URL,
            &[("license_key", &state.key), ("instance_id", &state.instance_id)],
        );
    }
    let _ = std::fs::remove_file(state_path(config_dir));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_key_tail() {
        assert_eq!(mask_key("ABCD-EFGH-IJKL-MN12"), "····-····-MN12");
    }

    #[test]
    fn unlicensed_when_no_state() {
        let dir = std::env::temp_dir().join("mantis-license-test-empty");
        let _ = std::fs::remove_dir_all(&dir);
        let s = current_status(&dir);
        assert_eq!(s.tier, "free");
        assert_eq!(s.status, "unlicensed");
        assert!(!s.is_pro());
    }

    #[test]
    fn fresh_active_cache_is_pro_without_network() {
        let dir = std::env::temp_dir().join("mantis-license-test-fresh");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let state = LicenseState {
            key: "TEST-KEY-0000-ABCD".into(),
            instance_id: "inst-1".into(),
            status: "active".into(),
            variant_id: "v1".into(),
            last_checked: now_secs(), // just checked → within recheck cadence
        };
        save_state(&dir, &state).unwrap();
        let s = current_status(&dir); // must NOT hit the network
        assert!(s.is_pro());
        assert_eq!(s.key_masked.as_deref(), Some("····-····-ABCD"));
    }
}
