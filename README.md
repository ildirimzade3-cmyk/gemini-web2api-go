# Gemini Hub

This branch (`hub`) turns the fork into a private AI hub: every Gemini account of the
operator runs in its own persistent Chrome profile on one server, and every app uses
the hub like the official OpenAI or Gemini API through one address.

Everything lives in [`hub/`](hub/README.md) (code, tests, deployment, client examples).

The previous cookie-replay bridge (Go, upstream `gemini-web2api-go`) is retired; its
history stays on the `miraz` and `main` branches.
