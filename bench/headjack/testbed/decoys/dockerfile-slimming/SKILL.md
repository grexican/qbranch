---
name: dockerfile-slimming
description: "Makes Docker images smaller and faster to build: multi-stage builds, layer order and base images. Use when a Dockerfile builds slowly or produces a large image."
---

# dockerfile-slimming

1. Use a multi-stage build; copy only the artifacts into the final stage.
2. Order layers from least to most frequently changing.
3. Pick a slim or distroless base image.
