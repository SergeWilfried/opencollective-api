FROM node:20.11

WORKDIR /usr/

# Install dependencies first
COPY package*.json ./
RUN npm install --unsafe-perm --legacy-peer-deps
COPY . .

ARG PORT=3000
ENV PORT $PORT

ARG NODE_ENV=production
ENV NODE_ENV $NODE_ENV

ARG API_URL=https://api-staging.opencollective.com
ENV API_URL $API_URL

ARG INTERNAL_API_URL=https://api-staging-direct.doohi.org
ENV INTERNAL_API_URL $INTERNAL_API_URL

ARG API_KEY=09u624Pc9F47zoGLlkg1TBSbOl2ydSAq
ENV API_KEY $API_KEY

RUN npm run build

RUN npm prune --legacy-peer-dependencies

EXPOSE ${PORT}

CMD [ "npm", "run", "start" ]
