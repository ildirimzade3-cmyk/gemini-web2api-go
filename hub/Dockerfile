# Gemini hub: Node + real Google Chrome (headful on Xvfb, one display per account)
# + x11vnc for the one-time sign-in view. Runs as an unprivileged user; Chrome keeps
# its own sandbox (user namespaces), so no --no-sandbox.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg xvfb x11vnc xauth \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core tini \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10101 hub && useradd -u 10101 -g hub -m -d /home/hub -s /usr/sbin/nologin hub \
 && install -d -o hub -g hub -m 0700 /data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

USER hub
ENV NODE_ENV=production HUB_DATA=/data CHROME_PATH=/usr/bin/google-chrome-stable
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/main.mjs"]
