import multer from "multer";
import * as XLSX from "xlsx";
import { backendMessages } from "../shared/i18nApi.js"; // adapte le chemin

// 🔧 Fonction utilitaire : normalisation des chaînes
function normalize(str) {
  if (!str) return "";
  
  return str
    .trim()                           // Enlève espaces début/fin
    .toLowerCase()                    // Minuscules
    .replace(/[,.\-']/g, " ")         // Remplace ponctuation par espace
    .replace(/\s+/g, " ")             // Espaces multiples → 1 seul
    .trim();                          // Re-trim final
}

// 🔎 Fonction utilitaire : check concordance
function getConcordance(existingItem, newItem) {
  const nomPrenomMatch = normalize(existingItem.nom_prenom) === normalize(newItem.nom_prenom);

  // Si le nom ne matche pas → nouvelle fiche
  if (!nomPrenomMatch) return "NONE";

  // Le nom matche, on vérifie adresse + CP
  const getAdresses = (item) =>
    [item.adresse, item.adresse_2]
      .filter(a => a && a.trim())
      .map(a => normalize(a));

  const existingAdresses = getAdresses(existingItem);
  const newAdresses = getAdresses(newItem);

  // Au moins une adresse correspond
  const adresseMatch =
    existingAdresses.length > 0 &&
    newAdresses.length > 0 &&
    existingAdresses.some(ea => newAdresses.includes(ea));

  // Code postal identique
  const cp1 = normalize(existingItem.code_postal);
  const cp2 = normalize(newItem.code_postal);
  const codePostalMatch = cp1 && cp2 && cp1 === cp2;

  // ✅ Concordance stricte : Nom + Adresse + CP tous identiques → Ignoré
  if (nomPrenomMatch && adresseMatch && codePostalMatch) {
    return "STRICT";
  }

  // ⚠️ Tous les autres cas avec nom identique → À vérifier
  return "PARTIAL";
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
    const startTime = Date.now();
    
    try {
      const lang = (req.headers["accept-language"] || "en-US").split(",")[0];
      const messages = backendMessages[lang] || backendMessages["en-US"];

      // 📥 Log début d'import
      logger.info("=== DÉBUT D'IMPORT ===");
      logger.info({ 
        user: req.accountability?.user, 
        lang,
        collection: req.body.collection,
        fileName: req.file?.originalname
      });

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

      // 🗺️ Log du mapping
      logger.info("Mapping utilisé :");
      logger.info({ mapping });

      const itemsService = new ItemsService(collectionName, {
        schema,
        accountability: req.accountability,
      });

      // 📄 Parsing Excel
      logger.info(`Parsing du fichier "${req.file.originalname}" (${req.file.size} octets)...`);
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      logger.info(`Fichier parsé : ${rows.length} lignes brutes détectées`);

      if (rows.length === 0)
        return res.status(400).json({ message: messages.emptyFile });

      // 🔄 Transformation des lignes
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

      logger.info(`${items.length} items valides après transformation (lignes vides ignorées)`);

      if (items.length === 0)
        return res.status(400).json({ message: messages.noValidItems });

      const results = [];
      const errors = [];
      let createdCount = 0;        // "Fiche créée"
      let toVerifyCount = 0;       // "Fiche à vérifier"
      let ignoredCount = 0;        // Ignorés

      // 🔍 Charger tous les contacts une seule fois
      logger.info("Chargement des contacts existants en base...");
      const allExisting = await itemsService.readByQuery({ limit: -1 });
      logger.info(`${allExisting.length} contacts existants chargés`);

      // ✅ Détecter les doublons DANS le fichier importé
      const processedInThisImport = [];

      // 🛠️ Logique d'import simplifiée
      logger.info("Début du traitement des items...");
      
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const row = item.__rowIndex;

        // 📊 Log de progression tous les 10 items
        if ((i + 1) % 10 === 0) {
          logger.info(`Progression: ${i + 1}/${items.length} items traités`);
        }

        try {
          // ✅ Vérification que nom_prenom existe
          const normalizedNomPrenom = normalize(item.nom_prenom);
          if (!normalizedNomPrenom) {
            logger.warn(`Ligne ${row} : nom_prenom manquant ou vide`, { item });
            handleItemError(
              row,
              [{ code: "MISSING_NAME", message: "nom_prenom manquant ou vide" }],
              logger,
              errors,
              item
            );
            continue;
          }

          // 🔍 Log de recherche de doublons
          logger.debug(`Ligne ${row} : recherche doublons pour "${item.nom_prenom}"`);

          // ✅ Filtrer les candidats dans la DB ET dans ce qu'on vient de créer
          const candidatesExisting = [
            ...allExisting,
            ...processedInThisImport
          ].filter(
            (ex) => normalize(ex.nom_prenom) === normalizedNomPrenom
          );

          if (candidatesExisting.length > 0) {
            logger.debug(`Ligne ${row} : ${candidatesExisting.length} candidat(s) avec le même nom trouvé(s)`);
          }

          let concordance = "NONE";
          let matchedItem = null;

          if (candidatesExisting.length > 0) {
            // ✅ 1️⃣ Chercher d'abord une concordance STRICT (prioritaire)
            for (const ex of candidatesExisting) {
              const check = getConcordance(ex, item);
              if (check === "STRICT") {
                concordance = "STRICT";
                matchedItem = ex;
                logger.info(`Ligne ${row} : concordance STRICT détectée avec contact existant ID ${ex.id}`, {
                  existingContact: { 
                    id: ex.id, 
                    nom_prenom: ex.nom_prenom, 
                    adresse: ex.adresse,
                    code_postal: ex.code_postal
                  },
                  newContact: { 
                    nom_prenom: item.nom_prenom, 
                    adresse: item.adresse,
                    code_postal: item.code_postal
                  }
                });
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
                  logger.info(`Ligne ${row} : concordance PARTIAL détectée avec contact existant ID ${ex.id}`, {
                    existingContact: { 
                      id: ex.id, 
                      nom_prenom: ex.nom_prenom, 
                      adresse: ex.adresse,
                      code_postal: ex.code_postal
                    },
                    newContact: { 
                      nom_prenom: item.nom_prenom, 
                      adresse: item.adresse,
                      code_postal: item.code_postal
                    }
                  });
                  break; // Premier PARTIAL trouvé
                }
              }
            }
          }

          if (concordance === "STRICT") {
            // 🚫 Pas d'import - doublon détecté
            logger.info(`Ligne ${row} : IGNORÉ - doublon exact avec ID ${matchedItem.id}`);
            results.push({ action: "ignored", row, id: matchedItem.id });
            ignoredCount++;
            continue;
          }

          if (concordance === "PARTIAL" || concordance === "NONE") {
            // ✅ Import avec statut approprié
            const isPartial = concordance === "PARTIAL";
            item.statut = isPartial ? "Fiche à vérifier" : "Fiche créée";
            
            // 📊 Log détaillé pour les fiches à vérifier
            if (isPartial && matchedItem) {
              logger.info(`Ligne ${row} : FICHE À VÉRIFIER - Différences détectées :`);
              logger.info({
                contactExistantDB: {
                  id: matchedItem.id,
                  nom_prenom: matchedItem.nom_prenom,
                  adresse: matchedItem.adresse || "(vide)",
                  adresse_2: matchedItem.adresse_2 || "(vide)",
                  code_postal: matchedItem.code_postal || "(vide)"
                },
                nouveauContactFichier: {
                  nom_prenom: item.nom_prenom,
                  adresse: item.adresse || "(vide)",
                  adresse_2: item.adresse_2 || "(vide)",
                  code_postal: item.code_postal || "(vide)"
                }
              });
            }
            
            delete item.__rowIndex;
            
            logger.debug(`Ligne ${row} : création du contact avec statut "${item.statut}"`);
            const newId = await itemsService.createOne(item);

            // ✅ Ajouter aux deux listes pour détecter les doublons dans le même fichier
            const createdItem = { ...item, id: newId };
            allExisting.push(createdItem);
            processedInThisImport.push(createdItem);

            // 📊 Incrémenter le bon compteur
            if (isPartial) {
              logger.info(`Ligne ${row} : contact créé ID ${newId} avec statut "Fiche à vérifier"`);
              results.push({ id: newId, action: "toVerify", row });
              toVerifyCount++;
            } else {
              logger.info(`Ligne ${row} : contact créé ID ${newId} avec statut "Fiche créée"`);
              results.push({ id: newId, action: "created", row });
              createdCount++;
            }
            continue;
          }

        } catch (error) {
          logger.error(`Ligne ${row} : erreur lors du traitement`, { error });
          handleItemError(row, error, logger, errors, item);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      logger.info("=== IMPORT TERMINÉ ===");
      logger.info(
        `Import terminé en ${duration}s : ${createdCount} créés, ${toVerifyCount} à vérifier, ${ignoredCount} ignorés, ${errors.length} erreurs.`
      );
      logger.info({
        duration: `${duration}s`,
        totalProcessed: items.length,
        created: createdCount,
        toVerify: toVerifyCount,
        ignored: ignoredCount,
        failed: errors.length,
        successRate: `${(((createdCount + toVerifyCount) / items.length) * 100).toFixed(1)}%`
      });

      const parts = [];
      if (createdCount > 0) parts.push(`${createdCount} ${messages.created}`);
      if (toVerifyCount > 0) parts.push(`${toVerifyCount} ${messages.toVerify}`);
      if (ignoredCount > 0) parts.push(`${ignoredCount} ${messages.ignored}`);
      if (errors.length > 0) parts.push(`${errors.length} ${messages.failed}`);

      const summary = parts.length > 0 ? parts.join(", ") : messages.none;

      return res.status(errors.length > 0 ? 207 : 200).json({
        message: `${results.length + errors.length} ${
          messages.processedItemsPrefix
        } ${summary}.`,
        created: createdCount,
        toVerify: toVerifyCount,
        ignored: ignoredCount,
        failed: errors,
      });
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.error(`=== ERREUR FATALE APRÈS ${duration}s ===`);
      
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
      logger.error({ code, error: detail, stack: error.stack });

      return res.status(error.statusCode || 500).json({
        message: formatMessage(messages.internalError, { error: detail }),
        code,
      });
    }
  });
}