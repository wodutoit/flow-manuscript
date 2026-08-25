# Local AI Model for Custom WYSIWYG MD Editor Extension

Context notes from an exploratory conversation, to bring into the existing extension project.

## Goal

Add a small AI model to a VS Code extension that provides a custom WYSIWYG markdown editor. The model should assist with:
- Spelling and grammar checking
- Simple editing suggestions (clarity, tone, wordiness)

## Where the model runs: Node.js extension host (decided)

The extension host runs in Node.js, not a browser sandbox, so this is not the same problem as running a small model on a web page. Running in-process in the extension host was chosen over a Webview + WebGPU approach because it avoids:
- The webview sandbox (no direct filesystem/workspace access, requires `postMessage` relaying)
- The overhead of message-passing between webview and extension host

## Runtime options considered

| Option | Notes |
|---|---|
| **`node-llama-cpp`** (recommended) | Node bindings for llama.cpp, loads quantized GGUF models. Supports **GBNF grammar-constrained decoding** — can force output into a strict schema instead of freeform prose. This is the key advantage for editor integration. |
| `onnxruntime-node` | Lower-level; better fit if landing on a dedicated ONNX-exported grammar-correction model (many T5-based grammar models are distributed this way). |
| transformers.js (Node) | Same API as browser usage, runs on onnxruntime-node under the hood in Node. Reuses browser-side knowledge, but loses the grammar-constrained decoding trick available in node-llama-cpp. |

**Recommendation: `node-llama-cpp`**, primarily for the constrained-output/grammar feature.

## Model options considered

- **Small general instruct model** (e.g. Qwen2.5-1.5B-Instruct or Llama-3.2-1B-Instruct, Q4 GGUF quantization) — flexible enough to cover both grammar/spelling and lightweight rewrite/editing suggestions. A few hundred MB, runs fine on CPU for short passages.
- **Dedicated grammar-correction seq2seq model** (T5-small-based, "grammar-synthesis" style) — faster and smaller, but narrower: strong at grammar/spelling, weak at rewrite-style editing.

**Recommendation:** use the general instruct model for grammar + rewrite suggestions, paired with a plain dictionary-based spellchecker (`nspell` or `typo-js`) for instant squiggly-underline spelling — reserve the model for grammar/rewrite rather than pure spelling, since a dictionary is faster and more reliable for that layer.

## Distribution considerations

- Do **not** bundle the model weights or native binaries inside the `.vsix`.
- `node-llama-cpp` ships platform-specific prebuilt binaries (win/mac/linux × x64/arm64).
- Download/cache model weights to `context.globalStorageUri` on first activation, with a progress notification.
- This download-on-first-use cost is the main tradeoff of the Node-native path vs. a webview+WASM approach (which is more portable but loses constrained decoding).

## Output shape recommendation

- Prefer **structured suggestions** — spans + replacement + reason (e.g. `{start, end, original, suggestion, reason}`) — over having the model rewrite whole paragraphs.
- Render as inline decorations / lightbulbs in the custom WYSIWYG editor.
- Much easier to accept/reject individually, and far less likely to silently mangle formatting than whole-paragraph rewrites.
- A sample GBNF grammar can be built to constrain `node-llama-cpp` output to this schema.

## Other VS Code AI integration options surfaced (not chosen, but worth knowing)

- **VS Code Language Model Provider API** (added ~June 2026): lets a local model register directly into Copilot Chat's model picker (BYOK/Ollama/LM Studio support), without a third-party extension or GitHub sign-in. Relevant if the goal were to appear inside VS Code's own chat UI rather than power a custom editor feature.
- **Chat Participant API** (`@yourmodel` in native chat panel): gives free rendering, code-block actions, and `#file`/`#selection` context resolution from VS Code's chrome. Not directly applicable to inline editor suggestions, but a good pattern if a chat-style interface is added later.

## Open items / next steps (not yet covered)

- Concrete extension architecture: activation flow, model load/download lifecycle
- Message contract between the custom WYSIWYG webview and the extension host for suggestion data
- Sample GBNF grammar for the suggestion schema
- Debouncing/scoping strategy (per-paragraph vs. whole-document analysis) for performance
