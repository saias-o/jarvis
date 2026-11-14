# PLAN — JARVIS multi-appareils

Document de passation. Il décrit l'objectif, ce qui est déjà fait, les décisions
prises, et tout ce qui reste à faire, dans l'ordre. Il est écrit pour un agent
(Codex) qui reprend le travail sans le contexte des conversations précédentes.

Dernière mise à jour : 2026-11-14.

### Reprise en cours (Codex, 14 novembre 2026)

- Fork créé : `https://github.com/saias-o/jarvis` ; `origin` = fork,
  `upstream` = dépôt original. Accord explicite reçu pour commit et push sur
  `codex/android`, avec le travail antérieur nécessaire.
- A1 : Capacitor 8.6.2, projet `android/`, workflow de build et signature
  persistante ajoutés. Quatre secrets Android configurés dans le fork ; copie
  privée ignorée par Git dans `.android-signing/`.
- A1–A3 : APK signé compilé par Actions et installé sur Mi 9T Pro (Android 14,
  6 Go de RAM). Gemma téléchargé dans l'app ; deux réponses françaises réelles
  vérifiées sur téléphone. Boucle partagée et tests Ollama conservés.
- A4 : voix native raccordée ; micro autorisé. Premier essai : erreur Android 12
  (français non pris en charge par le moteur hors ligne). Correctif de repli
  automatique vers le moteur système dans `f170fa1`, compilé et installé
  (APK versionCode 6). L’utilisateur a confirmé : « ça marche le vocal ».
- A5 : fichiers et partage Android implémentés ; accès global au stockage et
  appels d'outils de fichiers encore à valider sur appareil.
- A6 : réglages du PC et du cerveau ; CORS, identité Tailscale obligatoire pour
  l'origine native et jeton de session HTTP/WebSocket. Tests de sécurité passent.
  Les médias inter-origines avec code activé restent à compléter ; le réglage
  choisi `JARVIS_REMOTE_CODE=off` fonctionne sans cookie inter-origine.
- A7 : icônes et documentation `docs/android.md` ajoutées ; service de premier
  plan optionnel non implémenté. B et restes de phase 1 toujours en attente.
- Vérification locale : 90 tests passent, 1 ignoré ; TypeScript et build Vite OK ;
  seulement les deux avertissements de lint préexistants. Pas de JDK/SDK installé.
- Tailscale PC rétabli en lançant son client Windows (le service seul restait
  en NoState). JARVIS démarré avec accès distant, sans code et limité au compte
  propriétaire. `/auth` réel avec origine APK : required=false, ok=true ; une
  question depuis l'APK a réellement été traitée par le PC. Mode automatique
  et adresse du PC enregistrés dans l'app.
- Le processus PC est désormais lancé avec `--remote --writes` et
  `JARVIS_ALLOW_WRITES=1`. L'utilisateur a explicitement autorisé le mode complet
  après le refus initial du contrôle automatique. Vérifié : journal « writes
  ENABLED », interface et cerveau HTTP 200, accès Tailscale sans code toujours actif.
- APK de test local : `artifacts/JARVIS-Android14.apk` (dossier ignoré par Git).
  VersionCode 7 installée, avec corrections du micro et du contexte, sans champ de code superflu.
- Régression réelle sur les téléchargements : résultat de fichiers trop long
  (4189 tokens pour une fenêtre de 4096). Correctif : listes Android paginées,
  lectures courtes, contexte borné et nouvelle tentative uniquement avant tout
  jeton émis. Sept tests de contexte ajoutés ; APK versionCode 7 compilé et installé.
  Le test réel du dossier Download (367 éléments) affiche les vrais fichiers
  sur Gemma sans nouveau débordement dans les journaux.
- Restent : valider les écritures/déplacements natifs et le service
  de premier plan optionnel ; phase B non commencée. Pas d'Ollama réel sur PC1.
- Correctif PC : Vite ignore désormais `artifacts/`, `android/` et les outils de
  session, pour éviter EBUSY sur l'APK pendant une installation USB. Les secrets
  de signature sont aussi refusés explicitement par le serveur de développement.


