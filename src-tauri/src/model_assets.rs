//! Stage-3 model weights: download-on-first-run with SHA-256 integrity checks
//! (ADR 02's weight strategy). The four pix2tex ONNX/tokenizer files are too
//! large (~178 MB) to commit or bundle, so on first use we fetch them into the
//! OS app-data dir and verify each against a pinned hash before the ONNX
//! sessions ever open. Downloading weights is content-independent — no user
//! document data leaves the machine, so this preserves the privacy guarantee.

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;

/// Source for the validated weights. These are byte-identical to the files
/// `rapid_latex_ocr` ships (verified: matching SHA-256 / sizes). To host them
/// yourself, mirror the exact files and point this at your CDN.
const BASE_URL: &str = "https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0";

struct Asset {
    name: &'static str,
    sha256: &'static str,
}

/// The four files Pix2TexOnnx loads, pinned to the hashes we validated against
/// the Python reference (byte-for-byte golden parity).
const ASSETS: [Asset; 4] = [
    Asset {
        name: "image_resizer.onnx",
        sha256: "e0b075c39700f64d50400f39c8fc186bbb3b5d84d31864008313f376603aca9d",
    },
    Asset {
        name: "encoder.onnx",
        sha256: "01bf5dc25539ca0cd5b1bd29296ea495977a6ba5f629dc4178277809d26e5e7d",
    },
    Asset {
        name: "decoder.onnx",
        sha256: "bd695497bf1b22279b7626f5916c79226e1e244c84355f8da7edfd2d921d0072",
    },
    Asset {
        name: "tokenizer.json",
        sha256: "1dc27b18d6a518d0d5ff3f4bb7bd98521fe80ad39e5b2a246d4109f1bb9d5019",
    },
];

/// Ensure every weight file exists in `dir` and matches its pinned SHA-256,
/// downloading (and verifying) any that are missing or corrupt. Idempotent: a
/// fully-populated, valid dir is a no-op (only hashing, no network).
pub fn ensure_weights(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("create weights dir {}", dir.display()))?;
    for asset in &ASSETS {
        let path = dir.join(asset.name);
        if path.is_file() {
            match sha256_file(&path) {
                Ok(sum) if sum == asset.sha256 => continue, // present & valid
                Ok(_) => log::warn!("{} failed integrity check; re-downloading", asset.name),
                Err(e) => log::warn!("{} unreadable ({e}); re-downloading", asset.name),
            }
        }
        let url = format!("{BASE_URL}/{}", asset.name);
        log::info!("fetching weight {} -> {}", asset.name, path.display());
        download_verified(&url, &path, asset.sha256)
            .with_context(|| format!("download {}", asset.name))?;
    }
    Ok(())
}

/// Stream `url` to a temp file, hashing as we go, verify the SHA-256, then
/// atomically rename into place. A mismatch deletes the temp file and errors,
/// so a corrupt/MITM'd download can never reach the ONNX loader.
fn download_verified(url: &str, dest: &Path, expected_sha: &str) -> Result<()> {
    let resp = ureq::get(url)
        .call()
        .map_err(|e| anyhow!("GET {url}: {e}"))?;
    let mut reader = resp.into_reader();

    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp)
        .with_context(|| format!("create {}", tmp.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])?;
    }
    file.flush()?;
    drop(file);

    let got = to_hex(&hasher.finalize());
    if got != expected_sha {
        let _ = std::fs::remove_file(&tmp);
        bail!(
            "integrity check failed for {}: expected {expected_sha}, got {got}",
            dest.display()
        );
    }
    std::fs::rename(&tmp, dest).with_context(|| format!("finalize {}", dest.display()))?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encoding() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xff, 0xa9]), "000fffa9");
    }

    /// Live network test (ignored): downloads the small tokenizer.json and
    /// verifies it passes the pinned SHA-256, exercising the real fetch+verify
    /// path. Run with: cargo test --release -- --ignored downloads_and_verifies
    #[test]
    #[ignore]
    fn downloads_and_verifies() {
        let dir = std::env::temp_dir().join("mantis-weights-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tok = &ASSETS[3]; // tokenizer.json (24 KB)
        download_verified(&format!("{BASE_URL}/{}", tok.name), &dir.join(tok.name), tok.sha256)
            .expect("download + verify tokenizer.json");
        assert_eq!(sha256_file(&dir.join(tok.name)).unwrap(), tok.sha256);
    }
}
