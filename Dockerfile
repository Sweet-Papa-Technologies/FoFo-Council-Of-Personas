# Council of Personas — MCP server (Streamable HTTP) for Cloud Run.
FROM node:22-slim

WORKDIR /app

# Install backend deps (root package.json holds the server + MCP deps).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App code the MCP server needs at runtime.
COPY server ./server
COPY council.yaml ./council.yaml
COPY tsconfig.json ./tsconfig.json

# Cloud Run provides PORT (defaults 8080); the server reads it.
ENV MCP_HTTP=1
EXPOSE 8080

# tsx is a runtime dep, so `npm run mcp:http` works without a build step.
CMD ["npm", "run", "--silent", "mcp:http"]