---

## 1. Objectif

Un JARVIS présent sur tous les appareils de l'utilisateur, et non plus un seul
PC qu'on atteint depuis un téléphone.

- Un **nœud JARVIS par appareil** : PC1 (cette machine), PC2 (l'autre PC), le
  téléphone Android.
- Les nœuds **se parlent** : « envoie ce fichier au JARVIS de PC2 et range-le
  dans tel dossier », et l'inverse ; déléguer une demande à l'agent d'un autre
  nœud.
- **Conserver** l'accès actuel téléphone → PC1 (port distant via Tailscale).
- Une **app Android native installée par APK** qui fait tourner **Gemma 4 E2B
  sur le téléphone**, avec reconnaissance vocale et accès aux fichiers Android.
- **Partout** : si Claude Code est indisponible, bascule sur un LLM local
  (`gemma4:e2b` par défaut, configurable vers plus puissant).
- On peut **donner un fichier** à JARVIS, qui le lit et en fait ce qu'on demande.

## 2. Décisions prises (ne pas les rouvrir sans raison)

| Sujet | Décision |
|---|---|
| App Android | **Capacitor** : on enveloppe l'interface web existante, plus des modules natifs Kotlin. Pas de réécriture en Compose. |
| Compilation de l'APK | **GitHub Actions**. PC1 n'a ni JDK ni SDK Android, 7,4 Go de RAM et ~20 Go de disque : ne rien compiler d'Android en local. |
| Ordre | **Android d'abord** (phase A), maillage PC ↔ PC ensuite (phase B). |
| Transport entre nœuds | **Tailscale** (déjà la base de confiance). Aucun nouveau port public. Identité = compte Tailscale. |
| LLM local sur PC | **Ollama**, API `/api/chat`. |
| LLM local sur Android | **LiteRT-LM** (Kotlin), fichier `.litertlm`. |
| Agent local | Une **boucle légère maison** avec peu d'outils, pas Claude Code pointé sur Ollama (trop de schémas d'outils pour un modèle de 2 milliards de paramètres). |
| Préférences utilisateur | Écritures activées, pas de code d'accès (`JARVIS_REMOTE_CODE=off`), pas d'animation de démarrage, réponses en français. Choisir l'option « capable ». |

## 3. État actuel

### Fait et vérifié (non commité)

- **Repli sur LLM local** : `bridge/router.mjs` (quand basculer), `bridge/local.mjs`
  (client Ollama + boucle d'agent), `bridge/local-tools.mjs` (outils + prompt
  court), intégration dans `bridge/server.mjs` (`route`, `runLocal`,
  `startClaude`, `sessionEnded`). Variables : `JARVIS_BRAIN` (`auto|claude|local`),
  `JARVIS_LOCAL_MODEL`, `JARVIS_LOCAL_URL`, `JARVIS_LOCAL_CTX`,
  `JARVIS_LOCAL_KEEP_ALIVE`, `JARVIS_LOCAL_SHELL`.
- **Dépôt de fichiers** : `POST /upload?name=` → `bridge/inbox.mjs` → stockage dans
  `<workspace>/inbox/<date>/`. Le client envoie `{type:'ask', text, id, files:[chemins]}` ;
  le bridge vérifie les chemins et préfixe la question par `[Dropped file: <chemin> | <taille>]`.
  Interface : `src/lib/upload.ts`, `src/ui/Drop.tsx`, trombone dans `src/ui/Ask.tsx`.
- **Indicateur de cerveau** : trame `{type:'brain', brain, model, reason}` → badge
  dans `src/ui/Hud.tsx`.
- **Correction de l'interruption** : la question suivante attend le `result` du
  tour interrompu (`stopClaudeTurn` dans `server.mjs`) ; session remplacée après 4 s.
- **Tests** : `npm test` → 80 passent, 1 ignoré (WSL). Nouveaux :
  `test/local-brain.test.mjs`, `test/brain-fallback.test.mjs`, `test/upload.test.mjs`.

