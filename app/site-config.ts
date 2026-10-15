/* ============================================================
   Interrupteur de visibilité de la maquette.

   SITE_OFFLINE = true  -> tout le site est remplacé par l'écran
                           « site non disponible », quelle que soit
                           la date (override manuel, prioritaire).
   SITE_OFFLINE = false -> le site suit la règle EXPIRES_AT ci-dessous.

   EXPIRES_AT -> date/heure UTC au-delà de laquelle le site bascule
                 automatiquement sur l'écran hors-ligne, sans
                 redéploiement nécessaire (vérifié à chaque requête,
                 layout en rendu dynamique). Pour prolonger l'accès :
                 avancer cette date puis redéployer.

   Pour basculer manuellement : changer SITE_OFFLINE puis
   pousser sur main (build GitHub Actions, déploiement o2switch automatique)
   ============================================================ */

export const SITE_OFFLINE = false;

export const EXPIRES_AT = "2099-01-01T00:00:00Z"; // péremption désactivée sur demande — 23/08/2026
