import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const store = getStore({ name: "dre-inscricoes", consistency: "strong" });
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (statusCode, body) => new Response(JSON.stringify(body), { status: statusCode, headers });
const secret = () => process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD;
function sign(value) { return crypto.createHmac("sha256", secret()).update(value).digest("hex"); }
function makeToken() { const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url"); return payload + "." + sign(payload); }
function validToken(event) {
  const authorization = event.headers?.get
    ? event.headers.get("authorization")
    : event.headers?.authorization;
  const token = (authorization || "").replace(/^Bearer\\s+/i, "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !secret()) return false;
  const expected = sign(payload);
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); } catch { return false; }
}
async function all() { return (await store.get("submissions", { type: "json" })) || []; }
async function save(items) { await store.setJSON("submissions", items); }
export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  let body; try { body = await request.json(); } catch { return json(400, { error: "Requisição inválida." }); }
  const action = body.action;
  if (action === "login") {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) return json(503, { error: "Configure ADMIN_PASSWORD nas variáveis de ambiente do Netlify." });
    const supplied = String(body.password || "");
    const a = Buffer.from(supplied), b = Buffer.from(password);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(401, { error: "Senha incorreta." });
    return json(200, { token: makeToken() });
  }
  if (!validToken(request)) return json(401, { error: "Sessão inválida ou expirada. Entre novamente." });
  if (action === "list") return json(200, { items: await all() });
  if (action === "status") {
    const allowed = ["Pendente", "Em análise", "Aceita", "Reprovada"];
    if (!allowed.includes(body.status)) return json(400, { error: "Status inválido." });
    const items = await all(), item = items.find(x => x.id === body.id);
    if (!item) return json(404, { error: "Inscrição não encontrada." });
    const previous = item.status; item.status = body.status; item.updatedAt = new Date().toISOString();
    await save(items);
    if (body.status === "Aceita" && previous !== "Aceita") await notifyDiscord(item);
    return json(200, { ok: true, item });
  }
  if (action === "register") {
    const d = body.data || {};
    const required = ["firstName","lastName","city","rg","phone","discordName","discordTag"];
    if (required.some(k => !String(d[k] || "").trim())) return json(400, { error: "Preencha todos os campos obrigatórios." });
    if (!/^\d{6}$/.test(String(d.rg)) || !/^\d{3}-\d{3}$/.test(String(d.phone))) return json(400, { error: "O RG deve ter seis números sem hífen e o telefone deve ter o formato 000-000." });
    if (d.consent !== true) return json(400, { error: "Confirme a declaração antes de enviar." });
    const items = await all();
    if (items.some(x => x.discordId && d.discordId && x.discordId === d.discordId && !["Reprovada"].includes(x.status))) return json(409, { error: "Já existe uma inscrição ativa com este ID do Discord." });
    const id = "DRE-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    const item = { id, firstName: clean(d.firstName), lastName: clean(d.lastName), city: clean(d.city), rg: d.rg, phone: d.phone, discordName: clean(d.discordName), discordTag: clean(d.discordTag), discordId: String(d.discordId || "").replace(/\D/g,"").slice(0,22), status: "Pendente", createdAt: new Date().toISOString() };
    items.unshift(item); await save(items);
    return json(201, { ok: true, id, status: item.status });
  }
  return json(400, { error: "Ação desconhecida." });
};
function clean(v) { return String(v || "").trim().replace(/[<>]/g, "").slice(0, 100); }
async function notifyDiscord(item) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const mention = /^\d{17,20}$/.test(item.discordId) ? `<@${item.discordId}>` : item.discordTag;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `✅ **Inscrição aceita — DRE / Nova Capital RP**\nCandidato: **${item.firstName} ${item.lastName}**\nDiscord: ${mention}\nProtocolo: \`${item.id}\`\nO candidato foi aprovado na etapa de inscrição e deve acompanhar as orientações da equipe para os próximos passos.` , allowed_mentions: { parse: [], users: /^\d{17,20}$/.test(item.discordId) ? [item.discordId] : [] } }) });
  } catch (e) { console.error("Falha ao notificar Discord:", e); }
}
