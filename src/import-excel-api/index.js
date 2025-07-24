import multer from 'multer';
import * as XLSX from 'xlsx';
import { createError } from '@directus/errors';
import { backendMessages } from '../shared/i18nApi.js'; // chemin selon ton projet

// Petite fonction utilitaire de remplacement dans les messages
function formatMessage(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, key) => params[key] || '');
}

export default function registerEndpoint(router, { services, getSchema }) {
  const { ItemsService } = services;

  const storage = multer.memoryStorage();
  const upload = multer({ storage });

  router.post('/', upload.single('file'), async (req, res) => {
    try {
      // Récupérer la langue (header Accept-Language ou défaut en-US)
      const lang = (req.headers['accept-language'] || 'en-US').split(',')[0];
      const messages = backendMessages[lang] || backendMessages['en-US'];

      if (!req.file) {
        return res.status(400).json({ message: messages.missingFile });
      }

      if (!req.body.collection) {
        return res.status(400).json({ message: messages.missingCollection });
      }
      
      if (!req.body.mapping) {
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
        return res.status(400).json({ message: messages.emptyFile });
      }

      const items = rows.map(row => {
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
        return item;
      }).filter(item => Object.keys(item).length > 0);

     if (items.length === 0) {
        return res.status(400).json({ message: messages.noValidItems });
      }


      if (keyField) {
        const missingKey = items.find(item => !(keyField in item));
        if (missingKey) {
          return res.status(400).json({ message: formatMessage(messages.missingKeyForUpsert, { keyField }) });
        }

        const keyValues = [...new Set(items.map(item => item[keyField]))];

        const existingItems = await itemsService.readByQuery({
          filter: {
            [keyField]: { _in: keyValues }
          },
          limit: keyValues.length
        });

        const existingMap = new Map(existingItems.map(item => [item[keyField], item]));

        const results = [];
        let createdCount = 0;
        let updatedCount = 0;

        for (const item of items) {
          const keyValue = item[keyField];
          const existing = existingMap.get(keyValue);

          if (existing) {
            await itemsService.updateOne(existing.id, item);
            results.push({ id: existing.id, action: 'updated' });
            updatedCount++;
          } else {
            const newId = await itemsService.createOne(item);
            results.push({ id: newId, action: 'created' });
            createdCount++;
          }
        }
        res.json({
          message: formatMessage(messages.processedItems, {
            count: Number(results.length) || 0,
            created: Number(createdCount) || 0,
            updated: Number(updatedCount) || 0,
          }),
          data: results,
        });
      } else {
        const createdIds = await itemsService.createMany(items);
        res.json({
          message: formatMessage(messages.itemsCreated, { count: createdIds.length }),
          data: createdIds.map(id => ({ id, action: 'created' })),
        });
      }
    } catch (error) {
      const lang = (req.headers['accept-language'] || 'en-US').split(',')[0];
      const messages = backendMessages[lang] || backendMessages['en-US'];
      if (error.statusCode) {
        res.status(error.statusCode).json({ message: error });
      } else {
        res.status(500).json({
          message: formatMessage(messages.internalError, { error: error }),
        });
      }
    }
  });
}
