# Runtime stream checks

Reproducible stream boundary tests and bounded Node.js memory observations against a pinned open-source checkout. Run manually through the Checks workflow. All code, logs, and artifacts in this repository are public.

The workflow checks out `vercel/ai` at `a089a0a8c7a5803d0bb0895145f3ede569af9a6b`, installs its pinned dependencies, builds the relevant packages, and runs selected existing regression suites plus small additional boundary checks.

Runtime samples use one disposable Linux container at a time, with 192–512 MiB of memory, no swap, no external network, a 64 MiB V8 old-space setting, and a 30-second deadline. Payloads are deterministic and at most 160 MiB each. A loopback HTTP fixture is the only workload endpoint. The test build explicitly replaces the SDK URL transport with an origin-restricted fixture adapter because the normal transport rejects loopback addresses. Reading, buffering, error wrapping, and Blob conversion use the pinned source. These samples therefore do not exercise production URL validation.

The controller records Docker's verified memory configuration, exit state, `OOMKilled`, stdout/stderr, Node version, consumed response bytes, sampled process memory, and cgroup counters where available. Memory observations are environment-dependent, and an exit code alone is insufficient to attribute a failure to an out-of-memory kill. The native-fetch case is a runtime control. The optional API byte limit is distinct from the container's process memory budget.

Locally, after installing the source checkout dependencies and this directory's dependencies:

```sh
node ci/build.mjs /absolute/path/to/ai
node ci/run-cases.mjs
```

The second command requires an existing Docker engine. This project does not install Docker. Only the GitHub-hosted runner uses containers in the workflow.
