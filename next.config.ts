import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hébergement o2switch (Passenger) : serveur autonome, construit par GitHub Actions.
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  /* Migration vers l'arborescence du DOSSIER UNIQUE FINAL V3 (26/08/2026) —
     anciennes URLs redirigées en 301 pour ne perdre aucun lien existant. */
  async redirects() {
    /* 03/09 : le domaine accentué répondait 200 en parallèle du domaine ASCII, sans jamais
       rediriger vers lui — deux versions vivantes du même site, donc du contenu dupliqué et
       une autorité coupée en deux. Les quatre variantes accentuées (.com/.fr, avec et sans
       www, servies en punycode xn--archipiloternovation-m2b) sont désormais redirigées en
       301 vers https://www.archipiloterenovation.com, qui est déjà le canonique déclaré. */
    const DOMAINES_ACCENTUES = [
      "xn--archipiloternovation-m2b.com",
      "www.xn--archipiloternovation-m2b.com",
      "xn--archipiloternovation-m2b.fr",
      "www.xn--archipiloternovation-m2b.fr",
      "archipiloterenovation.com",
    ];

    return [
      ...DOMAINES_ACCENTUES.map((host) => ({
        source: "/:path*",
        has: [{ type: "host" as const, value: host }],
        destination: `https://www.archipiloterenovation.com/:path*`,
        permanent: true,
      })),
      { source: "/notre-modele", destination: "/modele-economique-transparence", permanent: true },
      { source: "/renovation-complete-maison", destination: "/renovation-complete", permanent: true },
      { source: "/structure-fondations-maison", destination: "/gros-oeuvre-structure", permanent: true },
      { source: "/extension-maison-ile-de-france", destination: "/extension-maison", permanent: true },
      { source: "/surelevation-maison-ile-de-france", destination: "/surelevation", permanent: true },
      { source: "/renovation-energetique-maison", destination: "/renovation-energetique", permanent: true },
      { source: "/qui-sommes-nous", destination: "/parcours-expertise", permanent: true },
      { source: "/devis", destination: "/estimateur-travaux", permanent: true },
      { source: "/glossaire-renovation-maison", destination: "/glossaire-renovation", permanent: true },
      { source: "/menuiserie-sur-mesure", destination: "/menuiserie-agencement-sur-mesure", permanent: true },
      { source: "/nos-partenaires-experts", destination: "/reseau-partenaires", permanent: true },
      { source: "/bareme-prix-renovation", destination: "/observatoire-prix-renovation", permanent: true },
      { source: "/avant-apres-renovation-maison", destination: "/realisations", permanent: true },
      { source: "/expertises-et-cas-par-specialite", destination: "/realisations", permanent: true },
    ];
  },
};

export default nextConfig;