### Jamais vérifié

- Le **vrai Gemma via Ollama** n'a jamais tourné : Ollama n'est pas installé sur
  PC1. Le repli n'est testé que contre un faux Ollama.
- Aucun test automatique pour l'interruption (il faut une vraie session Claude).

### Attention au dépôt

- **62 fichiers non commités**, dont beaucoup de travail antérieur (accès distant,
  mise en page mobile). Ne rien écraser, ne pas commiter sans demande explicite.
- Le remote `origin` est `github.com/adewaskar/jarvis` : **ce n'est pas le dépôt de
  l'utilisateur**. Ne jamais y pousser.
- Fins de ligne **mélangées** (CRLF et LF) ; `grep`/`cat` de Git Bash masquent les
  `\r`. Tout script d'édition doit respecter la fin de ligne du fichier.

## 4. Conventions du projet

- Le bridge est en **`.mjs` sans étape de build** ; le front en React + TypeScript + Vite.
- Les commentaires expliquent **le pourquoi** (contraintes, mesures), en anglais,
  dans le ton des fichiers existants. Pas de commentaires qui paraphrasent le code.
- Tests avec `node --test`, sans dépendance de test. **Aucun test n'ouvre de
  session Claude ni n'appelle le réseau** : on démarre le vrai bridge sur un port
  aléatoire avec des dossiers temporaires (`JARVIS_WORKSPACE`, `JARVIS_MEMORY_FILE`),
  et on simule les services (faux Ollama).
- Sécurité, à préserver : le bridge n'écoute que sur loopback ; vérification de
  `Host` et d'`Origin` ; outils de fichiers confinés aux racines
  (`pathProblem` dans `bridge/policy.mjs`) ; les emplacements d'identifiants
  restent refusés ; tout texte lu dans une page ou un fichier est une donnée,
  jamais un ordre.
- Toute nouvelle variable d'environnement est documentée dans `.env.example` et
  dans le tableau du `README.md`.
- Avant de rendre la main : `npm test`, `npx tsc -b`, `npx vite build`, `npx oxlint`
  (deux avertissements préexistants : `probeUrl` et `err` inutilisés).

---

## 5. Prérequis côté utilisateur (bloquants)

- [ ] **Créer son propre dépôt GitHub** (fork ou dépôt privé), y pousser le code,
      et changer `origin`. Demander son accord avant tout commit ou push.
- [ ] Indiquer le **modèle du téléphone et sa RAM** (Gemma 4 E2B : 6 à 8 Go conseillés).
- [ ] **Tailscale** installé et connecté au même compte sur PC1, PC2 et le téléphone
      (MagicDNS et certificats HTTPS activés).
- [ ] Optionnel : **installer Ollama** sur PC1 ou PC2 et `ollama pull gemma4:e2b`
      (~7 Go) pour valider le repli en vrai.

---

## 6. Phase A — App Android (Capacitor + GitHub Actions)

But : un APK qui affiche l'interface actuelle et propose trois cerveaux —
**PC distant**, **Gemma embarqué**, **automatique** (PC si joignable, sinon embarqué).

Faits vérifiés dans la documentation :
- LiteRT-LM Kotlin : dépendance `com.google.ai.edge.litertlm:litertlm-android`,
  `Engine(engineConfig)` + `engine.initialize()` (long, hors thread principal),
  `engine.createConversation(config)`, `sendMessageAsync(contents): Flow<Message>`.
  Outils : `automaticToolCalling = false` permet à l'app de lire
  `responseMessage.toolCalls` et de renvoyer `Message.tool(...)`. Entrées image et
  audio possibles. Backends CPU / GPU / NPU ; le GPU exige `libvndksupport.so` et
  `libOpenCL.so` en `<uses-native-library>` dans le manifeste.
- Modèle : `litert-community/gemma-4-E2B-it-litert-lm` sur Hugging Face (~2,6 Go).
- **L'API vocale du navigateur n'existe pas dans WebView** (ni reconnaissance ni
  synthèse) : il faut des modules natifs.
