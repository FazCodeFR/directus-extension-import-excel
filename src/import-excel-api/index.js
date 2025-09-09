import multer from "multer";
import * as XLSX from "xlsx";
import { backendMessages } from "../shared/i18nApi.js"; // adapte le chemin



// 🔎 Fonction utilitaire : check concordance
function getConcordance(existingItem, newItem) {
  const nomPrenomMatch = existingItem.nom_prenom?.trim().toLowerCase() === newItem.nom_prenom?.trim().toLowerCase();

  // On ne garde que les adresses définies et non vides
  const existingAdresses = [existingItem.adresse, existingItem.adresse_2]
    .filter(a => a?.trim())
    .map(a => a.trim().toLowerCase());

  const newAdresses = [newItem.adresse, newItem.adresse_2]
    .filter(a => a?.trim())
    .map(a => a.trim().toLowerCase());

  // Vérifie si au moins une adresse correspond
  const adresseMatch = existingAdresses.some(ea => newAdresses.includes(ea));

  const codePostalMatch = existingItem.code_postal?.trim() === newItem.code_postal?.trim();

  // ✅ Concordance stricte → PAS D’IMPORT
  if (nomPrenomMatch && adresseMatch && codePostalMatch) {
    return "STRICT";
  }

  // ⚠️ Concordance partielle → IMPORT AVEC STATUT À VÉRIFIER
  if ((nomPrenomMatch && adresseMatch) || (nomPrenomMatch && codePostalMatch)) {
    return "PARTIAL";
  }

  // ❌ Nouvelle entrée → IMPORT AVEC STATUT FICHE CRÉÉE
  return "NONE";
}




function formatMessage(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, key) => params[key] || "");
}

function handleItemError(row, error, logger, errors, item = {}) {
  const detail =
    error?.map?.((e) => {
        const field = e.extensions?.field || e.path || "inconnu";
        const type = e.extensions?.type || "validation";
        const code = e.code || "UNKNOWN_ERROR";
        const value = item?.[field];
        return `Champ "${field}" : ${type} (${code})` + (value !== undefined ? ` | valeur : "${value}"` : "");
      })
      .join("; ") ||
    error?.message ||
    error ||
    "Validation failed";

  const code =
    error?.errors?.[0]?.code || error?.[0]?.code || error?.code || "UNKNOWN";

  logger.error(`Erreur ligne ${row} : ${detail}`);
  logger.error({ row, error: detail, code });

  errors.push({ row, error: detail, code });
}


export default function registerEndpoint(router, { services, getSchema, logger }) {
  const { ItemsService } = services;

  const storage = multer.memoryStorage();
  const upload = multer({ storage });

  router.post("/", upload.single("file"), async (req, res) => {
    try {
      const lang = (req.headers["accept-language"] || "en-US").split(",")[0];
      const messages = backendMessages[lang] || backendMessages["en-US"];

      if (!req.file)
        return res.status(400).json({ message: messages.missingFile });

      if (!req.body.collection)
        return res.status(400).json({ message: messages.missingCollection });

      if (!req.body.mapping)
        return res.status(400).json({ message: messages.missingMapping });

      const schema = await getSchema();
      const collectionName = req.body.collection;
      const mapping = JSON.parse(req.body.mapping);
      const keyField = req.body.keyField || null;

      const itemsService = new ItemsService(collectionName, {
        schema,
        accountability: req.accountability,
      });

      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      if (rows.length === 0)
        return res.status(400).json({ message: messages.emptyFile });

      const items = rows
        .map((row, rowIndex) => {
          const item = {};
          for (const [colIndex, fieldName] of Object.entries(mapping)) {
            if (fieldName) {
              const value = row[colIndex];
              const stringValue =
                value !== undefined && value !== null
                  ? String(value).trim()
                  : "";
              if (stringValue !== "") {
                item[fieldName] = stringValue;
              }
            }
          }
          item.__rowIndex = rowIndex + 1;
          return item;
        })
        .filter((item) => Object.keys(item).length > 1);

      if (items.length === 0)
        return res.status(400).json({ message: messages.noValidItems });

      const results = [];
      const errors = [];
      let createdCount = 0;
      let updatedCount = 0;
      let ignoredCount = 0;

      // 🛠️ Nouvelle logique d'import (sans clé spécifique)
      for (const item of items) {
        const row = item.__rowIndex;

        try {
          // On recherche d'abord des doublons potentiels sur "nom_prenom"
          const existing = await itemsService.readByQuery({
            filter: { nom_prenom: { _icontains: item.nom_prenom } },
            limit: -1,
          });

          let concordance = "NONE";
          let matchedItem = null;

          if (existing.length > 0) {
            for (const ex of existing) {
              concordance = getConcordance(ex, item);
              if (concordance !== "NONE") {
                matchedItem = ex;
                break;
              }
            }
          }

          if (concordance === "STRICT") {
            // 🚫 Pas d'import
            results.push({ action: "ignored", row, id: matchedItem.id });
            ignoredCount++;
            continue;
          }

          if (concordance === "PARTIAL" || concordance === "NONE") {
            // ✅ Nouvelle entrée
            item.statut = concordance === "PARTIAL" ? "Fiche à vérifier" : "Fiche créée";
            delete item.__rowIndex;
            const newId = await itemsService.createOne(item);
            results.push({ id: newId, action: "created", row });
            createdCount++;
            continue;
          }

        } catch (error) {
          handleItemError(row, error, logger, errors, item);
        }
      }

      logger.info(
        `Import terminé : ${createdCount} créés, ${updatedCount} mis à jour, ${ignoredCount} ignorés, ${errors.length} erreurs.`
      );
      logger.info({
        created: createdCount,
        updated: updatedCount,
        ignored: ignoredCount,
        failed: errors,
      });

      const parts = [];
      if (createdCount > 0) parts.push(`${createdCount} ${messages.created}`);
      if (updatedCount > 0) parts.push(`${updatedCount} ${messages.updated}`);
      if (ignoredCount > 0) parts.push(`${ignoredCount} ${messages.ignored}`);
      if (errors.length > 0) parts.push(`${errors.length} ${messages.failed}`);

      const summary = parts.length > 0 ? parts.join(", ") : messages.none;

      return res.status(errors.length > 0 ? 207 : 200).json({
        message: `${results.length + errors.length} ${
          messages.processedItemsPrefix
        } ${summary}.`,
        created: createdCount,
        updated: updatedCount,
        ignored: ignoredCount,
        failed: errors,
      });
    } catch (error) {
      const lang = (req.headers["accept-language"] || "en-US").split(",")[0];
      const messages = backendMessages[lang] || backendMessages["en-US"];

      const detail =
        error?.map?.((e) => {
            const field = e.extensions?.field || e.path || "inconnu";
            const type = e.extensions?.type || "validation";
            const code = e.code || "UNKNOWN_ERROR";
            return `Champ "${field}" : ${type} (${code})`;
          })
          .join("; ") ||
        error?.message ||
        error ||
        "Internal error";

      const code = error?.[0]?.code || error?.code || "UNKNOWN";

      logger.error(`Unexpected error: ${detail}`);
      logger.error({ code, error: detail });

      return res.status(error.statusCode || 500).json({
        message: formatMessage(messages.internalError, { error: detail }),
        code,
      });
    }
  });
}
