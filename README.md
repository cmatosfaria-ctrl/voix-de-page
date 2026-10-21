# Voix de page

Lecteur à voix haute pour tablette : photographiez une page de livre ou une feuille, l'app reconnaît le texte et le lit en surlignant chaque mot. Français, allemand, anglais, espagnol, italien et portugais.

Tout fonctionne sur l'appareil, sans envoyer de données :

- **Reconnaissance du texte** : [Tesseract.js](https://github.com/naptha/tesseract.js) (WebAssembly) avec les modèles de langue dans `lang/`.
- **Voix** : synthèse vocale de l'appareil (Web Speech API). Par défaut, seules les voix hors ligne sont proposées.
- **Hors ligne** : un service worker (`sw.js`) met tous les fichiers en cache à la première visite. L'app peut s'installer sur l'écran d'accueil.

## Publier

GitHub Pages : Settings → Pages → Deploy from a branch → `main` / `(root)`.

## Mettre à jour

Après toute modification d'un fichier, augmentez `VERSION` dans `sw.js`, sinon les appareils garderont l'ancienne version en cache.

## Licences

Tesseract.js, tesseract.js-core et les modèles de langue sont sous licence Apache 2.0 (voir `vendor/`).
