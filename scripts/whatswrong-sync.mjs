#!/usr/bin/env node
/* ============================================================
   Synchronisation WhatsWrong (Léa) → blog ARCHI PILOTE RÉNOVATION

   Tourne EN PLUS de la synchronisation Sedestral : chacune a ses propres
   fichiers, les articles des deux sources cohabitent sous /blog/<slug>.

   WhatsWrong ne pousse rien : c'est le site qui tire les articles et en
   garde une copie (texte + images) dans le dépôt. Si WhatsWrong tombe ou
   si l'abonnement s'arrête, les articles restent en ligne.

   Cycle complet, exécuté toutes les heures par GitHub Actions :
     1. GET /api/v1/lea/blog-articles?states=DRAFT     (articles terminés)
        GET /api/v1/lea/blog-articles?states=PUBLISHED (déjà publiés ailleurs
        et inconnus du dépôt : repris une seule fois, sans PATCH)
     2. pour chaque article inconnu : couverture et images du corps copiées
        dans public/uploads/whatswrong/<slug>/, corps assaini, FAQ ajoutée
        au corps, écriture dans content/blog/whatswrong.json
     3. commit + push sur main → build GitHub Actions, déploiement o2switch
     4. attente de la mise en ligne réelle de la page (marque + titre)
     5. PATCH { state: PUBLISHED, url } — jamais avant l'étape 4.
        C'est ce PATCH qui lance le suivi SEO chez WhatsWrong.
     6. article retiré à la main de whatswrong.json : PATCH { state: DRAFT }.

   Idempotence : content/blog/_whatswrong-state.json garde l'id WhatsWrong
   de tout article importé. Un id connu n'est jamais réimporté ; un id
   importé mais non confirmé est repris à l'étape 4 au run suivant.

   Slugs : un article WhatsWrong ne prend jamais le slug d'un article
   éditorial (app/data.ts) ni d'un article Sedestral (generated.json).

   Limite API : 60 appels/min. Sur HTTP 429, le run s'arrête proprement
   et le suivant reprend là où celui-ci s'est arrêté.

   Aucune dépendance npm : Node 20+ uniquement.
   Usage : node scripts/whatswrong-sync.mjs [--dry-run] [--no-push]
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

const API_BASE = process.env.WW_API_BASE || "https://www.whatswrong.io";
const API_KEY = process.env.WW_API_KEY || process.env.WHATSWRONG_API_KEY;
const SITE_ORIGIN = (process.env.SITE_ORIGIN || "https://www.archipiloterenovation.com").replace(/\/$/, "");

const BLOG_PREFIX = "/blog";
const DEFAULT_CATEGORY = process.env.WW_DEFAULT_CATEGORY || "Rénovation";

const ARTICLES_FILE = path.join(ROOT, "content/blog/whatswrong.json");
const STATE_FILE = path.join(ROOT, "content/blog/_whatswrong-state.json");
const SEDESTRAL_FILE = path.join(ROOT, "content/blog/generated.json");
const EDITORIAL_FILE = path.join(ROOT, "app/data.ts");
const UPLOAD_DIR = path.join(ROOT, "public/uploads/whatswrong");
const UPLOAD_PUBLIC = "/uploads/whatswrong";

const DEPLOY_TIMEOUT_MS = 15 * 60_000;
const DEPLOY_POLL_MS = 20_000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 45_000;

const DRY_RUN = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--no-push") || DRY_RUN;

/* ---------- Journalisation ---------- */

const errors = [];
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const warn = (msg) => console.log(`::warning::${msg}`);
const fail = (msg) => { errors.push(msg); console.log(`::error::${msg}`); };

/* ---------- HTTP ---------- */

class RateLimited extends Error {}

