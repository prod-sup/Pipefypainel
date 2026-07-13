/**
 * Proxy Pipefy — Cloud Function (Firebase v2).
 *
 * Segura o PIPEFY_TOKEN no servidor (nunca no navegador) e expõe os mesmos
 * endpoints /api/* que o painel Flask original tinha. É publicado atrás de um
 * rewrite do Firebase Hosting (/api/** -> esta função), então o frontend
 * continua chamando /api/... na mesma origem.
 *
 * Porte 1:1 de api/pipefy_client.py + app.py, com duas diferenças:
 *   - /api/colunas é novo: substitui o render server-side (Jinja) das 5 colunas.
 *   - templates.json (disco) virou Realtime Database em /pipefyTemplates.
 *
 * Configuração (uma vez):
 *   firebase functions:secrets:set PIPEFY_TOKEN
 *   # PIPEFY_PIPE_ID vai em functions/.env (não é segredo)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const FormData = require("form-data");

admin.initializeApp();

const PIPEFY_TOKEN = defineSecret("PIPEFY_TOKEN");
const PIPEFY_API = "https://api.pipefy.com/graphql";

// Fases do pipe (nome amigável -> id da fase no Pipefy).
const COLUNAS = {
  "Caixa de entrada": "326331441",
  "Analise de estrutura": "326331442",
  "Criacao": "326331443",
  "Lobby": "326331444",
  "Concluido": "326331445",
};

// ── Cliente GraphQL ───────────────────────────────────────────────
function headers() {
  const token = process.env.PIPEFY_TOKEN;
  if (!token) throw new Error("PIPEFY_TOKEN não definido");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function gqlPost(query, variables) {
  const resp = await fetch(PIPEFY_API, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const json = await resp.json();
  if (json.errors) {
    const msgs = json.errors.map((e) => e.message || "Erro desconhecido").join("; ");
    throw new Error(`Erro GraphQL: ${msgs}`);
  }
  return json;
}

// ── Queries / mutations (porte de pipefy_client.py) ───────────────
async function fetchCardsByPhase(phaseId) {
  const query = `
    query ($phaseId: ID!) {
      phase(id: $phaseId) {
        cards(last: 50) {
          edges { node {
            id title
            fields { name value }
            labels { id name color }
          } }
        }
      }
    }`;
  const data = await gqlPost(query, { phaseId });
  return data?.data?.phase?.cards?.edges || [];
}

async function fetchCardById(cardId) {
  const query = `
    query ($cardId: ID!) {
      card(id: $cardId) {
        id title
        pipe { id }
        current_phase { id name }
        fields { name value field { id } }
      }
    }`;
  const data = await gqlPost(query, { cardId });
  return data?.data?.card || {};
}

async function fetchCardFull(cardId) {
  const query = `
    query ($cardId: ID!) {
      card(id: $cardId) {
        id title
        current_phase { id name fields { id label } }
        pipe { id organization { id } }
        fields { name value field { id } }
      }
    }`;
  const data = await gqlPost(query, { cardId });
  return data?.data?.card || {};
}

function incrementarTitulo(titulo) {
  const m = titulo.match(/\((\d+)\)$/);
  if (m) {
    const num = parseInt(m[1], 10) + 1;
    return titulo.replace(/\(\d+\)$/, `(${num})`);
  }
  return `${titulo} (2)`;
}

async function cloneCard(cardId) {
  const card = await fetchCardFull(cardId);
  const pipeId = card.pipe.id;
  const phaseId = card.current_phase.id;
  const title = incrementarTitulo(card.title);

  const fieldsAttributes = [];
  for (const f of card.fields || []) {
    let val = f.value;
    const fieldNode = f.field;
    if (!val || !fieldNode || !fieldNode.id) continue;

    if (typeof val === "string" && val.trim().startsWith("[") && val.trim().endsWith("]")) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string" &&
            parsed[0].includes("app.pipefy.com/storage")) {
          continue; // não clona anexos
        }
        val = parsed;
      } catch (_) { /* mantém string */ }
    } else if (typeof val === "string" && val.includes("app.pipefy.com/storage")) {
      continue;
    }
    fieldsAttributes.push({ field_id: fieldNode.id, field_value: val });
  }

  const query = `
    mutation ($pipeId: ID!, $phaseId: ID!, $title: String!, $fieldsAttributes: [FieldValueInput]) {
      createCard(input: { pipe_id: $pipeId, phase_id: $phaseId, title: $title, fields_attributes: $fieldsAttributes }) {
        card { id title }
      }
    }`;
  const data = await gqlPost(query, { pipeId, phaseId, title, fieldsAttributes });
  return data?.data?.createCard || {};
}