- À revérifier à l'implémentation : noms exacts des classes de configuration et
  d'outils (voir le code de Google AI Edge Gallery), licence/accès du modèle,
  version stable de Capacitor.

### A1. Pipeline de build (à faire en premier)

- [ ] Ajouter Capacitor (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`),
      `capacitor.config.ts` (appId du type `dev.jarvis.app`, `webDir: 'dist'`).
- [ ] `npx cap add android` et **commiter le dossier `android/`**.
- [ ] Workflow `.github/workflows/android.yml` : Node 20+, JDK, SDK Android,
      `npm ci`, build Vite, `npx cap sync android`, Gradle, APK en artefact
      (et en Release sur tag).
- [ ] **Signature stable** : une keystore générée une fois, stockée en secrets
      GitHub. Sans elle, chaque APK a une signature différente et ne s'installe
      pas par-dessus le précédent.
- [ ] Critère de fin : l'APK s'installe et affiche l'interface (sans cerveau).

### A2. Module natif Gemma (`JarvisLlm`)

- [ ] Plugin Capacitor Kotlin : `load({ modelPath, backend })`, `generate(...)` avec
      **jetons diffusés par événements**, `cancel()`, `unload()`, `status()`.
- [ ] Appel d'outils **manuel** : le plugin remonte les appels d'outils au
      JavaScript et reçoit les résultats ; il n'exécute rien lui-même.
- [ ] **Téléchargement du modèle** dans l'app : reprise sur coupure, Wi-Fi
      uniquement par défaut, progression affichée, stockage dans le dossier de
      fichiers de l'app. Prévoir aussi l'import d'un fichier déjà présent.
- [ ] Repli GPU → CPU si l'initialisation GPU échoue. Décharger le modèle quand
      l'app passe en arrière-plan longtemps.
- [ ] Critère de fin : une phrase générée sur le téléphone, affichée jeton par jeton.

### A3. Boucle d'agent partagée

- [ ] Extraire la boucle de `bridge/local.mjs` (`turn` : messages, appels d'outils,
      dernière étape sans outils, coupure par `AbortSignal`) dans un module ESM
      **sans API Node**, par exemple `shared/agent-loop.mjs`, paramétré par un
      adaptateur `chat(messages, tools, signal)`.
- [ ] Deux adaptateurs : Ollama (bridge, existant) et LiteRT-LM (app, via le plugin).
- [ ] `test/local-brain.test.mjs` doit continuer de passer sans modification de fond.
- [ ] Côté front : `src/lib/device.ts` (cerveau embarqué) avec la même forme
      `ask(prompt, handlers, files)` que `src/lib/bridge.ts`, et le choix du
      cerveau dans `src/lib/brain.ts` (aujourd'hui `bridge | direct`).

### A4. Module natif voix (`JarvisSpeech`)

- [ ] Reconnaissance : `SpeechRecognizer` d'Android (préférer la reconnaissance
      sur l'appareil quand elle existe), résultats partiels et finaux, langue
      issue de `VITE_VOICE_LANG`.
- [ ] Synthèse : `TextToSpeech` d'Android, file de phrases, arrêt immédiat pour
      l'interruption.
- [ ] Brancher ces moteurs dans `src/lib/voice.ts` et `src/lib/tts.ts`, qui
      choisissent déjà entre plusieurs moteurs (`src/lib/capabilities.ts`).
      Quand un PC est joignable et a une clé ElevenLabs, `/stt` et `/tts` du
      bridge restent utilisables.
- [ ] Permissions `RECORD_AUDIO` ; pas de mot de réveil sur téléphone, le bouton
      `Talk` existant suffit.

### A5. Module natif fichiers (`JarvisFiles`)

- [ ] Permission **`MANAGE_EXTERNAL_STORAGE`** (accès à tout le stockage partagé),
      avec l'écran système pour l'accorder. Acceptable parce que l'APK est
      installé à la main, pas via le Play Store.
- [ ] Opérations : lister, lire (texte, par tranches), écrire, déplacer, ouvrir
      avec l'app par défaut. Refuser `Android/data` et `Android/obb`.
- [ ] Outils du cerveau embarqué : mêmes noms et mêmes schémas que
      `bridge/local-tools.mjs` (`list_files`, `read_file`, `write_file`,
      `move_file`, `open`, `remember`, `forget`, `show`).
- [ ] **Recevoir un partage Android** (« Partager vers JARVIS ») : le fichier
      devient une pièce jointe, comme un dépôt sur ordinateur.
- [ ] Mémoire long terme locale au téléphone (même format que
      `~/.jarvis/memory.md`) ; la synchronisation viendra avec le maillage.

### A6. Mode « cerveau du PC » depuis l'app

Aujourd'hui le port distant du bridge n'accepte que **sa propre origine**
(`bridge/remote.mjs`, `originAllowed`), et l'interface y est servie par le
bridge. Dans l'app, la page vient de l'APK (origine du type `https://localhost`)
et doit joindre `https://<pc>.<tailnet>.ts.net` en inter-origine.

- [ ] Donner à l'app une **origine distinctive** (`server.hostname` de Capacitor),
      pas `localhost`, et ajouter au bridge une liste d'origines d'app autorisées
      (par exemple `JARVIS_REMOTE_ORIGINS`), avec les en-têtes CORS correspondants
      sur le port distant et l'acceptation de cette origine pour le WebSocket.
      L'identité Tailscale (`userAllowed`) reste exigée.
- [ ] Avec le code d'accès activé, le cookie `SameSite=Strict` ne passera pas en
      inter-origine : prévoir un jeton en en-tête. (L'utilisateur a le code
      désactivé ; ne pas casser le cas avec code.)
- [ ] Écran de réglages dans l'app : adresse du ou des PC, choix du cerveau.
      `src/config.ts` déduit aujourd'hui l'adresse du bridge de l'origine de la
      page (`sameOriginBridge`) : la rendre configurable à l'exécution.
- [ ] Adapter la CSP de `index.html` (elle ne nomme que `localhost:8787`).
- [ ] Tests dans `test/remote.test.mjs` : origine d'app acceptée, autre origine
      refusée, toujours refusé sans identité Tailscale.

### A7. Finitions Android

- [ ] Mode automatique : PC joignable → cerveau du PC ; sinon Gemma embarqué ;
      badge de cerveau déjà en place (`BrainInfo`).
- [ ] Service de premier plan pour garder le modèle et la connexion en vie
      quand l'écran est éteint (optionnel au début).
- [ ] Icônes et écran de lancement (les icônes PWA sont dans `public/`).
- [ ] Section « Android » dans le `README.md`.

---

## 7. Phase B — Maillage entre nœuds

But : les nœuds se découvrent, s'envoient des fichiers et se délèguent des demandes.

### B1. Identité et découverte

- [ ] `~/.jarvis/node.json` : identifiant stable et nom (`JARVIS_NODE_NAME`,
      sinon le nom de machine). Noms prononçables : « PC1 », « PC2 », « téléphone ».
- [ ] Découverte : `tailscale status --json` (déjà utilisé dans `scripts/remote.mjs`),
      puis sonde de `GET /peer/hello` sur chaque pair en ligne ; cache court ;
      liste manuelle possible (`JARVIS_PEERS`).

### B2. API entre pairs (sur le port distant existant)

- [ ] `GET /peer/hello` → nom, plateforme, cerveau actif, écritures activées,
      dossiers connus (bureau, documents, téléchargements, racines partagées).
- [ ] `POST /peer/ask` → exécute un tour **sans interface** sur l'agent du nœud
      et renvoie la réponse. Compteur de sauts pour empêcher les boucles A → B → A.
- [ ] `PUT /peer/file?name=&dest=` → corps en flux, reçu dans la boîte de dépôt
      puis déplacé vers `dest` ; somme de contrôle ; taille plafonnée.
      `dest` : chemin absolu, chemin `~`, ou alias (`documents:`, `desktop:`…),
      validé par **les règles du nœud receveur**.
- [ ] `GET /peer/file?path=` → récupérer un fichier d'un pair (mêmes règles).
- [ ] Authentification : compte Tailscale du propriétaire obligatoire
      (`Tailscale-User-Login`, déjà vérifié par `userAllowed`). Refuser d'activer
      le maillage si `JARVIS_REMOTE_USERS` est vide. Étiqueter l'expéditeur à
      partir de `X-Forwarded-For` et de la table des pairs, pas d'un nom déclaré.

### B3. Outils de l'agent

- [ ] Serveur MCP en processus `jarvis_mesh` : `nodes`, `send_file(node, path, dest)`,
      `ask_node(node, request)`, `fetch_file(node, path, dest)`.
- [ ] Mêmes outils pour le cerveau local (`bridge/local-tools.mjs`).
- [ ] `send_file`, `ask_node` et `fetch_file` comptent comme des actions : ils
      attendent `JARVIS_ALLOW_WRITES` (voir `decideTool` dans `bridge/policy.mjs`).
- [ ] Section de prompt décrivant les nœuds, ajoutée seulement s'il y en a.

### B4. Nœuds hors ligne et téléphone

- [ ] Boîte d'envoi persistante par destinataire, avec nouvelles tentatives.
- [ ] Le téléphone ne peut pas écouter en arrière-plan : il **se connecte** aux PC,
      qui lui gardent une **boîte aux lettres** livrée à l'ouverture de l'app.
- [ ] Tours sans interface : si une interface est connectée sur le nœud, y
      afficher les panneaux ; sinon l'outil d'affichage répond qu'il n'y a pas d'écran.

### B5. Autour

- [ ] Liste des nœuds et de leur état dans l'interface.
- [ ] Repli vers le LLM d'un autre nœud (`JARVIS_LOCAL_URL` accepte déjà
      plusieurs adresses ; à relier à la découverte).
