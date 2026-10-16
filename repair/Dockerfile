# Self-repair job and browser transport: the container command is the mode
# (`learn` exits after one run; `serve` answers prompts on :9000 until idle).
# The base image tag must match the playwright-core version in package.json
# (it ships the Chromium build that playwright-core 1.64.1 expects).
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY *.mjs ./

# The image already contains the browsers (PLAYWRIGHT_BROWSERS_PATH=/ms-playwright).
# Chromium's own sandbox needs user namespaces that Docker's default seccomp profile
# blocks, so the container is the sandbox: non-root, no capabilities (see README run command).
ENV CHROMIUM_NO_SANDBOX=1 \
    NODE_ENV=production
EXPOSE 9000
USER pwuser

ENTRYPOINT ["node", "run.mjs"]
