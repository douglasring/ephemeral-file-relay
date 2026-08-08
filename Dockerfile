FROM node:20-alpine
WORKDIR /app
COPY server.js ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# Runs as root by default in alpine; drop to the built-in 'node' user.
USER node
CMD ["node", "server.js"]
