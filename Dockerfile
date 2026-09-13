FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY .env.example ./

RUN mkdir -p /app/data/auth

ENV NODE_ENV=production
EXPOSE 3001

CMD ["npm", "start"]
