FROM oven/bun:1

WORKDIR /app

# Install server dependencies
COPY package.json bun.lock* ./
RUN bun install --production

# Build admin UI
COPY admin-ui/package.json admin-ui/bun.lock* admin-ui/
RUN cd admin-ui && bun install
COPY admin-ui/ admin-ui/
RUN cd admin-ui && bun run build

# Copy server source
COPY src/ src/
COPY drizzle/ drizzle/
COPY tsconfig.json ./

EXPOSE 3000
CMD ["bun", "run", "src/index.tsx"]
