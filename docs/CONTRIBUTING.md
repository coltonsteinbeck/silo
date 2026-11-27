# Contributing to Silo

See the [contributor guide](../CONTRIBUTING.md) for setup, testing,
and pull requests. Use the [security policy](../SECURITY.md) to report
a vulnerability privately.

## Headless regression

Run `bun run test:regression` with the release-pinned Bun version. The suite
checks the application's real handlers with in-process Discord fixtures.
Startup checks the guild command payload in both search configurations, and
behavior tests cover permissions, replay, delivery, and provider failures.
Use `bun run test:discord-regression` for a focused rerun while editing.

Run `bun run test:regression:database` against a fresh, migrated PostgreSQL
loopback database with an explicit port. Pass its connection string in
`SILO_REGRESSION_DATABASE_URL`. Use a unique database named
`silo_regression_<32 lowercase hexadecimal digits>` and remove it after
the run. This command requires the database instead of skipping the quota,
ingress, and pool suites. Run `bun run radio:validate --offline` for the
local audio encoder. CI runs the quota, ingress and real-SDK image scenarios
against fresh PostgreSQL on every PR. Release changes also run the longer
pool recovery scenario. To run that same check locally, use
`bash scripts/run-regression-postgres.sh` with Docker and the PostgreSQL client
installed.

Add a named behavioral suite to the command inventory check for every new
command. Add a fixture at the shared application entry point for new
message, interaction, scheduled, or voice behavior. Check the intended
effect and the relevant denial, replay, or failure. Capture external
provider checks separately from simulated replies.

For provider-backed changes, retain the real SDK and intercept its transport
with versioned synthetic responses. Review the serialized request and the
resulting user-visible and persisted behavior. Include the new scenario or
the reason existing coverage applies in the PR's validation section.
