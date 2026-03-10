FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

# Copy all files including public/ folder
COPY . .

RUN mkdir -p public

EXPOSE 4000

CMD ["node", "server.js"]
