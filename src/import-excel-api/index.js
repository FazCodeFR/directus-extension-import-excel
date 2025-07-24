import multer from 'multer';
import * as XLSX from 'xlsx';
import { createError } from '@directus/errors';
import { backendMessages } from '../shared/i18nApi.js'; // adapte le chemin

function formatMessage(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, key) => params[key] || '');
}

export default function registerEndpoint(router, { services, getSchema, logger }) {
  const { ItemsService } = services;

  const storage = multer.memoryStorage();
  const upload = multer({ storage });

  router.post('/', upload.single('file'), async (req, res) => {
    try {
      const lang = (req.headers['accept-language'] || 'en-US').split(',')[0];
      const messages = backendMessages[lang] || backendMessages['en-US'];

      if (!req.file) {
        logger.warn('No file uploaded');
        return res.status(400).json({ message: messages.missingFile });
      }
      if (!req.body.collection) {
        logger.warn('No collection provided');
        return res.status(400).json({ message: messages.missingCollection });
      }
      if (!req.body.mapping) {
        logger.warn('No mapping provided');
        return res.status(400).json({ message: messages.missingMapping });
      }

      const schema = await getSchema();
      const collectionName = req.body.collection;
      const mapping = JSON.parse(req.body.mapping);
      const keyField = req.body.keyField || null;

      const itemsService = new ItemsService(collectionName, {
        schema,
        accountability: req.accountability,
      });

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      if (rows.length === 0) {
        logger.warn('Uploaded Excel file is empty');
        return res.status(400).json({ message: messages.emptyFile });
      }

      const items = rows.map((row, rowIndex) => {
        const item = {};
        for (const [colIndex, fieldName] of Object.entries(mapping)) {
          if (fieldName) {
            const value = row[colIndex];
            const trimmedValue = typeof value === 'string' ? value.trim() : value;
            if (trimmedValue !== undefined && trimmedValue !== null && trimmedValue !== '') {
              item[fieldName] = trimmedValue;
            }
          }
        }
        // Ajout de l'index ligne pour debug si besoin
        item.__rowIndex = rowIndex + 2; // +2 car ligne Excel (1-based) + en-tête
        return item;
      }).filter(item => Object.keys(item).length > 1); // au moins un champ + __rowIndex

      if (items.length === 0) {
        logger.warn('No valid items found in Excel after mapping');
        return res.status(400).json({ message: messages.noValidItems });
      }

      if (keyField) {
        const missingKey = items.find(item => !(keyField in item));
        if (missingKey) {
          logger.warn(`Missing keyField "${keyField}" on row ${missingKey.__rowIndex}`);
          return res.status(400).json({
            message: formatMessage(messages.missingKeyForUpsert, { keyField }),
          });
        }

        const keyValues = [...new Set(items.map(item => item[keyField]))];
        const existingItems = await itemsService.readByQuery({
          filter: { [keyField]: { _in: keyValues } },
          limit: keyValues.length,
        });
        const existingMap = new Map(existingItems.map(item => [item[keyField], item]));

        const results = [];
        let createdCount = 0;
        let updatedCount = 0;

        for (const item of items) {
          const keyValue = item[keyField];
          const existing = existingMap.get(keyValue);
          try {
            if (existing) {
              await itemsService.updateOne(existing.id, item);
              results.push({ id: existing.id, action: 'updated', row: item.__rowIndex });
              updatedCount++;
              logger.info(`Updated item id=${existing.id} (key=${keyValue}) at row ${item.__rowIndex}`);
            } else {
              const newId = await itemsService.createOne(item);
              results.push({ id: newId, action: 'created', row: item.__rowIndex });
              createdCount++;
              logger.info(`Created new item id=${newId} (key=${keyValue}) at row ${item.__rowIndex}`);
            }
          } catch (error) {
            logger.error(`Error processing item at row ${item.__rowIndex} (key=${keyValue}): ${error.message || error}`);
            // Option : collecter ces erreurs et les renvoyer en réponse (ou simplement ignorer / arrêter)
            return res.status(400).json({
              message: `Erreur sur la ligne ${item.__rowIndex} (clé ${keyValue}): ${error.message || 'Validation failed'}`,
            });
          }
        }

        return res.json({
          message: formatMessage(messages.processedItems, {
            count: results.length,
            created: createdCount,
            updated: updatedCount,
          }),
          data: results,
        });
      } else {
        // Pas de clé, on crée tous les items
        const results = [];
        for (const item of items) {
          try {
            const newId = await itemsService.createOne(item);
            results.push({ id: newId, action: 'created', row: item.__rowIndex });
            logger.info(`Created new item id=${newId} at row ${item.__rowIndex}`);
          } catch (error) {
            logger.error(`Error creating item at row ${item.__rowIndex}: ${error.message || error}`);
            return res.status(400).json({
              message: `Erreur sur la ligne ${item.__rowIndex}: ${error.message || 'Validation failed'}`,
            });
          }
        }

        return res.json({
          message: formatMessage(messages.itemsCreated, { count: results.length }),
          data: results,
        });
      }
    } catch (error) {
      const lang = (req.headers['accept-language'] || 'en-US').split(',')[0];
      const messages = backendMessages[lang] || backendMessages['en-US'];
      logger.error(`Unexpected error: ${error.message || error}`);
      if (error.statusCode) {
        res.status(error.statusCode).json({ message: error.message || error });
      } else {
        res.status(500).json({
          message: formatMessage(messages.internalError, { error: error.message || error }),
        });
      }
    }
  });
}
