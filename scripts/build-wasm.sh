#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../crates/mantis-wasm"

wasm-pack build --target web --out-dir pkg
echo "WASM build complete: crates/mantis-wasm/pkg/"
