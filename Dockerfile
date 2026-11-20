# Gateway de pagamentos — imagem de produção.
# O código roda direto em TypeScript (type stripping do Node), então não há
# etapa de build: só as dependências de produção e o src.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
ENV NODE_ENV=production \
    AMBIENTE=producao \
    PORTA=3011 \
    CONFIAR_NO_PROXY=true
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Nunca rodar como root.
USER node
EXPOSE 3011

# A plataforma também checa /saude; este é o fallback do próprio Docker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORTA||3011)+'/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migra (idempotente) e sobe. Se a migração falhar, o processo não sobe e o
# deploy anterior continua no ar. Sem npm no meio e com exec: o Node vira o
# processo principal e recebe o SIGTERM do deploy para encerrar limpo.
CMD ["sh", "-c", "node --experimental-strip-types --disable-warning=ExperimentalWarning src/db/migrar.ts && exec node --experimental-strip-types --disable-warning=ExperimentalWarning src/principal.ts"]