- [ ] Synchronisation de la mémoire long terme entre nœuds (union des faits,
      suppression propagée).
- [ ] Tests : deux bridges sur loopback avec des en-têtes Tailscale simulés,
      comme `test/remote.test.mjs`.

---

## 8. Restes de la phase 1

- [ ] Valider le repli avec un **vrai Ollama** et `gemma4:e2b` : latence, qualité
      des appels d'outils, français.
- [ ] Lecture de PDF par le cerveau local (`read_file` refuse les binaires).
- [ ] Nettoyage automatique ou manuel de la boîte de dépôt (elle ne se vide jamais).
- [ ] Les fichiers en attente recouvrent la ligne de suggestions au-dessus du
      champ de saisie (ordinateur).
- [ ] Test automatique de l'interruption, via un faux exécutable Claude
      (`JARVIS_CLAUDE_EXECUTABLE`) qui parle le protocole du CLI.
- [ ] Option « agent complet en local » pour les gros modèles : Claude Code
      pointé sur Ollama (`ANTHROPIC_BASE_URL=http://127.0.0.1:11434`,
      `ANTHROPIC_AUTH_TOKEN=ollama`).
- [ ] Deux avertissements de lint préexistants (`probeUrl`, `err`).

## 9. Questions ouvertes pour l'utilisateur

1. Modèle et RAM du téléphone ?
2. PC2 a-t-il une vraie carte graphique (donc un modèle local plus gros) ?
3. Faut-il une clé de maillage en plus de l'identité Tailscale ?
4. La mémoire long terme doit-elle être commune à tous les nœuds ?

## 10. Références

- LiteRT-LM Android : https://developers.google.com/edge/litert-lm/android
- Gemma 4 E2B LiteRT-LM : https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm
- Ollama, appel d'outils : https://docs.ollama.com/capabilities/tool-calling
- Ollama, compatibilité API Anthropic : https://docs.ollama.com/api/anthropic-compatibility.md