async function whatswrong(method, pathname, body) {
  const res = await fetch(API_BASE + pathname, {
    method,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) {
    throw new RateLimited(`limite d'appels atteinte, réessayer dans ${res.headers.get("Retry-After") ?? "?"} s`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
  if (!res.ok) {
    throw new Error(`WhatsWrong ${res.status} (${method} ${pathname}) : ${data?.message ?? text.slice(0, 300)}`);
  }
  return data;
}

/** Tous les articles d'un état, page par page. */
async function listArticles(state) {
  const out = [];
  for (let offset = 0; offset < 500; offset += 20) {
    const { contents = [] } = await whatswrong(
      "GET",
      `/api/v1/lea/blog-articles?states=${state}&limit=20&offset=${offset}`,
    );
    out.push(...contents);
    if (contents.length < 20) break;
  }
  return out;
}

/* ---------- Utilitaires ---------- */

/** Dernier segment du slug fourni (ou du titre), en minuscules ASCII. */
function wwSlug(raw) {
  const last = String(raw ?? "").split("/").filter(Boolean).pop() ?? "";
  return last
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function frDate(iso) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" })
    .format(new Date(iso));
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Slugs /blog/<slug> déjà occupés par les articles éditoriaux et Sedestral. */
async function otherSlugs() {
  const slugs = new Set();
  try {
    const src = await readFile(EDITORIAL_FILE, "utf8");
    for (const m of src.matchAll(/slug:\s*"([^"]+)"/g)) slugs.add(m[1]);
  } catch { /* pas d'articles éditoriaux */ }
  for (const a of await readJson(SEDESTRAL_FILE, [])) if (a?.slug) slugs.add(a.slug);
  return slugs;
}

/* ---------- Assainissement du HTML ----------
   Même règle que la synchronisation Sedestral : le corps est injecté via
   dangerouslySetInnerHTML, on retire tout ce qui peut exécuter du code
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
  out = out.replace(/<(script|style|iframe|object|embed|form|noscript|nav)\b[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<(script|style|iframe|object|embed|form|noscript)\b[^>]*\/?>/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  // Le H1 de la page est le titre de l'article : un H1 du corps devient H2.
  out = out.replace(/<(\/?)h1\b/gi, "<$1h2");

  return out.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (full, close, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
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
    .replace(/<a>([\s\S]*?)<\/a>/gi, "$1");
}

/* ---------- Téléchargement des images ---------- */

const EXT_BY_TYPE = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/avif": ".avif", "image/gif": ".gif",
};

async function downloadImage(url, slug, basename) {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type && !type.startsWith("image/")) throw new Error(`type inattendu : ${type}`);
  if (type === "image/svg+xml") throw new Error("SVG refusé");
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("fichier vide");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`trop lourd (${Math.round(buf.length / 1024)} Ko)`);

  const urlExt = path.extname(new URL(url).pathname).toLowerCase();
  const ext = EXT_BY_TYPE[type] ?? (/^\.(jpe?g|png|webp|avif|gif)$/.test(urlExt) ? urlExt : ".jpg");
  const dir = path.join(UPLOAD_DIR, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, basename + ext), buf);
  return `${UPLOAD_PUBLIC}/${slug}/${basename}${ext}`;
}

