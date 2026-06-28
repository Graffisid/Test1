# Test1

## Headroom proxy

[Headroom](https://github.com/headroomlabs-ai/headroom) is a local proxy that
compresses LLM request/response traffic (tool outputs, logs, RAG chunks,
conversation history) to cut token usage, with no code changes required on
the client side.

### Install

```bash
pip install "headroom-ai[all]"
```

### Run

```bash
headroom proxy
```

This starts the proxy on `http://127.0.0.1:8787` and prints the routing
table, health endpoints, and usage instructions for pointing Anthropic- or
OpenAI-compatible clients at it, e.g.:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 your-app
```

Use `headroom proxy --port <port>` to bind to a different port, and
`headroom proxy --help` for the full list of options (backend selection,
caching, memory, budgets, etc.).

A convenience script that installs the dependency and starts the proxy in
one step is available at `scripts/start-proxy.sh`.
