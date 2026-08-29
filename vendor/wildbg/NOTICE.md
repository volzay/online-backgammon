# WildBG WebAssembly Runtime

This directory contains a reproducible WebAssembly build of WildBG for the
hard short-backgammon bot.

- Source: https://github.com/carsten-wenderdel/wildbg
- Engine commit: `dbc4b4e7614540beadf1a923809d3f31566bfbee`
- Strong neural-network commit: `8c42b06f2ff4868431fc0372b2787e612537317d`
- WildBG version: `0.3.1-pre`
- Build target: `wasm32-unknown-unknown`
- Build profile: release, WebAssembly SIMD enabled
- wasm-pack: `0.15.0`
- Rust: `1.98.0`
- WASM SHA-256: `0a120dd6657913e9eba41a821419be65e236055bbfa10d70e77d050d46b0bc53`

The WebAssembly binary embeds the `contact.onnx` and `race.onnx` files from
the pinned strong-network commit. The browser and Node.js JavaScript files are
the wasm-bindgen wrappers generated from the same binary. WildBG is available
under either the MIT or Apache-2.0 license; both license texts are included.

Rebuild command from the pinned engine checkout after replacing
`neural-nets/contact.onnx` and `neural-nets/race.onnx` with the files from the
pinned strong-network commit:

```sh
RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build crates/wildbg-wasm --target web --release --out-dir ../../pkg-web

RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build crates/wildbg-wasm --target nodejs --release --out-dir ../../pkg-node
```

The generated WASM files from both targets must be byte-identical. The Node.js
wrapper is stored as `wildbg_wasm.js`; the browser ESM wrapper is stored as
`wildbg_wasm_browser.js`.
