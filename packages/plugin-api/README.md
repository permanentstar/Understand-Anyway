# @understand-anyway/plugin-api

Service-provider interfaces (SPI) for the
[Understand-Anyway](https://github.com/permanentstar/Understand-Anyway)
monorepo. This package defines six small provider contracts and the dynamic
loading convention that lets the CLI/gateway swap any one of them at runtime
without recompiling.

## Why this package exists

The OSS core ships defaults that are intentionally minimal:

- `NoAuthProvider` (allow-all),
- `AllowAllOrgPolicyProvider`,
- `NoopRecordProvider`,
- `UnconfiguredLlmProvider` (errors when used),
- `NoopEmbeddingProvider`,
- `NoopNotifyProvider`.

Real deployments (and external contributors) plug in their own implementation
by writing a tiny package that exports a well-known factory and pointing the
CLI/gateway at it with a `--*-provider <pkg>` flag. The core never statically
imports your package — it `import()`s it by name at runtime.

`@understand-anyway/plugin-api` has **zero `node:*` imports** and zero
non-stdlib dependencies, so a provider package can target any JavaScript
runtime that can run the CLI.

## Install

```bash
pnpm add -D @understand-anyway/plugin-api
```

Almost always a `devDependency` for the provider package — at runtime the host
process already has plugin-api loaded; bundling it again would duplicate the
type identity.

## The six provider interfaces

| Provider | Purpose | Default impl | Factory export |
|---|---|---|---|
| `AuthProvider` | Decide whether an incoming request is authenticated; optionally drive an OAuth/OIDC redirect flow. | `NoAuthProvider` | `createAuthProvider` |
| `OrgPolicyProvider` | Post-auth authorization (e.g. department / role check). | `AllowAllOrgPolicyProvider` | `createOrgPolicyProvider` |
| `RecordProvider` | Side-record build/refresh outcomes (sheets, ticketing, DB…). | `NoopRecordProvider` | — (composed at CLI level) |
| `LlmProvider` | The LLM the build pipeline calls for enrichment / Q&A. | `UnconfiguredLlmProvider` | `createLlmProvider` |
| `EmbeddingProvider` | Vector embeddings for semantic search. | `NoopEmbeddingProvider` | `createEmbeddingProvider` |
| `NotifyProvider` | Sink for nightly aggregate summaries (chat / IM / email / file). | `NoopNotifyProvider` | `createNotifyProvider` |

Read the full TypeScript surface in
[`src/`](https://github.com/permanentstar/Understand-Anyway/tree/main/packages/plugin-api/src) —
each interface file is short and documented inline.

## Writing a provider package

A minimal example for a `NotifyProvider` that posts to your own webhook:

```ts
// my-notify/src/index.ts
import type {
  NightlyReport,
  NotifyOptions,
  NotifyProvider,
  NotifyResult,
  NotifyProviderFactory,
} from "@understand-anyway/plugin-api";

class WebhookNotifyProvider implements NotifyProvider {
  readonly name = "webhook";
  constructor(private readonly url: string) {}

  async sendNightlySummary(
    report: NightlyReport,
    opts: NotifyOptions = {},
  ): Promise<NotifyResult> {
    if (opts.dryRun) return { delivered: false, skipped: true, target: this.url };
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    return res.ok
      ? { delivered: true, target: this.url }
      : { delivered: false, target: this.url, error: `HTTP ${res.status}` };
  }
}

export const createNotifyProvider: NotifyProviderFactory = (config) => {
  const { url } = config as { url: string };
  if (!url) throw new Error("webhook notify provider: 'url' is required");
  return new WebhookNotifyProvider(url);
};
```

Key points:

- **Export the right name.** The CLI looks for the well-known export listed in
  the table above — see
  [`PROVIDER_FACTORY_EXPORTS`](https://github.com/permanentstar/Understand-Anyway/blob/main/packages/plugin-api/src/provider-factory.ts).
- **The factory receives `unknown`.** Validate the config shape yourself
  (Zod / hand-rolled) and throw a clear error on missing fields. The CLI
  surfaces the error verbatim.
- **No `node:*` in plugin-api.** Your provider can use `node:fs` etc., but
  don't expect plugin-api to expose Node-specific helpers.
- **`name` is the routing key.** Logs and audit lines key off `provider.name`,
  so pick something stable and human-readable.

## Wiring a provider at runtime

Configure providers via the unified deploy YAML (the example lives in
[`packages/cli/deploy.example.yaml`](https://github.com/permanentstar/Understand-Anyway/blob/main/packages/cli/deploy.example.yaml)):

```yaml
version: 1

providers:
  notify:
    package: "my-notify"      # any importable package name
    config:                   # passed verbatim to createNotifyProvider()
      url: "https://example.invalid/webhook/nightly"
```

Then hand the CLI either the config file or a directory containing one:

```bash
understand-anyway notify nightly \
  --report "$UA_PROJECTS_ROOT/gateway/operations/nightly-latest.json" \
  --config ./deploy.yaml
```

If you prefer a flag-only one-off (no YAML), `notify nightly` also accepts
`--notify-provider <pkg>`; the factory then receives `{}` for its config.

For the other provider kinds the wiring is the same — populate the matching
`providers.<kind>` block in the YAML. `serve` / `dashboard start` /
`build` pick up their respective providers from that same config.

The CLI's loading sequence in every case is:

1. dynamic-`import(packageName)`,
2. look up the well-known export from `PROVIDER_FACTORY_EXPORTS`,
3. call it with `providers.<kind>.config`,
4. install the returned provider on the registry.

## Stability

This package is at `0.0.x` along with the rest of the monorepo. While we're
pre-1.0:

- Additive changes (new optional methods, new interface fields) ship as
  `minor`. Existing implementations keep compiling.
- Breaking changes (renamed methods, required new fields, removed exports)
  ship as `major` and are called out in the GitHub Release notes.

All ten packages in this monorepo are versioned together (manual lockstep via
`scripts/release.mjs`), so any bump moves every package — including this one.

## License

MIT. See [LICENSE](https://github.com/permanentstar/Understand-Anyway/blob/main/LICENSE).
