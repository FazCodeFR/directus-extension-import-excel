export const backendMessages = {
  // IA translation for English
  'en-US': {
    missingFile: 'Missing Excel file.',
    missingCollection: 'Missing target collection.',
    missingMapping: 'Missing mapping.',
    emptyFile: 'Empty Excel file.',
    noValidItems: 'No valid items to import. Check your mapping.',
    missingKeyForUpsert: 'An item is missing the required key field "{keyField}" for upsert.',
    internalError: 'Internal error during Excel import: {error}',
    processedItemsPrefix: 'items processed:',
    created: 'created',
    updated: 'updated',
    failed: 'errors',
    none: 'no changes'
  },
  // Original French translations
  'fr-FR': {
    missingFile: 'Fichier Excel manquant.',
    missingCollection: 'Collection cible manquante.',
    missingMapping: 'Mapping manquant.',
    emptyFile: 'Fichier Excel vide.',
    noValidItems: 'Aucun élément valide à importer. Vérifiez le mapping.',
    missingKeyForUpsert: 'Un élément ne contient pas la clé "{keyField}" requise pour l’upsert.',
    internalError: 'Erreur interne lors de l’import Excel : {error}',
    processedItemsPrefix: 'éléments traités :',
    created: 'créés',
    updated: 'mis à jour',
    failed: 'erreurs',
    none: 'aucun changement'
  },
  // // IA translation for Turkish
  'tr-TR': {
    missingFile: 'Excel dosyası eksik.',
    missingCollection: 'Hedef koleksiyon eksik.',
    missingMapping: 'Eşleştirme eksik.',
    emptyFile: 'Excel dosyası boş.',
    noValidItems: 'İçe aktarılacak geçerli öğe yok. Eşleştirmeyi kontrol edin.',
    missingKeyForUpsert: 'Bir öğede upsert için gereken "{keyField}" anahtar alanı eksik.',
    internalError: 'Excel içe aktarımı sırasında dahili hata: {error}',
    processedItemsPrefix: 'işlenen öğeler:',
    created: 'oluşturuldu',
    updated: 'güncellendi',
    failed: 'hatalar',
    none: 'değişiklik yok'
  }
};
