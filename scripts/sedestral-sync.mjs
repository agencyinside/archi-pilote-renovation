#!/usr/bin/env node
/* ============================================================
   Synchronisation Sedestral → blog ARCHI PILOTE RÉNOVATION

   Cycle complet, exécuté toutes les heures par GitHub Actions :
     1. GET  /alya/blog-articles?states=DRAFT
     2. pour chaque article inconnu : téléchargement de la couverture
        et des images du corps dans public/uploads/sedestral/<slug>/,
        réécriture des URLs sedestral.com → URLs internes, écriture
        dans content/blog/generated.json
     3. commit + push  →  build GitHub Actions, déploiement o2switch
     4. attente de la mise en ligne réelle (HTTP 200 sur l'URL finale)
     5. PATCH /alya/blog-articles/{id}  { state: PUBLISHED, url }
        — jamais avant l'étape 4.

   Idempotence : content/blog/_sedestral-state.json garde l'id Sedestral
   de tout article importé. Un id connu n'est jamais réimporté ; un id
   importé mais non confirmé est repris à l'étape 4 au run suivant.

   Robustesse : chaque article est traité dans son propre try/catch.
   Une couverture manquante, une image morte ou un PATCH en échec
   n'interrompent jamais le traitement des autres articles.

   Aucune dépendance npm : Node 20+ (fetch, fs/promises) uniquement.
   Usage : node scripts/sedestral-sync.mjs [--dry-run] [--no-push]
   ============================================================ */

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- Configuration ---------- */

const API_BASE = process.env.SEDESTRAL_API_BASE ?? "https://api.sedestral.com/api/v1";
const API_KEY = process.env.SEDESTRAL_API_KEY;

/* Origine publique du site : sert à construire l'URL renvoyée à Sedestral
   et à vérifier la mise en ligne. Surchargée par la variable d'environnement
   SITE_ORIGIN (définie dans le workflow). */
const SITE_ORIGIN = (process.env.SITE_ORIGIN ?? "https://www.archipiloterenovation.com").replace(/\/$/, "");

const BLOG_PREFIX = "/blog"; // structure d'URL existante : /blog/<slug>
const DEFAULT_CATEGORY = process.env.SEDESTRAL_DEFAULT_CATEGORY ?? "Rénovation";

const GENERATED_FILE = path.join(ROOT, "content/blog/generated.json");
const STATE_FILE = path.join(ROOT, "content/blog/_sedestral-state.json");
const EDITORIAL_FILE = path.join(ROOT, "app/data.ts");
const WHATSWRONG_FILE = path.join(ROOT, "content/blog/whatswrong.json");
const UPLOAD_DIR = path.join(ROOT, "public/uploads/sedestral");
const UPLOAD_PUBLIC = "/uploads/sedestral";

const DEPLOY_TIMEOUT_MS = Number(process.env.SEDESTRAL_DEPLOY_TIMEOUT_MS ?? 15 * 60_000);
const DEPLOY_POLL_MS = 20_000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 45_000;

const DRY_RUN = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--no-push") || DRY_RUN;

/* ---------- Journalisation ---------- */

const errors = [];
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const warn = (msg) => { console.log(`::warning::${msg}`); };
const fail = (msg) => { errors.push(msg); console.log(`::error::${msg}`); };

/* ---------- HTTP ---------- */

async function api(pathname, init = {}) {
  const url = pathname.startsWith("http") ? pathname : `${API_BASE}${pathname}`;
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
  if (!res.ok) {
    const detail = (text || "").slice(0, 400);
    throw new Error(`${init.method ?? "GET"} ${url} → HTTP ${res.status} ${detail}`);
  }
  return data;
}

/* ---------- Lecture tolérante de la réponse ----------
   Les noms de champs exacts de l'API ne sont pas figés : on accepte les
   variantes usuelles plutôt que de casser au premier renommage. */

