import multer from "multer";
import * as XLSX from "xlsx";
import { backendMessages } from "../shared/i18nApi.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fonction utilitaire : normalisation des chaînes
function normalize(str) {
  if (!str) return "";
  
  return str
    .trim()
    .toLowerCase()
    .replace(/[,.\-']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Fonction utilitaire : check concordance
function getConcordance(existingItem, newItem) {
  const nomPrenomMatch = normalize(existingItem.nom_prenom) === normalize(newItem.nom_prenom);

  if (!nomPrenomMatch) return "NONE";

  const getAdresses = (item) =>
    [item.adresse, item.adresse_2]
      .filter(a => a && a.trim())
      .map(a => normalize(a));

  const existingAdresses = getAdresses(existingItem);
  const newAdresses = getAdresses(newItem);

  const adresseMatch =
    existingAdresses.length > 0 &&
    newAdresses.length > 0 &&
    existingAdresses.some(ea => newAdresses.includes(ea));

  const cp1 = normalize(existingItem.code_postal);
  const cp2 = normalize(newItem.code_postal);
  const codePostalMatch = cp1 && cp2 && cp1 === cp2;

  if (nomPrenomMatch && adresseMatch && codePostalMatch) {
    return "STRICT";
  }

  return "PARTIAL";
}

function formatMessage(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, key) => params[key] || "");
}

function handleItemError(row, error, logFunc, errors, item = {}) {
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

  logFunc(`ERREUR ligne ${row} : ${detail}`);
  errors.push({ row, error: detail, code });
}

export default function registerEndpoint(router, { services, getSchema, logger }) {
  const { ItemsService, FilesService } = services;

  const storage = multer.memoryStorage();
  const upload = multer({ storage });

  router.post("/", upload.single("file"), async (req, res) => {
    const startTime = Date.now();
    
    // Créer un fichier de log unique pour cet import
    const logFileName = `import_${Date.now()}_${Math.random().toString(36).substring(7)}.log`;
    const logFilePath = path.join(__dirname, "../../../uploads", logFileName);
    const logStream = fs.createWriteStream(logFilePath);

    // Buffer pour les logs - on écrit en batch toutes les 100 lignes
    let logBuffer = [];
    const BATCH_SIZE = 100;
    
    const flushLogs = () => {
      if (logBuffer.length > 0) {
        logStream.write(logBuffer.join(''));
        logBuffer = [];
      }
    };
    
    // Fonction helper pour écrire dans le log (format texte lisible)
    const log = (message, forceFlush = false) => {
      const timestamp = new Date().toISOString();
      logBuffer.push(`[${timestamp}] ${message}\n`);
      
      // Flush si buffer plein ou force
      if (forceFlush || logBuffer.length >= BATCH_SIZE) {
        flushLogs();
      }
      
      // Logger Pino uniquement pour les messages importants
      if (forceFlush || message.includes('ERREUR') || message.includes('DEBUT') || message.includes('TERMINE')) {
        logger.info(message);
      }
    };

    let createdCount = 0;
    let toVerifyCount = 0;
    let ignoredCount = 0;
    let totalItems = 0;

    try {
      const lang = (req.headers["accept-language"] || "en-US").split(",")[0];
      const messages = backendMessages[lang] || backendMessages["en-US"];

      log("================================================================================");
      log("DEBUT D'IMPORT");
      log("================================================================================");
      log(`Utilisateur : ${req.accountability?.user || "Inconnu"}`);
      log(`Langue : ${lang}`);
      log(`Collection : ${req.body.collection}`);
      log(`Fichier : ${req.file?.originalname}`);
      log("");

      if (!req.file) {
        log("ERREUR : Fichier manquant");
        logStream.end();
        return res.status(400).json({ message: messages.missingFile });
      }

      if (!req.body.collection) {
        log("ERREUR : Collection manquante");
        logStream.end();
        return res.status(400).json({ message: messages.missingCollection });
      }

      if (!req.body.mapping) {
        log("ERREUR : Mapping manquant");
        logStream.end();
        return res.status(400).json({ message: messages.missingMapping });
      }

      const schema = await getSchema();
      const collectionName = req.body.collection;
      const mapping = JSON.parse(req.body.mapping);

      log("Mapping utilise :");
      Object.entries(mapping).forEach(([col, field]) => {
        if (field) log(`  Colonne ${col} -> ${field}`);
      });
      log("");

      const itemsService = new ItemsService(collectionName, {
        schema,
        accountability: req.accountability,
      });

      // Parsing Excel
      log(`Parsing du fichier "${req.file.originalname}" (${req.file.size} octets)...`);
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      log(`Fichier parse : ${rows.length} lignes brutes detectees`);
      log("");

      if (rows.length === 0) {
        log("ERREUR : Fichier vide");
        logStream.end();
        return res.status(400).json({ message: messages.emptyFile });
      }

      // Transformation des lignes
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

      log(`${items.length} items valides apres transformation (lignes vides ignorees)`);
      log("");

      if (items.length === 0) {
        log("ERREUR : Aucun item valide");
        logStream.end();
        return res.status(400).json({ message: messages.noValidItems });
      }

      totalItems = items.length;
      const results = [];
      const errors = [];

      // Charger tous les contacts existants
      log("Chargement des contacts existants en base...");
      const allExisting = await itemsService.readByQuery({ limit: -1 });
      log(`${allExisting.length} contacts existants charges`);
      log("");

      const processedInThisImport = [];

      log("DEBUT DU TRAITEMENT DES ITEMS");
      log("--------------------------------------------------------------------------------");
      log("");

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const row = item.__rowIndex;

        // Log de progression tous les 100 items au lieu de 10
        if ((i + 1) % 100 === 0) {
          log(`Progression : ${i + 1}/${items.length} items traites`, true);
        }

        try {
          // Vérification que nom_prenom existe
          const normalizedNomPrenom = normalize(item.nom_prenom);
          if (!normalizedNomPrenom) {
            log(`Ligne ${row} : nom_prenom manquant ou vide - IGNORE`);
            handleItemError(
              row,
              [{ code: "MISSING_NAME", message: "nom_prenom manquant ou vide" }],
              log,
              errors,
              item
            );
            continue;
          }

          // Recherche de doublons
          const candidatesExisting = [
            ...allExisting,
            ...processedInThisImport
          ].filter(
            (ex) => normalize(ex.nom_prenom) === normalizedNomPrenom
          );

          let concordance = "NONE";
          let matchedItem = null;

          if (candidatesExisting.length > 0) {
            // 1. Chercher concordance STRICT
            for (const ex of candidatesExisting) {
              const check = getConcordance(ex, item);
              if (check === "STRICT") {
                concordance = "STRICT";
                matchedItem = ex;
                log(`Ligne ${row} : DOUBLON STRICT detecte avec contact ID ${ex.id}`);
                log(`  Existant : ${ex.nom_prenom} | ${ex.adresse || '(vide)'} | CP: ${ex.code_postal || '(vide)'}`);
                log(`  Nouveau  : ${item.nom_prenom} | ${item.adresse || '(vide)'} | CP: ${item.code_postal || '(vide)'}`);
                break;
              }
            }

            // 2. Si pas de STRICT, chercher PARTIAL
            if (concordance === "NONE") {
              for (const ex of candidatesExisting) {
                const check = getConcordance(ex, item);
                if (check === "PARTIAL") {
                  concordance = "PARTIAL";
                  matchedItem = ex;
                  log(`Ligne ${row} : CONCORDANCE PARTIELLE avec contact ID ${ex.id}`);
                  log(`  Existant : ${ex.nom_prenom} | ${ex.adresse || '(vide)'} | CP: ${ex.code_postal || '(vide)'}`);
                  log(`  Nouveau  : ${item.nom_prenom} | ${item.adresse || '(vide)'} | CP: ${item.code_postal || '(vide)'}`);
                  break;
                }
              }
            }
          }

          if (concordance === "STRICT") {
            log(`Ligne ${row} : IGNORE (doublon exact avec ID ${matchedItem.id})`);
            log("");
            results.push({ action: "ignored", row, id: matchedItem.id });
            ignoredCount++;
            continue;
          }

          if (concordance === "PARTIAL" || concordance === "NONE") {
            const isPartial = concordance === "PARTIAL";
            item.statut = isPartial ? "Fiche à vérifier" : "Fiche créée";
            
            delete item.__rowIndex;
            
            const newId = await itemsService.createOne(item);

            const createdItem = { ...item, id: newId };
            allExisting.push(createdItem);
            processedInThisImport.push(createdItem);

            if (isPartial) {
              log(`Ligne ${row} : CREE avec statut "Fiche a verifier" (ID ${newId})`);
              log("");
              results.push({ id: newId, action: "toVerify", row });
              toVerifyCount++;
            } else {
              log(`Ligne ${row} : CREE avec statut "Fiche creee" (ID ${newId})`);
              log("");
              results.push({ id: newId, action: "created", row });
              createdCount++;
            }
            continue;
          }

        } catch (error) {
          log(`Ligne ${row} : ERREUR lors du traitement`);
          log(`  Details : ${error.message || error}`);
          log("");
          handleItemError(row, error, log, errors, item);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      log("");
      log("================================================================================");
      log("IMPORT TERMINE");
      log("================================================================================");
      log(`Duree : ${duration}s`);
      log(`Total traite : ${items.length} items`);
      log(`Crees : ${createdCount}`);
      log(`A verifier : ${toVerifyCount}`);
      log(`Ignores : ${ignoredCount}`);
      log(`Erreurs : ${errors.length}`);
      log(`Taux de succes : ${(((createdCount + toVerifyCount) / items.length) * 100).toFixed(1)}%`);
      log("================================================================================", true);

      // Flush final du buffer
      flushLogs();
      
      // Fermer le fichier de log et l'uploader dans Directus
      logStream.end();

      // Attendre que le stream soit fermé
      await new Promise((resolve) => logStream.on('finish', resolve));

      const filesService = new FilesService({
        schema,
        accountability: req.accountability,
      });

      // Construire le résumé pour la description
      const summaryParts = [];
      if (createdCount > 0) summaryParts.push(`${createdCount} crees`);
      if (toVerifyCount > 0) summaryParts.push(`${toVerifyCount} a verifier`);
      if (ignoredCount > 0) summaryParts.push(`${ignoredCount} ignores`);
      if (errors.length > 0) summaryParts.push(`${errors.length} erreurs`);
      
      const summaryText = `${totalItems} items traites : ${summaryParts.join(', ')}`;
      const dateText = new Date().toLocaleString('fr-FR', {
        dateStyle: 'long',
        timeStyle: 'medium'
      });
      
      const description = `${summaryText}\nDate: ${dateText}`;

      // Upload du fichier de log
      const logFileStream = fs.createReadStream(logFilePath);
      const logFileId = await filesService.uploadOne(logFileStream, {
        filename_download: logFileName,
        type: 'text/plain',
        storage: 'local',
        title: `Import Log - ${new Date().toLocaleString('fr-FR')}`,
        description: description,
      });

      logger.info(`Fichier de log uploade avec ID : ${logFileId}`);

      // Nettoyer le fichier temporaire
      fs.unlinkSync(logFilePath);

      // Construire le message de résumé
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
        logFileId: logFileId,
        logFileName: logFileName,
      });
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      log("");
      log("================================================================================");
      log(`ERREUR FATALE APRES ${duration}s`);
      log("================================================================================");
      log(error.message || error);
      if (error.stack) {
        log("Stack trace :");
        log(error.stack);
      }
      log("================================================================================", true);
      
      // Flush final du buffer en cas d'erreur
      flushLogs();
      
      logStream.end();
      
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