async function moveCardToPhase(cardId, phaseId) {
  const query = `
    mutation ($cardId: ID!, $destinationPhaseId: ID!) {
      moveCardToPhase(input: { card_id: $cardId, destination_phase_id: $destinationPhaseId }) {
        card { id title }
      }
    }`;
  const data = await gqlPost(query, { cardId, destinationPhaseId: phaseId });
  return data?.data?.moveCardToPhase || {};
}

async function duplicateCard(cardId, pipeId, phaseId) {
  const cardData = await fetchCardById(cardId);
  if (!cardData || !cardData.id) throw new Error("Card não encontrado");
  const title = cardData.title || "";
  const fieldsAttributes = (cardData.fields || [])
    .filter((f) => f.field && f.field.id)
    .map((f) => ({ field_id: f.field.id, value: f.value || "" }));

  const query = `
    mutation ($pipeId: ID!, $phaseId: ID!, $title: String!, $fieldsAttributes: [FieldValueInput!]!) {
      createCard(input: { pipe_id: $pipeId, phase_id: $phaseId, title: $title, fields_attributes: $fieldsAttributes }) {
        card { id title fields { name value } }
      }
    }`;
  const data = await gqlPost(query, { pipeId, phaseId, title, fieldsAttributes });
  return data?.data?.createCard || {};
}

async function updateCardField(cardId, fieldId, newValue) {
  const query = `
    mutation ($cardId: ID!, $fieldId: ID!, $newValue: [UndefinedInput]) {
      updateCardField(input: { card_id: $cardId, field_id: $fieldId, new_value: $newValue }) {
        clientMutationId
      }
    }`;
  const data = await gqlPost(query, { cardId, fieldId, newValue });
  return data?.data?.updateCardField || {};
}

async function fetchStartFormFields(pipeId) {
  const query = `
    query ($pipeId: ID!) {
      pipe(id: $pipeId) { start_form_fields { id label } }
    }`;
  const data = await gqlPost(query, { pipeId });
  return data?.data?.pipe?.start_form_fields || [];
}

async function createCard(pipeId, phaseId, title, fieldsAttributes, labelIds) {
  const query = `
    mutation ($pipeId: ID!, $phaseId: ID!, $title: String!, $fieldsAttributes: [FieldValueInput!]!, $labelIds: [ID!]) {
      createCard(input: { pipe_id: $pipeId, phase_id: $phaseId, title: $title, fields_attributes: $fieldsAttributes, label_ids: $labelIds }) {
        card { id title fields { name value } }
      }
    }`;
  const data = await gqlPost(query, { pipeId, phaseId, title, fieldsAttributes, labelIds: labelIds || null });
  return data?.data?.createCard || {};
}

async function updateCardLabels(cardId, labelIds) {
  const query = `
    mutation ($cardId: ID!, $labelIds: [ID!]) {
      updateCard(input: { id: $cardId, label_ids: $labelIds }) { card { id } }
    }`;
  const data = await gqlPost(query, { cardId, labelIds });
  return data?.data?.updateCard || {};
}

