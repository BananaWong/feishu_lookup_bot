FROM node:20-slim
WORKDIR /app
COPY package.json .
COPY src/ ./src/
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/index.js"]
