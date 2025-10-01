<template>
  <private-view :title="t('title')" class="import-excel-ui">
    <div class="step">
      <h2>{{ t('chooseCollection') }}</h2>
      <VSelect
        v-model="selectedCollection"
        :items="collections"
        item-text="label"
        item-value="value"
        :label="t('selectCollectionPlaceholder')"
        @update:modelValue="fetchFields"
      />
    </div>

    <div class="step">
      <h2>{{ t('uploadExcelFile') }}</h2>
      <VInput
        type="file"
        @change="handleFileUpload"
        accept=".xlsx, .xls"
        :label="t('fileLabel')"
        :placeholder="t('filePlaceholder')"
      />
      <p class="info-text">{{ t('acceptedFormats') }}</p>
    </div>

    <div v-if="previewData.length" class="step">
      <h2>{{ t('columnMapping') }}</h2>
      <p class="info-text">{{ t('columnMappingHelp') }}</p>

      <div class="mapping-table">
        <div class="mapping-row header">
          <div class="column">{{ t('sourceColumn') }}</div>
          <div class="column">{{ t('exampleData') }}</div>
          <div class="column">{{ t('targetField') }}</div>
        </div>

        <div v-for="(col, index) in previewData[0]" :key="'mapping-row-' + index" class="mapping-row">
          <div class="column"> {{ t('Column') }} {{ index + 1 }}</div>

          <div class="column example-data">
            <div v-for="row in previewData.slice(0, 3)" :key="'example-' + index + '-' + row[index]">
              {{ row[index] }}
            </div>
          </div>

          <div class="column">
            <VSelect
              v-model="mapping[index]"
              :items="getAvailableFields(index)"
              item-text="label"
              item-value="value"
              clearable
              :placeholder="t('selectFieldPlaceholder')"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 📝 Règles de concordance -->
    <div class="step">
      <h2>Règles d'import</h2>
      <ul class="info-text">
        <li>
          <strong>Concordance stricte → Aucun import (Ignoré)</strong>
          <ul>
            <li>Le <strong>Nom Prénom est identique</strong> ET</li>
            <li><strong>Au moins une adresse</strong> (adresse 1 ou 2) correspond ET</li>
            <li>Le <strong>Code postal est identique</strong></li>
            <li>→ <em>Doublon détecté, pas d'import</em></li>
          </ul>
        </li>
        <li>
          <strong>Concordance partielle → Import avec statut "À vérifier"</strong>
          <ul>
            <li>Le <strong>Nom Prénom est identique</strong> ET</li>
            <li>Les conditions de concordance stricte ne sont <strong>PAS toutes remplies</strong>
              <ul>
                <li>Soit l'adresse ne correspond pas (différente ou manquante)</li>
                <li>Soit le code postal ne correspond pas (différent ou manquant)</li>
                <li>Soit les deux</li>
              </ul>
            </li>
            <li>→ <em>Doublon potentiel, import avec statut "À vérifier"</em></li>
          </ul>
        </li>
        <li>
          <strong>Aucune concordance → Import avec statut "Fiche créée"</strong>
          <ul>
            <li>Le <strong>Nom Prénom est différent</strong> (peu importe les autres champs)</li>
            <li>→ <em>Nouvelle personne détectée, import avec statut "Fiche créée"</em></li>
          </ul>
        </li>
      </ul>
    </div>

    <div class="step">
      <h2>{{ 'Règles de fichier : ' }}</h2>
      <ul class="info-text">
        <li> Pas de ligne d'en-tête (header) dans le fichier Excel. </li>
        <li> Format .xlsx uniquement. </li>
        <li> Bien corriger le fichier avant import, en vérifiant les données et les formats. </li>
      </ul>
    </div>
    <br><br>

    <div v-if="selectedFile" class="step">
      <h2>{{ t('importTitle') }}</h2>
      <VButton
        @click="importFile"
        :disabled="!selectedCollection || isLoading"
        :loading="isLoading"
        color="primary"
        :xLarge="true"
      >
        {{ t('importButton') }}
      </VButton>
    </div>

    <!-- 🎯 Message principal avec gestion des types -->
    <div
      v-if="successMessage || errorMessage"
      :class="['alert', alertType]"
    >
      <pre v-if="errorMessage" style="white-space: pre-wrap; font-family: inherit; margin: 0;">{{ errorMessage }}</pre>
      <span v-else>{{ successMessage }}</span>
    </div>

    <!-- ℹ️ Détail en bas : erreurs ligne par ligne -->
    <div v-if="failedRows.length > 0" class="alert info">
      <strong>{{ t('errorsDetected') }}</strong>
      <VButton
        @click="copyErrors"
        :xSmall="true"
        :secondary="true"
        style="margin-left: 10px;"
      >
        {{ t('copyErrors') }}
      </VButton>
      <ul>
        <li v-for="row in failedRows" :key="row.row">
          Ligne {{ row.row }}{{ row.key ? ` (clé : ${row.key})` : '' }} : {{ row.error }}
        </li>
      </ul>
    </div>

  </private-view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import * as XLSX from 'xlsx';
