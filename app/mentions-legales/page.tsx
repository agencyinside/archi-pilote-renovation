import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "../components/page-header";
import { SITE } from "../data";

export const metadata: Metadata = {
  alternates: { canonical: "/mentions-legales" },
  title: "Mentions légales — ARCHI PILOTE RÉNOVATION",
  description: "Éditeur du site, hébergement, propriété intellectuelle et données personnelles.",
};

export default function MentionsLegalesPage() {
  return (
    <main className="relative z-10 bg-carbone">
      <PageHeader
        eyebrow="Mentions légales"
        segments={[{ text: "Qui édite" }, { text: "ce site.", serif: true, gradient: true }]}
      />
      <section className="relative pb-24 md:pb-36">
        <div className="container-site max-w-[42rem] mx-auto flex flex-col gap-10 text-ivoire/85 text-[0.98rem] leading-relaxed">
          {/* MANQUE ENCORE, à réclamer au client — volontairement NON inventé ici :
              · le capital social d'IA RENOV (mention obligatoire pour une société commerciale,
                art. R123-237 du code de commerce) ;
              · le NOM du président, pour nommer le directeur de la publication au lieu de le
                désigner par sa fonction (art. 6-III de la LCEN).
              Ces deux informations n'existent nulle part dans le dépôt : les ajouter dès
              réception, sur les deux lignes correspondantes ci-dessous. */}
          <div className="flex flex-col gap-2">
            <h2 className="display text-xl text-ivoire normal-case">Éditeur du site</h2>
            <p>{SITE.structure}</p>
            {/* Numéro de TVA intracommunautaire CALCULÉ par la formule légale française
                appliquée au SIREN 889 976 387 : clé = (12 + 3 × (SIREN mod 97)) mod 97,
                soit ici (12 + 3 × 29) mod 97 = 02 → FR02 889976387.
                ⚠ À FAIRE CONFIRMER par l'expert-comptable d'IA RENOV avant de le tenir pour
                définitif : la formule donne le numéro qui SERAIT attribué, elle ne prouve pas
                qu'il soit actif. Si la société relève de la franchise en base de TVA
                (art. 293 B du CGI), aucun numéro intracommunautaire ne s'applique et cette
                ligne doit être retirée plutôt que corrigée. */}
            <p>N° de TVA intracommunautaire : FR02 889976387.</p>
            <p>Directeur de la publication : le Président d&apos;IA RENOV (SASU).</p>
            <p>Contact : <a href={`mailto:${SITE.email}`} className="text-orange hover:underline">{SITE.email}</a> — {SITE.telAffiche}</p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="display text-xl text-ivoire normal-case">Ce que la marque est, et n&apos;est pas</h2>
            <p>
              ARCHI PILOTE RÉNOVATION est une marque de pilotage de projets de rénovation, exploitée par IA RENOV (SASU).
              ARCHI PILOTE RÉNOVATION n&apos;est pas une entreprise de travaux, n&apos;exécute aucun lot et ne facture aucun
              travaux. Les travaux présentés sur ce site sont réalisés et facturés par des entreprises partenaires
              indépendantes, qui contractent directement avec le client et portent chacune leurs propres assurances
              de responsabilité civile professionnelle et de garantie décennale.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="display text-xl text-ivoire normal-case">Hébergement</h2>
            <p>
              Ce site est hébergé par o2switch SAS, 222-224 boulevard Gustave Flaubert,
              63000 Clermont-Ferrand, France -{" "}
              <a href="https://www.o2switch.fr" target="_blank" rel="noreferrer" className="text-orange hover:underline">o2switch.fr</a>.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="display text-xl text-ivoire normal-case">Propriété intellectuelle</h2>
            <p>
              L&apos;ensemble des éléments de ce site (textes, structure, charte graphique) est protégé au titre du
              droit d&apos;auteur. Les photographies présentées comme chantiers réels et légendées « chantier réel des
              équipes partenaires » proviennent de projets effectivement pilotés par les équipes partenaires du
              groupe. Les autres visuels (schémas explicatifs, références de style, photographies de niveau de
              finition) sont des illustrations et sont signalés comme tels sur les pages concernées.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="display text-xl text-ivoire normal-case">Données personnelles et cookies</h2>
            <p>
              Les informations transmises via le formulaire de contact de ce site sont utilisées
              uniquement pour traiter votre demande de projet. Ce site ne dépose aucun cookie de mesure d&apos;audience
              ni de publicité. Conformément au RGPD, vous disposez d&apos;un droit d&apos;accès, de rectification,
              d&apos;effacement, de limitation et d&apos;opposition sur vos données, ainsi que d&apos;un droit de réclamation
              auprès de la CNIL. Le détail des données collectées, des durées de conservation et des modalités
              d&apos;exercice de ces droits figure dans la{" "}
              <Link href="/politique-confidentialite" className="text-orange hover:underline">politique de confidentialité</Link>.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
