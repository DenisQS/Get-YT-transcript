# Copier la transcription d'une vidéo YouTube

Cette extension ajoute un bouton sur les pages de vidéos YouTube. Un clic copie le titre, le lien et la transcription (avec les minutages) dans le presse-papiers.

Le texte n'est envoyé nulle part : il reste sur votre ordinateur.

## L'installer dans Chrome

1. Téléchargez ce projet (bouton vert **Code**, puis **Download ZIP**) et décompressez le fichier ZIP.
2. Ouvrez Chrome. Cliquez dans la barre d'adresse et entrez `chrome://extensions`, puis validez.
3. En haut à droite, activez **Mode développeur** (en anglais : **Developer mode**).
4. Cliquez sur **Charger l'extension non empaquetée** (en anglais : **Load unpacked**). Choisissez le dossier décompressé, celui qui contient le fichier `manifest.json`. Ne choisissez pas un fichier à l'intérieur du dossier.
5. Ouvrez une vidéo YouTube. Le bouton **Copy transcript** apparaît à côté de J'aime et Partager (Like et Share). Cliquez dessus, puis collez le texte où vous voulez (Ctrl+V, ou Cmd+V sur Mac).

Si un onglet YouTube était déjà ouvert, rechargez-le après l'installation.

Il faut une version récente de Chrome.

## Ce que le bouton peut afficher

- **Copied!** : c'est bon, le texte est copié.
- **No captions** : cette vidéo n'a pas de sous-titres.
- **Couldn't load** : YouTube n'a pas renvoyé la transcription. Rechargez la page et réessayez.
- **Clipboard blocked** : Chrome a refusé la copie. Cliquez à nouveau sur le bouton.

Le bouton revient tout seul à **Copy transcript** après deux secondes.
