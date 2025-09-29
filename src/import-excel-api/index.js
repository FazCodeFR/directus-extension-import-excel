import multer from "multer";
import * as XLSX from "xlsx";
import { backendMessages } from "../shared/i18nApi.js"; // adapte le chemin

// 🔧 Fonction utilitaire : normalisation des chaînes
function normalize(str) {
  return str?.trim().toLowerCase() || "";
}

// 🔎 Fonction utilitaire : check concordance
function getConcordance(existingItem, newItem) {
  const nomPrenomMatch = normalize(existingItem.nom_prenom) === normalize(newItem.nom_prenom);

  // Court-circuit : si le nom ne matche pas, pas besoin de vérifier le reste
  if (!nomPrenomMatch) return "NONE";

  // Fonction pour extraire les adresses valides
  const getAdresses = (item) =>
    [item.adresse, item.adresse_2]
      .filter(a => a && a.trim()) // Vérification que a existe avant .trim()
      .map(a => normalize(a));

  const existingAdresses = getAdresses(existingItem);
  const newAdresses = getAdresses(newItem);

  // Vérifie si au moins une adresse correspond (et qu'il y a des adresses)
  const adresseMatch =
    existingAdresses.length > 0 &&
    newAdresses.length > 0 &&
    existingAdresses.some(ea => newAdresses.includes(ea));

  // Normalisation du code postal
  const cp1 = normalize(existingItem.code_postal);
  const cp2 = normalize(newItem.code_postal);
  const codePostalMatch = cp1 && cp2 && cp1 === cp2;

  // ✅ Concordance stricte → PAS D'IMPORT
  // Nom identique + au moins une adresse correspond + code postal identique
  if (nomPrenomMatch && adresseMatch && codePostalMatch) {
    return "STRICT";
  }

  // ⚠️ Concordance partielle → IMPORT AVEC STATUT À VÉRIFIER
  // Nom identique + (adresse correspond OU code postal correspond)
  if (nomPrenomMatch && (adresseMatch || codePostalMatch)) {
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
      let ignoredCount = 0;

      // Charger tous les contacts une seule fois
      const allExisting = await itemsService.readByQuery({ limit: -1 });

      // ✅ Solution 2 : Détecter les doublons DANS le fichier importé
      const processedInThisImport = [];

      // 🛠️ Nouvelle logique d'import (avec priorité STRICT)
      for (const item of items) {
        const row = item.__rowIndex;

        try {
          // ✅ Vérification que nom_prenom existe
          const normalizedNomPrenom = normalize(item.nom_prenom);
          if (!normalizedNomPrenom) {
            handleItemError(
              row,
              [{ code: "MISSING_NAME", message: "nom_prenom manquant ou vide" }],
              logger,
              errors,
              item
            );
            continue;
          }

          // ✅ Filtrer les candidats dans la DB ET dans ce qu'on vient de créer
          const candidatesExisting = [
            ...allExisting,
            ...processedInThisImport
          ].filter(
            (ex) => normalize(ex.nom_prenom) === normalizedNomPrenom
          );

          let concordance = "NONE";
          let matchedItem = null;

          if (candidatesExisting.length > 0) {
            // ✅ 1️⃣ Chercher d'abord une concordance STRICT (prioritaire)
            for (const ex of candidatesExisting) {
              const check = getConcordance(ex, item);
              if (check === "STRICT") {
                concordance = "STRICT";
                matchedItem = ex;
                break; // Match exact trouvé, on arrête
              }
            }

            // ✅ 2️⃣ Si pas de STRICT, chercher une concordance PARTIAL
            if (concordance === "NONE") {
              for (const ex of candidatesExisting) {
                const check = getConcordance(ex, item);
                if (check === "PARTIAL") {
                  concordance = "PARTIAL";
                  matchedItem = ex;
                  break; // Premier PARTIAL trouvé
                }
              }
            }
          }

          if (concordance === "STRICT") {
            // 🚫 Pas d'import - doublon détecté
            results.push({ action: "ignored", row, id: matchedItem.id });
            ignoredCount++;
            continue;
          }

          if (concordance === "PARTIAL" || concordance === "NONE") {
            // ✅ Import avec statut approprié
            item.statut = concordance === "PARTIAL" ? "Fiche à vérifier" : "Fiche créée";
            delete item.__rowIndex;
            const newId = await itemsService.createOne(item);

            // ✅ Ajouter aux deux listes pour détecter les doublons dans le même fichier
            const createdItem = { ...item, id: newId };
            allExisting.push(createdItem);
            processedInThisImport.push(createdItem);

            results.push({ id: newId, action: "created", row });
            createdCount++;
            continue;
          }

        } catch (error) {
          handleItemError(row, error, logger, errors, item);
        }
      }

      logger.info(
        `Import terminé : ${createdCount} créés, ${ignoredCount} ignorés, ${errors.length} erreurs.`
      );
      logger.info({
        created: createdCount,
        ignored: ignoredCount,
        failed: errors,
      });

      const parts = [];
      if (createdCount > 0) parts.push(`${createdCount} ${messages.created}`);
      if (ignoredCount > 0) parts.push(`${ignoredCount} ${messages.ignored}`);
      if (errors.length > 0) parts.push(`${errors.length} ${messages.failed}`);

      const summary = parts.length > 0 ? parts.join(", ") : messages.none;

      return res.status(errors.length > 0 ? 207 : 200).json({
        message: `${results.length + errors.length} ${
          messages.processedItemsPrefix
        } ${summary}.`,
        created: createdCount,
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