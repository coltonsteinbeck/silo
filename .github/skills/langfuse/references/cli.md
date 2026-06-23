# Langfuse CLI Reference

Docs: `https://langfuse.com/docs/api-and-data-platform/features/cli`

## Run Without Installing

```bash
npx langfuse-cli api <resource> <action>
bunx langfuse-cli api <resource> <action>
```

## Discovery

```bash
langfuse-cli api __schema
langfuse-cli api <resource> --help
langfuse-cli api <resource> <action> --help
langfuse-cli api <resource> <action> --curl
```

## Credentials

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_HOST=https://cloud.langfuse.com
```

If the workspace uses `LANGFUSE_BASE_URL`, normalize it to `LANGFUSE_HOST` before CLI usage when needed.

## Tips

- Use `--json` for machine-readable output.
- Use `--curl` to inspect the request shape safely.
- Paginate list calls with `--limit` and `--page`.
- Prefer richer v2-style endpoints when the CLI exposes both old and new variants.
