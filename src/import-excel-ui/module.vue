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

    <div v-if="previewData.length && contactFields.length" class="step">
      <h2>{{ t('keyFieldTitle') }}</h2>
      <VSelect
        v-model="keyField"
        :items="contactFields"
        item-text="label"
        item-value="value"
        :label="t('keyFieldLabel')"
        :placeholder="t('selectKeyFieldPlaceholder')"
        clearable
      />
      <p class="info-text">{{ t('keyFieldHelp1') }}</p>
      <p class="info-text">{{ t('keyFieldHelp2') }}</p>
    </div>

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

    <div v-if="successMessage" class="alert success">{{ successMessage }}</div>
    <div v-if="errorMessage" class="alert error">{{ errorMessage }}</div>

    <!-- Affiche les lignes en échec s’il y en a -->
    <div v-if="failedRows.length > 0" class="alert warning">
      <strong>Des erreurs ont été détectées sur les lignes suivantes :</strong>
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
const successMessage = ref('');
const errorMessage = ref('');
const failedRows = ref([]);

const projectLanguage = ref('');

const isLoading = ref(false);

const keyField = ref('');

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
    .sort((a, b) => a.label.localeCompare(b.label)); // tri alphabétique
}


// 📤 Import Excel file
async function importFile() {
  try {
    const formData = new FormData();
    formData.append('file', selectedFile.value);
    formData.append('collection', selectedCollection.value);
    formData.append('mapping', JSON.stringify(mapping.value));
    if (keyField.value) {
      formData.append('keyField', keyField.value);
    }

    const response = await api.post('/import-excel-api', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });

    successMessage.value = response.data.message || 'Import OK.';
    errorMessage.value = '';
    failedRows.value = response.data.failed || [];

    console.log('✅ Successful import', response);
  } catch (err) {
    errorMessage.value = err?.response?.data?.message || 'An error has occurred during import.';
    successMessage.value = '';
    failedRows.value = [];
    console.error('❌ Error when importing :', err);
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
  /* background-color: #f8f8f8; */
  /* padding: 5px; */
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
</style>
