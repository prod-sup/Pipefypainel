# Painel Pipefy (Kanban) — Firebase

Painel de criação de torneios que fala com o Pipefy. Foi portado do app Flask
original para **Firebase Hosting + Cloud Functions**, para caber no mesmo
ecossistema Firebase que o resto da operação já usa (projeto `design-1-53c00`).

## Como funciona

```
Navegador (público)
   │  GET /            → Firebase Hosting  → public/index.html (estático)
   │  /api/**          → rewrite           → Cloud Function "pipefyApi"
   ▼
Cloud Function pipefyApi  (guarda o PIPEFY_TOKEN — nunca vai ao navegador)
   ▼
Pipefy GraphQL / REST
```

- **`public/index.html`** — o frontend. Antes o Flask renderizava as 5 colunas
  via Jinja; agora a página é estática e busca os cards em `GET /api/colunas`
  (montados no cliente por `renderCard`). Todo o resto do JS ficou igual.
- **`functions/index.js`** — porte 1:1 de `api/pipefy_client.py` + `app.py`.
  Os templates, que ficavam em `templates.json` (disco), agora vivem no
  Realtime Database em `/pipefyTemplates`.

## Deploy (uma vez)

Pré-requisitos: Node 20, `npm i -g firebase-tools`, e `firebase login`.
O projeto precisa estar no **plano Blaze** (Functions exige; tem tier grátis).

```bash
cd Pipefypainel
npm --prefix functions install

# 1) Token secreto (guardado no Secret Manager, não no código):
firebase functions:secrets:set PIPEFY_TOKEN
#   cole o token quando pedir

# 2) Pipe id (não é segredo — vai no .env das functions):
cp functions/.env.example functions/.env
#   confira o PIPEFY_PIPE_ID (padrão: 304354423)

# 3) Publicar hosting + function:
firebase deploy --only hosting,functions
```

Depois do deploy o painel fica em **https://design-1-53c00.web.app/**
(é essa a URL para a qual o tile "Criação de Eventos" da hub aponta — ajuste
o `href` no `hub.html` se usar outro domínio/site do Firebase).

## Rodar local

```bash
cd Pipefypainel
firebase emulators:start   # hosting + functions
# o token pode ir em functions/.env como PIPEFY_TOKEN=... só para o emulador
```

## Observações

- A hub e os outros painéis continuam no **GitHub Pages** (deploy via `git push`).
  Só este painel vive no Firebase Hosting; a hub apenas linka para ele.
- Endpoints expostos: `/api/colunas` (novo), `/api/mover-card`,
  `/api/duplicar-card`, `/api/cards/:id` (GET), `/api/cards/:id/fields` (PUT),
  `/api/cards/:id/clone`, `/api/cards/:id/upload`, `/api/pipe-fields`,
  `/api/criar-card`, `/api/templates`, `/api/salvar-template`,
  `/api/deletar-template`, `/api/atualizar-labels`.
