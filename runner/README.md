# Flutter Build Runner

This service compiles untrusted generated Flutter projects inside its own container.

Set BUILD_RUNNER_SECRET and expose the service privately where possible. The API accepts a project file list at POST /builds and returns a job id. Poll GET /builds/:id.

For production, place this runner in an isolated environment with resource limits, restricted network access, ephemeral storage, and no host filesystem mounts.