import { useI18n } from 'vue-i18n';
import { messages } from '../shared/i18nModule';

// Stores et API
const api = useApi();
const { useCollectionsStore } = useStores();
const collectionsStore = useCollectionsStore();

// État
const selectedCollection = ref(null);
const collections = ref([]);
const contactFields = ref([]);
const selectedFile = ref(null);
const previewData = ref([]);
const mapping = ref({});
const importResult = ref(null); 
const successMessage = ref('');
const errorMessage = ref('');
const failedRows = ref([]);
const projectLanguage = ref('');
const isLoading = ref(false);

// 🔄 Retrieves the project language
async function fetchProjectInfo() {
  try {
    const response = await api.get('/server/info');
    projectLanguage.value = response.data.data.project.default_language || 'en-US';
    console.log('✅ Project language :', projectLanguage.value);
  } catch (err) {
    console.error('❌ Unable to retrieve the project language', err);
  }
}

const { t } = useI18n({
  locale: projectLanguage.value,
  messages,
});

// 🔄 Retrieves visible collections
const availableCollections = computed(() =>
  collectionsStore.visibleCollections
    .filter((col) => col.schema && col.schema.name)
    .map((col) => ({
      value: col.collection,
      label: col.name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
);

// 🔄 Retrieves fields from the selected collection
async function fetchFields(collection) {
  try {
    const response = await api.get(`/fields/${collection}`);
    contactFields.value = response.data.data
      .filter((f) => !f.field.startsWith('$'))
      .map((f) => {
        let label = f.field;
        const translations = f.meta?.translations;
        if (Array.isArray(translations)) {
          const match = translations.find((t) => t.language === projectLanguage.value);
          if (match?.translation) label = match.translation;
        }
        return { value: f.field, label };
      });

    console.log(`✅ Fields recovered for ${collection} :`, contactFields.value);
  } catch (err) {
    console.error(`❌ Error retrieving fields for ${collection} :`, err);
  }
}

// ⚙️ Filter fields to avoid duplicate mapping
function getAvailableFields(currentIndex) {
  const usedFields = Object.entries(mapping.value)
    .filter(([index, value]) => value && Number(index) !== currentIndex)
    .map(([, value]) => value);

  return contactFields.value
    .filter(field => !usedFields.includes(field.value))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// 📤 Import Excel file avec gestion d'erreur améliorée
async function importFile() {
  try {
    isLoading.value = true; 
    const formData = new FormData();
    formData.append('file', selectedFile.value);
    formData.append('collection', selectedCollection.value);
    formData.append('mapping', JSON.stringify(mapping.value));
    
    const response = await api.post('/import-excel-api', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });

    importResult.value = response.data;
    failedRows.value = response.data.failed || [];
    
    // 🎯 Vérifier si c'est un échec total (que des erreurs)
    const hasOnlyErrors = 
      (response.data.created || 0) === 0 && 
      (response.data.toVerify || 0) === 0 && 
      (response.data.ignored || 0) === 0 &&
      failedRows.value.length > 0;
    
    if (hasOnlyErrors) {
      // Échec total : traiter comme une erreur
      errorMessage.value = response.data.message || 'Toutes les lignes ont échoué.';
      successMessage.value = '';
    } else {
      // Succès (avec ou sans erreurs partielles)
      successMessage.value = response.data.message || 'Import OK.';
      errorMessage.value = '';
    }

    console.log('✅ Successful import', response);
  } catch (err) {
    console.error('❌ Error when importing:', err);
    
    // 🔍 Extraction détaillée de l'erreur
    let detailedError = 'An error has occurred during import.';
    
    if (err?.response?.data) {
      const errorData = err.response.data;
      
      // Message principal
      if (errorData.message) {
        detailedError = errorData.message;
      }
      
      // Si des erreurs de lignes spécifiques existent
      if (errorData.failed && Array.isArray(errorData.failed) && errorData.failed.length > 0) {
        failedRows.value = errorData.failed;
        
        // Ajouter un résumé des erreurs au message
        const errorSummary = errorData.failed
          .slice(0, 5) // Limiter à 5 premières erreurs pour l'affichage
          .map(f => `Ligne ${f.row}: ${f.error}`)
          .join('\n');
        
        detailedError += `\n\nDétails des erreurs:\n${errorSummary}`;
        
        if (errorData.failed.length > 5) {
          detailedError += `\n... et ${errorData.failed.length - 5} autre(s) erreur(s)`;
        }
      }
      
      // Code d'erreur si disponible
      if (errorData.code) {
        detailedError += `\n\n[Code: ${errorData.code}]`;
      }
    } else if (err?.message) {
      detailedError = err.message;
    }
    
    errorMessage.value = detailedError;
    successMessage.value = '';
    failedRows.value = failedRows.value || [];
    importResult.value = null;
    
    // 📊 Log structuré pour debug
    console.error('Error details:', {
      status: err?.response?.status,
      statusText: err?.response?.statusText,
      data: err?.response?.data,
      message: err?.message
    });
  } finally {
    isLoading.value = false;
  }
}

// 📁 Manage file upload
function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile.value = file;

  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    previewData.value = rows.slice(0, 5);

    const cols = previewData.value[0]?.length || 0;
    mapping.value = {};
    for (let i = 0; i < cols; i++) mapping.value[i] = '';
  };
  reader.readAsArrayBuffer(file);
}

// 📋 Copy errors to clipboard
function copyErrors() {
  const errorText = failedRows.value.map(row => {
    return `Ligne ${row.row}${row.key ? ` (clé : ${row.key})` : ''} : ${row.error}`;
  }).join('\n');

  navigator.clipboard.writeText(errorText).then(() => {
    alert('Les erreurs ont été copiées dans le presse-papiers.');
  }).catch(() => {
    alert('Impossible de copier les erreurs dans le presse-papiers.');
  });
}

// 🎨 Calcul du type d'alerte
const alertType = computed(() => {
  // Prioriser l'erreur si présente
  if (errorMessage.value) return 'error';
  
  if (!importResult.value) return null;

  const hasFailed = (importResult.value.failed || []).length > 0;
  const hasCreatedOrVerified =
    (importResult.value.created || 0) > 0 || 
    (importResult.value.toVerify || 0) > 0;

  // Erreur pure : seulement des échecs
  if (hasFailed && !hasCreatedOrVerified) return 'error';
  
  // Warning : mélange succès + échecs
  if (hasFailed && hasCreatedOrVerified) return 'warning';
  
  // Succès : seulement des créations/vérifications
  if (hasCreatedOrVerified && !hasFailed) return 'success';

  return 'info';
});

// 🔁 Initialisation
onMounted(async () => {
  await fetchProjectInfo();
  collections.value = availableCollections.value;
  selectedCollection.value = collections.value[0]?.value || null;
  if (selectedCollection.value) {
    await fetchFields(selectedCollection.value);
  }
});
</script>

<style scoped>
.step {
  margin-bottom: 30px;
  padding: 0 46px;
}

.mapping-table {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  width: 60%;
  max-width: 60%;
  padding-right: 20px;
  box-sizing: border-box;
}

.mapping-row {
  display: grid;
  grid-template-columns: 1fr 1fr 2fr;
  gap: 20px;
  align-items: center;
}

.mapping-row.header {
  font-weight: bold;
  border-bottom: 1px solid #ccc;
  padding-bottom: 5px;
}

.column {
  overflow-wrap: anywhere;
}

.example-data {
  font-family: monospace;
  font-style: italic;
  font-size: 0.9em;
  border-radius: 4px;
}

/* Alertes */
.alert {
  padding: 12px 46px;
  border-radius: 6px;
  margin-top: 16px;
  max-width: 800px;
  margin-left: auto;
  margin-right: auto;
}

.alert.success {
  background: var(--theme--success-background, #e0ffe0);
  color: var(--theme--success-foreground, #067d06);
  border: 1px solid var(--theme--success-border, #9de89d);
}

.alert.error {
  background: var(--theme--danger-background, #ffe0e0);
  color: var(--theme--danger-foreground, #c00);
  border: 1px solid var(--theme--danger-border, #ef9a9a);
}

.alert.warning {
  background: var(--theme--warning-background, #fffbe6);
  color: var(--theme--warning-foreground, #8a6d3b);
  border: 1px solid var(--theme--warning-border, #ffecb5);
}

.alert.info {
  background: var(--theme--info-background, #e3f2fd);
  color: var(--theme--info-foreground, #01579b);
  border: 1px solid var(--theme--info-border, #90caf9);
}
</style>