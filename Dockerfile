FROM oven/bun:1
WORKDIR /app
COPY index.ts .
CMD ["bun", "run", "index.ts"]