async function uploadAttachment(cardId, file) {
  const token = process.env.PIPEFY_TOKEN;
  if (!token) throw new Error("PIPEFY_TOKEN não definido");
  const form = new FormData();
  form.append("file", file.buffer, { filename: file.originalname, contentType: file.mimetype });
  const resp = await fetch(`https://api.pipefy.com/v1/cards/${cardId}/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    body: form,
  });
  if (resp.status !== 200) {
    const text = await resp.text();
    throw new Error(`Erro no envio: ${resp.status} - ${text}`);
  }
  return true;
}

// ── Helpers (porte de utils/helpers.py) ───────────────────────────
function transformPipefyCard(edge) {
  const node = edge.node || {};
  const fields = {};
  for (const f of node.fields || []) fields[f.name || ""] = f.value || "";
  return {
    id: node.id,
    titulo: node.title || "",
    clube: fields["Nome do clube/Nombre del club/Club name"] || "",
    jogo: fields["Modalidade/Modalidad/Type:"] || "",
    data_hora: fields["Data e hora/Date and time"] || "",
    protocolo: `#${node.id || ""}`,
    labels: node.labels || [],
  };
}

function parseCardDate(card) {
  const dataStr = (card.data_hora || "").trim().replace(/ /g, " ");
  if (!dataStr) return -Infinity;
  // dd/mm/yyyy HH:MM
  let m = dataStr.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
  // ISO yyyy-mm-dd
  m = dataStr.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return -Infinity;
}

function sortCardsByDate(cards) {
  return cards.slice().sort((a, b) => parseCardDate(b) - parseCardDate(a));
}

// ── Templates no Realtime Database (substitui templates.json) ─────
const TEMPLATES_REF = () => admin.database().ref("pipefyTemplates");

async function lerTemplates() {
  const snap = await TEMPLATES_REF().once("value");
  const val = snap.val() || {};
  return Object.values(val);
}

// ── App Express ───────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const pipeId = () => process.env.PIPEFY_PIPE_ID;

// NOVO: colunas (o que o Jinja renderizava no servidor).
app.get("/api/colunas", async (req, res) => {
  const out = {};
  for (const [slug, id] of Object.entries(COLUNAS)) {
    try {
      const raw = await fetchCardsByPhase(id);
      out[slug] = { id, cards: sortCardsByDate(raw.map(transformPipefyCard)) };
    } catch (e) {
      console.error(`[ERRO] ${slug}:`, e.message);
      out[slug] = { id, cards: [] };
    }
  }
  res.json({ success: true, colunas: out });
});

