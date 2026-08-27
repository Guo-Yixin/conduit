# Local OpenAI-Compatible VLMs

Conduit can run multimodal transformation stations against local vision-language
models served behind an OpenAI-compatible endpoint, such as Ollama, vLLM, or a
LiteLLM proxy in front of either one.

The adapter sends standard OpenAI chat content parts:

```json
[
  { "type": "text", "text": "..." },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
]
```

Point Conduit at the local gateway with the normal model env vars:

```bash
export CONDUIT_BASE_URL="http://localhost:11434/v1"
export CONDUIT_API_KEY="local-dev-key"
```

The gateway must expose `/chat/completions` and accept OpenAI-compatible image
content parts for the models used by image stations.

## Image Limits

Conduit base64-encodes each image into the JSON request body. The per-image
limit is `MAX_IMAGE_BYTES` in `src/worker/image-input.ts`, currently
`20_971_520` bytes, or about 20 MB.

That limit is checked before the gateway call. Oversized images fail in Conduit
instead of being sent to the model server.

Keep local models conservative:

- resize images before the station when full resolution is not required
- keep the number of images per call small
- prefer one clear image per quality-critical check
- use station `timeout_seconds` for local servers that can hang under load

## Timeouts

Set `timeout_seconds` on image-heavy transform stations:

```yaml
stations:
  - id: color_match
    worker:
      kind: transform
      model: local-gemma-vlm
      prompt_file: prompts/color-match.md
      timeout_seconds: 120
      output_schema:
        fields:
          - { name: match, type: boolean, required: true }
          - { name: confidence, type: number, required: true }
          - { name: reason, type: string, required: true }
```

The timeout bounds each gateway attempt. A hung local server fails closed; it
does not create a successful output or checkpoint.

## Vision-Capability Errors

Local OpenAI-compatible servers do not all phrase errors like frontier
providers. Conduit classifies unsupported-vision failures from structured error
fields first, then falls back to narrow known message patterns.

Built-in structured codes include values such as:

- `unsupported_content`
- `unsupported_image_input`
- `image_input_unsupported`
- `vision_unsupported`
- `vision_not_supported`
- `multimodal_input_unsupported`

If a local server uses its own structured code or type, add it with:

```bash
export CONDUIT_VISION_UNSUPPORTED_ERROR_CODES="ollama_image_disabled,my_provider_no_vision"
```

This should be used only for errors that mean "this model/server cannot accept
image input." Do not add codes for image size, image format, hardware capacity,
or transient processing errors.

When Conduit can classify a true image-capability mismatch, the station scraps
with terminal reason `vision-unsupported`. It does not retry the same
incompatible model to the execution-attempt cap.

Ambiguous local server failures remain generic gateway failures. They do not
produce output, do not write checkpoints, and do not silently pass.

## Recommended Safety Pattern

For quality-critical local VLM work, use a maker/checker pair rather than
trusting one model call:

1. A maker model produces a small typed result.
2. The output schema forces required fields and simple types.
3. A checker model verifies the result against the same image or a derived
   artifact.
4. A gate routes to bounded rework, `scrap`, or `hold`.

Example shape:

```text
color_match_maker -> color_match_check -> pass | rework | hold | scrap
```

For high-cost downstream actions, such as a wrong mapping triggering a long
print job, prefer:

- separate maker and checker models when practical
- strict output schemas
- low confidence or ambiguous checker verdicts routed to `hold`
- human review before the effectful station
- idempotent delivery/publish stations

Local models are useful, but the safety boundary is the Conduit quality loop:
typed output, gate checks, bounded rework, and explicit terminal outcomes.
