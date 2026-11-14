# Free Model Aggregator — v1

One server, two client APIs, ten simulated free-tier providers. It reads the
brief, probes each provider's catalog route, builds one catalog, registers
it, and then serves the client's 20 requests: every request goes to the best
free model that can actually serve it, and when that provider is out of
budget or failing, the next best free model answers instead.

## How it works

**Catalog.** The brief's provider directory and quality table are read from
`MAKEFUN_PROMPT_FILE`. Each provider's catalog route is probed in its own
wire (`GET <base>/v1/models`, or `/v1beta/models` for Gemini), and the
catalog is built from the listings plus the quality table's `free` flag.
The catalog's `base_url` is the directory's own path (`/p/<id>`), never
joined to the env URL, so the registered document is identical in a live
pass and in its replay.

**Routing.** Candidates are every free model that meets the request's
requirements (tools, vision, JSON mode, minimum context), ranked by the
quality table's `rating_milli` — highest first — then by the provider with
the fewest calls so far, so a tie spreads the load. A JSON-mode request
never goes to an anthropic-wire provider, whose wire cannot carry
`response_format`. A provider that fails twice in a row is left alone for
the rest of the trial (an outage never recovers). Exactly one successful
provider call is ever made per request.

**Wires.** All three upstream wires are implemented in both directions,
JSON and streaming: OpenAI, Anthropic and Gemini. Every provider answer is
read whole, parsed into one canonical answer (text + input/output tokens),
then rendered in the client's wire with the provider's stop reason
(family 0: `stop` / `end_turn` / `STOP`) and the provider's exact usage.
The client never sets `stream_options`, so an upstream OpenAI stream is
always given `stream_options: { include_usage: true }` — otherwise the
provider sends no usage chunk and the client's usage check fails.

**Determinism.** Every choice is a function of the brief, the requests and
the providers' answers. No wall clock, no unseeded randomness, fixed
timestamps in model lists. Two runs of the same trial produce the same
answers.

## Run

```sh
node main.ts --list        # prints the catalog document, exits 0
```

In a trial the env sets `MAKEFUN_ENV_URL`, `MAKEFUN_PROMPT_FILE` and
`MAKEFUN_TRIAL_SEED`; the server registers, serves, polls `GET /work`
every 100 ms and exits 0 when the env says done.

## Files

- `main.ts` — the whole server (Node 22, stdlib only)
- `LICENSE` — MIT