app.post("/api/mover-card", async (req, res) => {
  const { card_id, fase_destino_id } = req.body || {};
  if (!card_id || !fase_destino_id)
    return res.status(400).json({ success: false, error: "card_id e fase_destino_id são obrigatórios" });
  try {
    await moveCardToPhase(card_id, fase_destino_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/duplicar-card", async (req, res) => {
  const { card_id, fase_id } = req.body || {};
  if (!card_id || !fase_id)
    return res.status(400).json({ success: false, error: "card_id e fase_id são obrigatórios" });
  if (!pipeId()) return res.status(500).json({ success: false, error: "PIPEFY_PIPE_ID não configurado" });
  try {
    const result = await duplicateCard(card_id, pipeId(), fase_id);
    const c = result.card || {};
    res.json({
      success: true,
      card: { id: c.id, titulo: c.title || "", clube: "", jogo: "", data_hora: "", protocolo: `#${c.id || ""}` },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/cards/:cardId/clone", async (req, res) => {
  try {
    const result = await cloneCard(req.params.cardId);
    const c = result.card || {};
    res.json({ success: true, card: { id: c.id, titulo: c.title || "" } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/cards/:cardId/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "Nenhum arquivo enviado" });
  try {
    await uploadAttachment(req.params.cardId, req.file);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/cards/:cardId", async (req, res) => {
  try {
    const card = await fetchCardById(req.params.cardId);
    if (!card || !card.id) return res.status(404).json({ success: false, error: "Card não encontrado" });
    res.json({
      success: true,
      card: {
        id: card.id,
        titulo: card.title || "",
        pipe_id: card.pipe && card.pipe.id,
        current_phase: { id: card.current_phase && card.current_phase.id, name: card.current_phase && card.current_phase.name },
        campos: (card.fields || []).map((f) => ({ name: f.name || "", value: f.value || "", field_id: f.field && f.field.id })),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put("/api/cards/:cardId/fields", async (req, res) => {
  const { field_id, new_value } = req.body || {};
  if (!field_id || new_value === undefined || new_value === null)
    return res.status(400).json({ success: false, error: "field_id e new_value são obrigatórios" });
  try {
    await updateCardField(req.params.cardId, field_id, new_value);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/pipe-fields", async (req, res) => {
  if (!pipeId()) return res.status(500).json({ success: false, error: "PIPEFY_PIPE_ID não configurado" });
  try {
    const fields = await fetchStartFormFields(pipeId());
    res.json({ success: true, fields: fields.map((f) => ({ id: f.id, label: f.label })) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/criar-card", async (req, res) => {
  const { phase_id, title = "Novo Card", fields = [], label_ids = [] } = req.body || {};
  if (!pipeId()) return res.status(500).json({ success: false, error: "PIPEFY_PIPE_ID não configurado" });
  if (!phase_id) return res.status(400).json({ success: false, error: "phase_id é obrigatório" });
  if (!Array.isArray(fields)) return res.status(400).json({ success: false, error: "fields deve ser uma lista" });
  try {
    const fieldsAttributes = fields.map((f) => ({
      field_id: f.field_id,
      field_value: Array.isArray(f.value) ? f.value : String(f.value ?? ""),
    }));
    const result = await createCard(pipeId(), phase_id, title, fieldsAttributes, label_ids);
    const c = result.card || {};
    res.json({ success: true, card: { id: c.id, titulo: c.title || "" } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/templates", async (req, res) => {
  try {
    res.json({ success: true, templates: await lerTemplates() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/salvar-template", async (req, res) => {
  const { card_id } = req.body || {};
  const clubeCustom = ((req.body && req.body.clube_customizado) || "").trim();
  const eventoCustom = ((req.body && req.body.evento_customizado) || "").trim();
  if (!card_id) return res.status(400).json({ success: false, error: "card_id é obrigatório" });
  try {
    const card = await fetchCardById(card_id);
    const fields = {};
    for (const f of card.fields || []) fields[f.name] = f.value;
    const id = `tmpl_${Math.floor(Date.now() / 1000)}`;
    const template = {
      id,
      liga: fields["Liga/Union"] || "",
      clube: clubeCustom || fields["Nome do clube/Nombre del club/Club name"] || "",
      nome_evento: eventoCustom || fields["Nome do evento/Nombre del evento/Name of the event"] || "",
      garantido: fields["Premiação garantida/Garantizado/Prize pool"] || "0",
      card_id_origem: card_id,
      criado_em: new Date().toISOString(),
      campos_completos: fields,
    };
    await TEMPLATES_REF().child(id).set(template);
    res.json({ success: true, template });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/deletar-template", async (req, res) => {
  const { template_id } = req.body || {};
  if (!template_id) return res.status(400).json({ success: false, error: "template_id é obrigatório" });
  try {
    const ref = TEMPLATES_REF().child(template_id);
    const snap = await ref.once("value");
    if (!snap.exists()) return res.status(404).json({ success: false, error: "Template não encontrado" });
    await ref.remove();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/atualizar-labels", async (req, res) => {
  const { card_id, label_ids = [] } = req.body || {};
  if (!card_id) return res.status(400).json({ success: false, error: "card_id é obrigatório" });
  try {
    await updateCardLabels(card_id, label_ids);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

exports.pipefyApi = onRequest(
  { secrets: [PIPEFY_TOKEN], region: "us-central1", cors: true },
  app
);
