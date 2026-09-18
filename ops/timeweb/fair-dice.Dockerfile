# Supply a verified official Node.js 24 image with an immutable @sha256 digest.
# No floating default image is selected implicitly during production deployment.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY fair-dice.js game.js ./
COPY lib/ ./lib/
COPY scripts/fair-dice-service.js ./scripts/fair-dice-service.js
USER 10001:10001
ENV NODE_ENV=production
EXPOSE 3895
CMD ["node", "scripts/fair-dice-service.js"]
