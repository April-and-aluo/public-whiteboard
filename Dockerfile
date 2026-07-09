FROM node:20-slim

WORKDIR /app

# 复制服务器文件
COPY server/package.json ./
RUN npm install --production

COPY server/server.js ./

EXPOSE 8080

CMD ["node", "server.js"]