/** Remplace toutes les <img src> distantes par leur copie locale. */
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
  // Les liens vers whatswrong.io n'ont rien à faire sur le blog : on garde le texte.
  return out.replace(/<a\b[^>]*href\s*=\s*["'][^"']*whatswrong\.io[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, "$1");
}

/** Liens internes : une redirection est remplacée par l'URL finale, un lien
    mort est retiré (le texte reste). Évite les sauts inutiles et les 404. */
async function fixInternalLinks(html) {
  const host = new URL(SITE_ORIGIN).host.replace(/^www\./, "");
  const internal = (href) => {
    if (href.startsWith("/") && !href.startsWith("//")) return href;
    try {
      const u = new URL(href);
      return u.host.replace(/^www\./, "") === host ? u.pathname + u.search + u.hash : null;
    } catch { return null; }
  };
  const hrefs = [...String(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  let out = String(html);
  for (const href of new Set(hrefs)) {
    const p = internal(href);
    if (!p) continue;
    const [pathname, hash = ""] = p.split("#");
    try {
      const res = await fetch(SITE_ORIGIN + pathname, { redirect: "follow", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const final = new URL(res.url);
      if (res.status === 404) {
        const re = new RegExp(`<a\\b[^>]*href\\s*=\\s*"${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)<\\/a>`, "gi");
        out = out.replace(re, "$1");
        warn(`lien interne mort retiré : ${href}`);
      } else if (res.ok && final.pathname !== pathname) {
        const to = final.pathname + (hash ? `#${hash}` : "");
        out = out.split(`href="${href}"`).join(`href="${to}"`);
        log(`    lien ${href} → ${to}`);
      }
    } catch (e) {
      warn(`lien interne non vérifié (${href}) : ${e.message}`);
    }
  }
  return out;
}

/* ---------- Git ---------- */

async function git(...args) {
  const { stdout } = await exec("git", args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function commitAndPush(message) {
  if (NO_PUSH) { log(`(push désactivé) commit prévu : ${message}`); return false; }
  await git("config", "user.name", "whatswrong-sync[bot]");
  await git("config", "user.email", "whatswrong-sync@users.noreply.github.com");
  await git("add", "content/blog/whatswrong.json", "content/blog/_whatswrong-state.json", "public/uploads/whatswrong");
  const staged = await git("diff", "--cached", "--name-only");
  if (!staged) { log("rien à commiter"); return false; }
  await git("commit", "-m", message);
  // main a pu avancer pendant le run (synchro Sedestral, autre commit) : on se replace dessus.
  // Les deux synchros n'écrivent jamais les mêmes fichiers, le rebase ne peut pas entrer en conflit.
  await git("pull", "--rebase", "origin", "main");
  await git("push", "origin", "HEAD:main");
  log(`poussé : ${message}`);
  return true;
}

/* ---------- Vérification de mise en ligne ---------- */

async function waitOnline(url, title, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow", headers: { "Cache-Control": "no-cache" } });
      if (res.ok) {
        // Un 200 ne suffit pas (domaine suspendu, page parking, ancienne version
        // du site) : on exige la marque ET le titre de l'article dans la page.
        const html = (await res.text())
          .replace(/&#x27;|&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&");
        if (/ARCHI PILOTE/i.test(html) && html.includes(title.slice(0, 30))) return true;
      }
    } catch { /* déploiement en cours */ }
    await new Promise((r) => setTimeout(r, DEPLOY_POLL_MS));
  }
  return false;
}

/* ---------- Import d'un article ---------- */

/** FAQ WhatsWrong → HTML ajouté en fin de corps (la page en tire aussi le schéma FAQPage). */
function faqHtml(faq) {
  if (!faq?.items?.length) return "";
  const items = faq.items
    .filter((it) => it?.question && it?.answer)
    .map((it) => `<h3>${escapeHtml(it.question)}</h3>${/<\w/.test(it.answer) ? it.answer : `<p>${escapeHtml(it.answer)}</p>`}`)
    .join("");
  return items ? `<h2>${escapeHtml(faq.title || "Questions fréquentes")}</h2>${items}` : "";
}

const plain = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function importArticle({ id, data: d }, taken) {
  if (!d?.title || !d?.body) throw new Error("titre ou corps manquant");
  const base = wwSlug(d.slug || d.title);
  if (!base) throw new Error("slug impossible à construire");
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;

  log(`→ import « ${d.title} » (${id}) → ${BLOG_PREFIX}/${slug}`);

  let body = await internalizeBodyImages(String(d.body) + faqHtml(d.faq), slug);
  body = sanitizeHtml(await fixInternalLinks(body));

  // La page affiche une image d'en-tête : couverture, sinon première image du corps.
  let photo = null;
  if (d.cover?.url) {
    try {
      photo = await downloadImage(d.cover.url, slug, "cover");
      log(`    couverture → ${photo}`);
    } catch (e) {
      warn(`[${slug}] couverture non téléchargée (${e.message})`);
    }
  }
  if (!photo) photo = body.match(new RegExp(`src="(${UPLOAD_PUBLIC}/${slug}/[^"]+)"`))?.[1] ?? null;
  if (!photo) throw new Error("aucune image utilisable (ni couverture, ni image dans le corps)");

  const iso = new Date(d.createdAt ?? Date.now()).toISOString();
  return {
    wwId: id,
    slug,
    titre: String(d.title).trim(),
    date: frDate(iso),
    dateISO: iso.slice(0, 10),
    excerpt: String(d.description ?? "").trim(),
    categorie: DEFAULT_CATEGORY,
    photo,
    keyword: d.mainKeyword ? String(d.mainKeyword).trim() : undefined,
    bodyHtml: body,
    faq: d.faq?.items?.length
      ? d.faq.items.filter((it) => it?.question && it?.answer).map((it) => ({ question: plain(it.question), answer: plain(it.answer) }))
      : undefined,
  };
}

/* ---------- Programme principal ---------- */

async function main() {
  if (!API_KEY) {
    console.log("::error::WW_API_KEY absente de l'environnement — arrêt.");
    process.exit(1);
  }
  log(`Synchronisation WhatsWrong — site ${SITE_ORIGIN}${DRY_RUN ? " (essai à blanc)" : ""}`);

  const state = await readJson(STATE_FILE, { version: 1, articles: {} });
  const articles = await readJson(ARTICLES_FILE, []);
  const others = await otherSlugs();
  const taken = new Set([...others, ...articles.map((a) => a.slug)]);

  const drafts = await listArticles("DRAFT");
  const published = (await listArticles("PUBLISHED")).filter((a) => !state.articles[a.id]);
  log(`${drafts.length} article(s) DRAFT, ${published.length} article(s) PUBLISHED à reprendre`);

  if (DRY_RUN) {
    for (const c of [...drafts, ...published]) {
      log(`· ${c.id} — « ${c.data?.title ?? "sans titre"} » → ${BLOG_PREFIX}/${wwSlug(c.data?.slug || c.data?.title)}`);
    }
    return;
  }

  /* --- Phase 1 : import --- */
  const nouveaux = [];
  const queue = [
    ...published.map((a) => ({ article: a, alreadyLive: true })),
    ...drafts.map((a) => ({ article: a, alreadyLive: false })),
  ];
  for (const { article, alreadyLive } of queue) {
    const { id } = article;
    try {
      if (!id) throw new Error("identifiant absent de la réponse API");
      if (state.articles[id]) { log(`· ${id} déjà importé — ignoré`); continue; }
      const wanted = wwSlug(article.data?.slug || article.data?.title);
      if (alreadyLive && others.has(wanted)) {
        warn(`${id} : ${BLOG_PREFIX}/${wanted} est déjà un article du site — non repris`);
        continue;
      }
      const record = await importArticle(article, taken);
      articles.push(record);
      taken.add(record.slug);
      const now = new Date().toISOString();
      state.articles[id] = {
        slug: record.slug,
        url: `${SITE_ORIGIN}${BLOG_PREFIX}/${record.slug}`,
        importedAt: now,
        // Déjà PUBLISHED chez WhatsWrong : rien à confirmer.
        confirmedAt: alreadyLive ? now : null,
      };
      nouveaux.push(id);
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      fail(`article ignoré (${id || "id inconnu"} — « ${article.data?.title ?? "sans titre"} ») : ${e.message}`);
    }
  }

  if (nouveaux.length) {
    articles.sort((x, y) => y.dateISO.localeCompare(x.dateISO));
    await writeJson(ARTICLES_FILE, articles);
    await writeJson(STATE_FILE, state);
    await cleanOrphanUploads(articles);
    await commitAndPush(`content: ${nouveaux.length} article(s) WhatsWrong publié(s)`);
  } else {
    log("aucun nouvel article à importer");
  }

  let stateChanged = false;
  const live = new Map(articles.map((a) => [a.slug, a]));

  /* --- Phase 2 : confirmation PUBLISHED (nouveaux + reliquats des runs précédents) --- */
  const aConfirmer = NO_PUSH ? [] : Object.entries(state.articles).filter(
    ([, v]) => !v.confirmedAt && !v.unpublishedAt && live.has(v.slug),
  );
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  for (const [id, entry] of aConfirmer) {
    try {
      log(`· vérification de la mise en ligne : ${entry.url}`);
      if (!(await waitOnline(entry.url, live.get(entry.slug).titre, deadline))) {
        fail(`page non accessible dans le délai imparti (${entry.url}) — PATCH non envoyé, reprise au prochain run`);
        continue;
      }
      await whatswrong("PATCH", `/api/v1/lea/blog-articles/${encodeURIComponent(id)}`, { state: "PUBLISHED", url: entry.url });
      entry.confirmedAt = new Date().toISOString();
      stateChanged = true;
      log("  ✓ confirmé PUBLISHED auprès de WhatsWrong");
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      fail(`PATCH en échec pour ${id} (${entry.url}) : ${e.message} — reprise au prochain run`);
    }
  }

  /* --- Phase 3 : article retiré du blog après publication → retour en DRAFT --- */
  for (const [id, entry] of Object.entries(state.articles)) {
    if (!entry.confirmedAt || entry.unpublishedAt || live.has(entry.slug)) continue;
    try {
      await whatswrong("PATCH", `/api/v1/lea/blog-articles/${encodeURIComponent(id)}`, { state: "DRAFT" });
      entry.unpublishedAt = new Date().toISOString();
      stateChanged = true;
      log(`  ↩ ${entry.slug} retiré du blog — repassé en DRAFT chez WhatsWrong`);
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      fail(`retour en DRAFT en échec pour ${id} (${entry.slug}) : ${e.message}`);
    }
  }

  if (stateChanged) {
    await writeJson(STATE_FILE, state);
    // [skip ci] : ce commit ne change aucun contenu affiché, inutile de redéployer.
    await commitAndPush("chore: état WhatsWrong mis à jour [skip ci]");
  }
  finish();
}

/** Supprime les dossiers d'images d'articles qui ne sont plus référencés. */
async function cleanOrphanUploads(articles) {
  if (!existsSync(UPLOAD_DIR)) return;
  const valides = new Set(articles.map((a) => a.slug));
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
  if (e instanceof RateLimited) {
    warn(`arrêt anticipé — ${e.message}`);
    return;
  }
  console.log(`::error::échec global de la synchronisation : ${e.stack ?? e.message}`);
  process.exit(1);
});
