import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ALL_ARTICLES, photoSrc } from "../../lib-articles";
import { Reveal } from "../../components/reveal";
import { WordReveal } from "../../components/word-reveal";
import { CtaFinal } from "../../components/cta-final";

export function generateStaticParams() {
  return ALL_ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = ALL_ARTICLES.find((a) => a.slug === slug);
  if (!article) return {};
  return {
    title: `${article.titre} — ARCHI PILOTE RÉNOVATION`,
    description: article.excerpt,
    keywords: article.keyword ? [article.keyword] : undefined,
    alternates: { canonical: `/blog/${article.slug}` },
  };
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = ALL_ARTICLES.find((a) => a.slug === slug);
  if (!article) return notFound();

  const autres = ALL_ARTICLES.filter((a) => a.slug !== article.slug).slice(0, 2);

  const jsonLdBlogPosting = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: article.titre,
    description: article.excerpt,
    datePublished: article.dateISO,
    ...(article.keyword ? { keywords: article.keyword } : {}),
    dateModified: article.dateISO,
    image: photoSrc(article.photo),
    url: `https://www.archipiloterenovation.com/blog/${article.slug}`,
    author: { "@type": "Organization", name: "ARCHI PILOTE RÉNOVATION", "@id": "https://www.archipiloterenovation.com/#organization" },
    publisher: { "@id": "https://www.archipiloterenovation.com/#organization" },
  };

  /* FAQ fournie par WhatsWrong : déjà affichée en fin de corps, déclarée ici pour les moteurs. */
  const jsonLdFaq = article.faq?.length
    ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: article.faq.map((q) => ({
          "@type": "Question",
          name: q.question,
          acceptedAnswer: { "@type": "Answer", text: q.answer },
        })),
      }
    : null;

  return (
    <main className="relative z-10 bg-carbone">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdBlogPosting) }} />
      {jsonLdFaq && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdFaq) }} />
      )}
      <header className="relative pt-40 md:pt-48 pb-14 overflow-hidden">
        <div className="container-site relative flex flex-col items-center text-center gap-5">
          <Reveal variant="fade-blur">
            <Link href="/blog" className="eyebrow inline-flex items-center gap-2 hover:opacity-70 transition-opacity">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5m0 0 6 6m-6-6 6-6" /></svg>
              {article.categorie}
            </Link>
          </Reveal>
          <WordReveal as="h1" immediate delay={0.1} stagger={0.06} segments={[{ text: article.titre }]} className="display text-[clamp(2rem,5vw,3.6rem)] text-ivoire text-balance max-w-4xl" />
          <Reveal variant="slide-up" delay={0.3}><span className="font-mono text-[0.78rem] text-muted">{article.date}</span></Reveal>
        </div>
      </header>

      {/* 05/09 : un schéma pédagogique ne se recadre pas. Le cadre reste au même format
          (16/8) pour ne pas faire sauter la mise en page d'un article à l'autre, mais
          l'image y est posée ENTIÈRE (object-contain) sur le fond de la page. Recadrée en
          object-cover comme une photo, elle perdait un quart de sa hauteur — donc son
          titre. La mention explicite évite qu'un dessin passe pour une preuve de chantier. */}
      <Reveal variant="scale" className="container-site mb-14 md:mb-20">
        <div className={`relative aspect-[16/8] rounded-none overflow-hidden card-e${article.schema ? " bg-surface" : ""}`}>
          <img
            src={photoSrc(article.photo)}
            alt={article.titre}
            className={`absolute inset-0 size-full ${article.schema ? "object-contain" : "object-cover"}`}
          />
        </div>
        {article.schema && (
          <p className="mt-2 text-[0.78rem] text-muted">Schéma pédagogique — illustration de principe, non exécutoire.</p>
        )}
      </Reveal>

      <article className="container-site pb-20 md:pb-28">
        <div className="max-w-[42rem] mx-auto flex flex-col gap-6">
          {article.bodyHtml ? (
            /* Article importé depuis Sedestral ou WhatsWrong : corps HTML assaini à la synchronisation. */
            <Reveal variant="slide-up">
              <div className="prose-article" dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />
            </Reveal>
          ) : (
            article.corps.map((p, i) => (
              <Fragment key={i}>
                <Reveal variant="slide-up" delay={i * 0.05}>
                  <p className="text-ivoire/85 text-[1.05rem] leading-[1.75]">{p}</p>
                </Reveal>
                {i === 0 && article.img2 && (
                  <Reveal variant="scale" delay={0.15}>
                    <figure className="relative aspect-[16/10] rounded-none overflow-hidden card-e my-2">
                      <img src={photoSrc(article.img2)} alt={article.img2Caption ?? article.titre} className="absolute inset-0 size-full object-cover" loading="lazy" />
                      {article.img2Caption && (
                        <figcaption className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent text-white/90 text-[0.8rem] px-4 py-3">
                          {article.img2Caption}
                        </figcaption>
                      )}
                    </figure>
                  </Reveal>
                )}
                {i === 1 && article.img3 && (
                  <Reveal variant="scale" delay={0.15}>
                    <figure className="relative aspect-[16/10] rounded-none overflow-hidden card-e my-2">
                      <img src={photoSrc(article.img3)} alt={article.img3Caption ?? article.titre} className="absolute inset-0 size-full object-cover" loading="lazy" />
                      {article.img3Caption && (
                        <figcaption className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent text-white/90 text-[0.8rem] px-4 py-3">
                          {article.img3Caption}
                        </figcaption>
                      )}
                    </figure>
                  </Reveal>
                )}
              </Fragment>
            ))
          )}
          <Reveal variant="slide-up" delay={0.2} className="mt-4">
            <Link href="/estimateur-travaux" className="btn btn-primary w-fit">
              Estimer mon projet
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14m0 0-6-6m6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </Link>
          </Reveal>
        </div>
      </article>

      {autres.length > 0 && (
        <section className="relative pb-24 md:pb-36 border-t border-line pt-16">
          <div className="container-site flex flex-col gap-8">
            <span className="eyebrow text-center">À lire aussi</span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto w-full">
              {autres.map((a) => (
                <Link key={a.slug} href={`/blog/${a.slug}`} className="group card-e rounded-none overflow-hidden flex flex-col">
                  <div className="relative aspect-[16/9] overflow-hidden">
                    <img src={photoSrc(a.photo)} alt={a.titre} className="absolute inset-0 size-full object-cover transition-transform duration-700 group-hover:scale-105" />
                  </div>
                  <div className="p-5 flex flex-col gap-1.5">
                    <span className="font-mono text-[0.66rem] text-orange uppercase tracking-[0.1em]">{a.categorie}</span>
                    <h3 className="display text-[1.1rem] text-ivoire normal-case group-hover:text-orange transition-colors leading-tight">{a.titre}</h3>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <CtaFinal />
    </main>
  );
}