function first(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = v.url ?? v.src ?? v.href ?? v.value ?? v.name;
      if (nested) return nested;
      continue;
    }
    if (Array.isArray(v)) { if (v.length) return typeof v[0] === "string" ? v[0] : (v[0]?.name ?? v[0]?.value); continue; }
    return v;
  }
  return undefined;
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  // 09/09/2026 : l'API Sedestral renvoie ses articles sous la clé « contents ».
  for (const k of ["contents", "data", "items", "results", "articles", "content", "blogArticles"]) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  return [];
}

function normalize(raw) {
  /* 09/09/2026 : l'API imbrique le contenu éditorial sous « data », en laissant
     id, format et state à la racine. On lit donc les champs dans data quand il
     existe, et l'identifiant à la racine en priorité. */
  const d = raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : raw;
  return {
    id: String(first(raw, ["id", "_id", "uuid", "articleId"]) ?? first(d, ["id", "_id"]) ?? ""),
    title: first(d, ["title", "name", "heading"]),
    metaDescription: first(d, ["metaDescription", "meta_description", "seoDescription", "description", "excerpt"]),
    body: first(d, ["body", "content", "html", "bodyHtml", "contentHtml"]),
    cover: first(d, ["cover", "coverUrl", "cover_url", "coverImage", "image", "thumbnail", "picture"]),
    slug: first(d, ["slug", "permalink", "handle"]),
    keyword: first(d, ["keyword", "mainKeyword", "primaryKeyword", "focusKeyword", "mainKeyphrase", "keywords", "tags"]),
    category: first(d, ["category", "categoryName", "topic"]),
    publishedAt: first(d, ["publishedAt", "createdAt", "created_at", "date", "updatedAt"]),
  };
}

/* ---------- Utilitaires ---------- */

function slugify(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function frDate(iso) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" })
    .format(new Date(iso));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Slugs déjà pris par les articles éditoriaux écrits à la main dans app/data.ts. */
async function editorialSlugs() {
  try {
    const src = await readFile(EDITORIAL_FILE, "utf8");
    return new Set([...src.matchAll(/slug:\s*"([^"]+)"/g)].map((m) => m[1]));
  } catch { return new Set(); }
}

/* ---------- Assainissement du HTML ----------
   Le corps vient d'un outil interne (source de confiance) mais est injecté
   via dangerouslySetInnerHTML : on retire tout ce qui peut exécuter du code
   ou casser la mise en page. */

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "mark", "small", "sub", "sup",
  "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "figure", "figcaption",
  "a", "img", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "code", "pre", "span", "div",
]);
const ALLOWED_ATTRS = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "width", "height", "loading"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
};

