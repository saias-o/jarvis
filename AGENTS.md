# JARVIS : repères pour les agents

## Objectif

Faire de JARVIS l’agent IA le plus capable du monde. Chaque fonctionnalité doit
donner de nouvelles capacités au LLM derrière JARVIS. Le code fournit les outils,
leurs permissions et leur exécution ; le LLM comprend la demande, choisit les
outils et organise les actions. Ne pas coder en dur des scénarios ou des réponses
qui remplacent son raisonnement.

Une capacité n’est utilisable que si le LLM la connaît : exposer son schéma,
décrire sur quel appareil elle agit, ses chemins et ses permissions, et renvoyer
des résultats exploitables. Avant d’ajouter une fonctionnalité, lire le code :
elle existe peut-être déjà mais n’est pas branchée dans la boucle de l’agent.
Un refus injustifié se corrige en vérifiant les outils et le contexte réellement
transmis au modèle. Vérifier l’action avant d’annoncer sa réussite.

## Un seul code, les mêmes capacités partout

- Tous les JARVIS (PC, téléphone Android, futurs supports) doivent avoir les
  mêmes capacités, quelle que soit la plateforme et quel que soit le modèle qui
  réfléchit. Une capacité ajoutée sur un support est ajoutée sur tous dans le
  même changement ; un écart restant est un défaut à corriger, pas un état normal.
- Un seul code commun, le plus possible : noms d’outils, schémas, descriptions,
  pagination, affichage, accès web et règles de sécurité vivent dans `shared/`
  (code sans dépendance Node ni navigateur) et sont importés par chaque support.
  Ne jamais recopier ni réécrire un outil pour une plateforme.
- Seul le code réellement propre à une plateforme reste à part, réduit à des
  primitives : accès disque et permissions, mémoire, écran, pile réseau, shell.
  Chaque support les fournit au catalogue commun ; une primitive absente retire
  l’outil correspondant au lieu de créer une variante.
- Catalogue des outils de l’agent : `shared/tools.mjs` (fichiers, mémoire,
  `show`, shell) et `shared/web-tools.mjs` (`web_search`, `web_fetch`) ; garde
  réseau commune dans `shared/public-web.mjs`. Primitives du PC :
  `bridge/local-tools.mjs` et `bridge/net.mjs` ; primitives du téléphone :
  `shared/android-agent.mjs`, `src/lib/device.ts` et `JarvisFilesPlugin.kt`.
  `test/device-tools.test.mjs` vérifie que téléphone et PC exposent exactement
  les mêmes définitions.

## Application Android et Capacitor

- Application Capacitor, identifiant `dev.jarvis.app`, origine
  `https://jarvis.app`. Interface React/Vite dans `src/`, projet natif dans
  `android/`, plugins Kotlin dans `android/app/src/main/java/dev/jarvis/app/`.
- `src/lib/device.ts` orchestre l’agent Android. `shared/android-agent.mjs`
  branche le téléphone sur le catalogue commun ; `shared/pc-agent.mjs` expose
  les outils du PC connecté. Les outils `pc_*` agissent sur le PC, les outils
  sans préfixe sur Android (fichiers, mémoire, écran, recherche web depuis le
  téléphone, même sans PC) ; `upload_to_pc` utilise le transfert natif existant.
  En mode complet, `pc_run_command` réutilise le shell du PC. Ne pas réduire
  silencieusement ses capacités lors d’un changement de transport ou de modèle.
  `show(image=chemin_PC)` ouvre le visualiseur d’images existant sur le téléphone.
- Le PC peut fournir l’inférence via `/inference` sans exécuter lui-même les
  appels proposés. La boucle Android les distribue au bon appareil ; les outils
  PC passent par `/pc-tools` et respectent les permissions du bridge.
- Après une modification web : `npm run build`, puis `npx cap sync android`
  avant de construire l’APK. Une modification locale ne met pas à jour l’APK
  déjà installée. Garder les sources natives dans Git, pas les assets copiés.

## GitHub Actions et installation

- Dépôt personnel : `saias-o/jarvis`, remote `origin`. Le workflow
  `.github/workflows/android.yml` construit et signe l’APK sur un push vers
  `main`, `master` ou `codex/**`, ou via `workflow_dispatch`.
- Quand une livraison Android est demandée, pousser les changements concernés,
  suivre le run jusqu’à son résultat, puis télécharger son artefact
  `jarvis-android-<numéro>`. Vérifier que le run correspond au commit livré.
  Commandes utiles : `gh run list`, `gh run view`, `gh run download` avec
  `--repo saias-o/jarvis`.
- Garder la même signature pour les mises à jour. Les secrets `ANDROID_*` sont
  configurés dans GitHub ; la sauvegarde privée est dans `.android-signing/`.
  Ne jamais publier les clés, les secrets ou `.env.local`.
- ADB est disponible dans `.tools/platform-tools/adb.exe` si absent du PATH.
  Vérifier `adb devices -l`, installer avec `adb install -r <apk>`, puis ouvrir
  avec `adb shell am start -W -n dev.jarvis.app/.MainActivity`.
  Ne pas désinstaller l’application ni effacer ses données pour une mise à jour.
- Vérifier sur le téléphone : ouverture, connexion PC, outils concernés et
  résultat réel. Ne pas confondre build réussi et fonctionnalité validée.
  Configuration distante et détails : `docs/android.md`.

## Vérifications et exploitation

- Vérifier avec les tests pertinents, `npm run lint`, `npm run build` et
  `npx cap sync android`. Les tests du bridge nécessitent les connexions locales.
- Lancement PC distant avec actions : `npm run remote:writes` ; Tailscale relie
  les appareils. `.env.local` contient la configuration locale. Identifier les
  processus JARVIS avant un redémarrage ; ne pas arrêter les autres processus Node.
- Respecter les dossiers partagés et les permissions existantes. Expliquer un
  blocage réel précisément ; ne pas déclarer une action impossible sans vérifier
  les capacités disponibles. Ne pas supposer l’outillage absent : inspecter
  notamment `.tools/`, le téléphone connecté et les builds GitHub existants.
