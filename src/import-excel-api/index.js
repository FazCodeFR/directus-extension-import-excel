import multer from 'multer';
import * as XLSX from 'xlsx';
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
        item.__rowIndex = rowIndex + 2;
        return item;
      }).filter(item => Object.keys(item).length > 1); // exclude empty rows

      if (items.length === 0) {
        logger.warn('No valid items found in Excel after mapping');
        return res.status(400).json({ message: messages.noValidItems });
      }

      const results = [];
      const errors = [];
      let createdCount = 0;
      let updatedCount = 0;

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

        for (const item of items) {
          const row = item.__rowIndex;
          const keyValue = item[keyField];

          try {
            if (existingMap.has(keyValue)) {
              const existing = existingMap.get(keyValue);
              await itemsService.updateOne(existing.id, item);
              results.push({ id: existing.id, action: 'updated', row });
              updatedCount++;
              logger.info(`Updated item id=${existing.id} (key=${keyValue}) at row ${row}`);
            } else {
              const newId = await itemsService.createOne(item);
              results.push({ id: newId, action: 'created', row });
              createdCount++;
              logger.info(`Created new item id=${newId} (key=${keyValue}) at row ${row}`);
            }
          } catch (error) {
            const detail =
              error?.errors?.map((e) => `${e.message} (champ "${e.path}")`).join('; ') ||
              error?.message ||
              'Validation failed';
            logger.error(`Error at row ${row} (key=${keyValue}): ${detail}`);
            errors.push({
              row,
              key: keyValue,
              error: detail,
            });
          }
        }
      } else {
        for (const item of items) {
          const row = item.__rowIndex;
          try {
            const newId = await itemsService.createOne(item);
            results.push({ id: newId, action: 'created', row });
            createdCount++;
            logger.info(`Created new item id=${newId} at row ${row}`);
          } catch (error) {
            const detail =
              error?.errors?.map((e) => `${e.message} (champ "${e.path}")`).join('; ') ||
              error?.message ||
              'Validation failed';
            logger.error(`Error creating item at row ${row}: ${detail}`);
            errors.push({
              row,
              error: detail,
            });
          }
        }
      }

      return res.status(errors.length > 0 ? 207 : 200).json({
        message: formatMessage(messages.processedItems, {
          count: results.length + errors.length,
          created: createdCount,
          updated: updatedCount,
        }),
        created: createdCount,
        updated: updatedCount,
        success: results,
        failed: errors,
      });

    } catch (error) {
      const lang = (req.headers['accept-language'] || 'en-US').split(',')[0];
      const messages = backendMessages[lang] || backendMessages['en-US'];
      const detail =
        error?.errors?.map((e) => `${e.message} (champ "${e.path}")`).join('; ') ||
        error?.message || error || 'Internal error';

      logger.error(`Unexpected error: ${detail}`);

      return res.status(error.statusCode || 500).json({
        message: formatMessage(messages.internalError, { error: detail }),
      });
    }
  });
}