function sanitizeHtml(html) {
  let out = String(html);
  // Blocs entiers supprimés, contenu compris.
  out = out.replace(/<(script|style|iframe|object|embed|form|noscript)\b[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<(script|style|iframe|object|embed|form|noscript)\b[^>]*\/?>/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  return out.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (full, close, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return ""; // balise retirée, contenu conservé
    if (close) return `</${tag}>`;

    const allowed = ALLOWED_ATTRS[tag] ?? [];
    const kept = [];
    for (const m of rawAttrs.matchAll(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = m[1].toLowerCase();
      const value = m[3] ?? m[4] ?? "";
      if (!allowed.includes(name)) continue;
      if ((name === "href" || name === "src") && /^\s*(javascript|data|vbscript):/i.test(value)) continue;
      kept.push(`${name}="${value.replace(/"/g, "&quot;")}"`);
    }
    if (tag === "a") {
      const href = kept.find((k) => k.startsWith("href="));
      if (href && /^href="https?:\/\//i.test(href) && !href.includes(new URL(SITE_ORIGIN).host)) {
        kept.push('target="_blank"', 'rel="noopener noreferrer"');
      }
    }
    if (tag === "img" && !kept.some((k) => k.startsWith("loading="))) kept.push('loading="lazy"');
    const selfClosing = tag === "img" || tag === "br" || tag === "hr";
    return `<${tag}${kept.length ? " " + kept.join(" ") : ""}${selfClosing ? " /" : ""}>`;
  })
    // Liens vidés de leur href (protocole refusé) : on ne garde que le texte.
    .replace(/<a>([\s\S]*?)<\/a>/gi, "$1");
}

/* ---------- Téléchargement des images ---------- */

const EXT_BY_TYPE = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/avif": ".avif", "image/gif": ".gif", "image/svg+xml": ".svg",
};

async function downloadImage(url, slug, basename) {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type && !type.startsWith("image/")) throw new Error(`type inattendu : ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("fichier vide");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`trop lourd (${Math.round(buf.length / 1024)} Ko)`);

  const urlExt = path.extname(new URL(url).pathname).toLowerCase();
  const ext = EXT_BY_TYPE[type] ?? (/^\.(jpe?g|png|webp|avif|gif|svg)$/.test(urlExt) ? urlExt : ".jpg");
  const dir = path.join(UPLOAD_DIR, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, basename + ext), buf);
  return `${UPLOAD_PUBLIC}/${slug}/${basename}${ext}`;
}

/** Remplace toutes les <img src> distantes par leur copie interne. */
async function internalizeBodyImages(html, slug) {
  const srcs = [...String(html).matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const unique = [...new Set(srcs)].filter((s) => /^https?:\/\//i.test(s));
  let out = String(html);
  let i = 0;
  for (const src of unique) {
    i += 1;
    try {
      const local = await downloadImage(src, slug, `img-${String(i).padStart(2, "0")}`);
      out = out.split(src).join(local);
      log(`    image ${i}/${unique.length} → ${local}`);
    } catch (e) {
      warn(`[${slug}] image non téléchargée (${src}) : ${e.message} — URL d'origine conservée`);
    }
  }
  // Les liens sortants vers sedestral.com n'ont rien à faire sur le blog :
  // on garde le texte, on retire le lien.
  const unwrapped = out.match(/<a\b[^>]*href\s*=\s*["'][^"']*sedestral\.com[^"']*["'][^>]*>/gi)?.length ?? 0;
  if (unwrapped) {
    out = out.replace(/<a\b[^>]*href\s*=\s*["'][^"']*sedestral\.com[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, "$1");
    log(`    ${unwrapped} lien(s) sortant(s) vers sedestral.com retiré(s)`);
  }

  // Filet de sécurité : plus aucune URL sedestral.com ne doit subsister.
  const leftovers = [...out.matchAll(/https?:\/\/[^\s"'<>]*sedestral\.com[^\s"'<>]*/gi)].map((m) => m[0]);
  if (leftovers.length) warn(`[${slug}] ${leftovers.length} URL(s) sedestral.com non réécrite(s) : ${leftovers.slice(0, 3).join(", ")}`);
  return out;
}

/* ---------- Git ---------- */

async function git(...args) {
  const { stdout } = await exec("git", args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function commitAndPush(message) {
  if (NO_PUSH) { log(`(push désactivé) commit prévu : ${message}`); return false; }
  await git("config", "user.name", "sedestral-sync[bot]");
  await git("config", "user.email", "sedestral-sync@users.noreply.github.com");
  await git("add", "content/blog/generated.json", "content/blog/_sedestral-state.json", "public/uploads/sedestral");
  const staged = await git("diff", "--cached", "--name-only");
  if (!staged) { log("rien à commiter"); return false; }
  await git("commit", "-m", message);
  // main a pu avancer pendant le run (synchro WhatsWrong, autre commit) : on se replace dessus.
  // Les deux synchros n'écrivent jamais les mêmes fichiers, le rebase ne peut pas entrer en conflit.
  await git("pull", "--rebase", "origin", "main");
  await git("push", "origin", "HEAD:main");
  log(`poussé : ${message}`);
  return true;
}

/* ---------- Vérification de mise en ligne ---------- */

async function waitOnline(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow", headers: { "Cache-Control": "no-cache" } });
      if (res.ok) {
        // 09/09/2026 : un HTTP 200 ne prouve pas que la page est en ligne. Le jour où le
        // domaine a été suspendu par le registrar, chaque adresse du site répondait 200
        // avec une page « Your domain is suspended » : sur le seul statut, cette boucle
        // aurait confirmé PUBLISHED à Sedestral pour des articles que personne ne pouvait
        // lire. On exige donc que le corps soit bien une page du site et non une page
        // d'interception. Le libellé de la marque figure dans l'en-tête de toutes les pages.
        const html = await res.text();
        if (/domain is suspended/i.test(html)) { await new Promise((r) => setTimeout(r, DEPLOY_POLL_MS)); continue; }
        if (/ARCHI PILOTE/i.test(html)) return true;
      }
    } catch { /* déploiement en cours */ }
    await new Promise((r) => setTimeout(r, DEPLOY_POLL_MS));
  }
  return false;
}

/* ---------- Programme principal ---------- */

async function main() {
  if (!API_KEY) {
    console.log("::error::SEDESTRAL_API_KEY absente de l'environnement — arrêt.");
    process.exit(1);
  }
  log(`Synchronisation Sedestral — site ${SITE_ORIGIN}${DRY_RUN ? " (essai à blanc)" : ""}`);

  const payload = await api("/alya/blog-articles?states=DRAFT");
  const rawList = asList(payload);
  log(`${rawList.length} article(s) à l'état DRAFT`);

  if (DRY_RUN) {
    console.log("\n--- Réponse brute du premier article (vérification des noms de champs) ---");
    const sample = rawList[0];
    if (!sample) { console.log("(aucun article DRAFT)"); return; }
    const shown = { ...sample };
    for (const k of Object.keys(shown)) {
      if (typeof shown[k] === "string" && shown[k].length > 300) shown[k] = shown[k].slice(0, 300) + " …[tronqué]";
    }
    console.log(JSON.stringify(shown, null, 2));
    console.log("\n--- Champs retenus après normalisation ---");
    const n = normalize(sample);
    console.log(JSON.stringify({ ...n, body: n.body ? `${String(n.body).length} caractères` : undefined }, null, 2));
    return;
  }

  const state = await readJson(STATE_FILE, { version: 1, articles: {} });
  const generated = await readJson(GENERATED_FILE, []);
  // Les slugs des articles WhatsWrong sont aussi réservés : les deux sources partagent /blog/<slug>.
  const whatswrongSlugs = (await readJson(WHATSWRONG_FILE, [])).map((a) => a.slug);
  const taken = new Set([...(await editorialSlugs()), ...whatswrongSlugs, ...generated.map((a) => a.slug)]);

  /* --- Phase 1 : import --- */
  const nouveaux = [];
  for (const raw of rawList) {
    const a = normalize(raw);
    try {
      if (!a.id) throw new Error("identifiant absent de la réponse API");
      if (state.articles[a.id]) { log(`· ${a.id} déjà importé — ignoré`); continue; }
      if (!a.title || !a.body) throw new Error("titre ou corps manquant");
      if (!a.cover) throw new Error("image de couverture absente");

      let slug = slugify(a.slug || a.title);
      if (!slug) throw new Error("slug impossible à construire");
      let n = 2;
      const base = slug;
      while (taken.has(slug)) slug = `${base}-${n++}`;

      log(`→ import « ${a.title} » (${a.id}) → ${BLOG_PREFIX}/${slug}`);
      const cover = await downloadImage(String(a.cover), slug, "cover");
      log(`    couverture → ${cover}`);
      const body = sanitizeHtml(await internalizeBodyImages(a.body, slug));

      const iso = a.publishedAt ? new Date(a.publishedAt).toISOString() : new Date().toISOString();
      const article = {
        sedestralId: a.id,
        slug,
        titre: String(a.title).trim(),
        date: frDate(iso),
        dateISO: iso.slice(0, 10),
        excerpt: String(a.metaDescription ?? "").trim(),
        categorie: String(a.category ?? DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY,
        photo: cover,
        keyword: a.keyword ? String(a.keyword).trim() : undefined,
        bodyHtml: body,
      };
      generated.push(article);
      taken.add(slug);
      state.articles[a.id] = {
        slug,
        url: `${SITE_ORIGIN}${BLOG_PREFIX}/${slug}`,
        importedAt: new Date().toISOString(),
        confirmedAt: null,
      };
      nouveaux.push(a.id);
    } catch (e) {
      fail(`article ignoré (${a.id || "id inconnu"} — « ${a.title ?? "sans titre"} ») : ${e.message}`);
      // Les fichiers éventuellement déjà écrits pour ce slug sont retirés au run suivant
      // par le nettoyage des dossiers orphelins ci-dessous.
    }
  }

  if (nouveaux.length) {
    generated.sort((x, y) => y.dateISO.localeCompare(x.dateISO));
    await writeJson(GENERATED_FILE, generated);
    await writeJson(STATE_FILE, state);
    await cleanOrphanUploads(generated);
    await commitAndPush(`content: ${nouveaux.length} article(s) Sedestral publié(s)`);
  } else {
    log("aucun nouvel article à importer");
  }

  /* --- Phase 2 : confirmation (nouveaux + reliquats des runs précédents) --- */
  const aConfirmer = Object.entries(state.articles).filter(([, v]) => !v.confirmedAt);
  if (!aConfirmer.length) { log("rien à confirmer auprès de Sedestral"); return finish(); }

  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let confirmés = 0;
  for (const [id, entry] of aConfirmer) {
    try {
      log(`· vérification de la mise en ligne : ${entry.url}`);
      const online = await waitOnline(entry.url, deadline);
      if (!online) {
        fail(`page non accessible dans le délai imparti (${entry.url}) — PATCH non envoyé, reprise au prochain run`);
        continue;
      }
      await api(`/alya/blog-articles/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "PUBLISHED", url: entry.url }),
      });
      entry.confirmedAt = new Date().toISOString();
      confirmés += 1;
      log(`  ✓ confirmé PUBLISHED auprès de Sedestral`);
    } catch (e) {
      fail(`PATCH en échec pour ${id} (${entry.url}) : ${e.message} — reprise au prochain run`);
    }
  }

  if (confirmés) {
    await writeJson(STATE_FILE, state);
    // [skip ci] : ce commit ne change aucun contenu rendu, inutile de redéployer.
    await commitAndPush(`chore: confirmation Sedestral de ${confirmés} article(s) [skip ci]`);
  }
  finish();
}

/** Supprime les dossiers d'images d'articles qui ne sont plus référencés
    (import interrompu à mi-chemin lors d'un run précédent). */
async function cleanOrphanUploads(generated) {
  if (!existsSync(UPLOAD_DIR)) return;
  const valides = new Set(generated.map((a) => a.slug));
  for (const dir of await readdir(UPLOAD_DIR, { withFileTypes: true })) {
    if (dir.isDirectory() && !valides.has(dir.name)) {
      await rm(path.join(UPLOAD_DIR, dir.name), { recursive: true, force: true });
      warn(`dossier d'images orphelin supprimé : ${dir.name}`);
    }
  }
}

function finish() {
  if (errors.length) {
    log(`terminé avec ${errors.length} erreur(s) :`);
    errors.forEach((e) => log(`  – ${e}`));
    process.exitCode = 1;
  } else {
    log("terminé sans erreur");
  }
}

main().catch((e) => {
  console.log(`::error::échec global de la synchronisation : ${e.stack ?? e.message}`);
  process.exit(1);
});
